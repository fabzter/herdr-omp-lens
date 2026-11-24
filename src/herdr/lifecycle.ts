/**
 * Session-wide lifecycle subscription (P1-R6, V-HDR-2..4, F-12/RC-13).
 *
 * Opens ONE held-open events.subscribe connection (the sole streaming
 * exception to the transport's one-request-per-connection rule) for the six
 * close/move/exit types, then dispatches pushed events to LifecycleHandlers.
 *
 * events_lost recovery is owned here and transparent to the caller: on an
 * {"error":{"code":"events_lost"}} frame (or an unexpected close — same data
 * loss risk) the dead stream is torn down, a second events.subscribe is sent,
 * subscription_started is awaited with a bounded timeout, and onEventsLost is
 * invoked exactly once so the caller can reconcile via authoritative reads.
 * Events queued on the dead stream during recovery are dropped; the caller's
 * snapshot() reconcile is what restores truth — never replayed payloads.
 *
 * "Bounded": the only wait inside recovery is the resubscribeMs-bounded
 * subscription_started wait; nothing here can hang a turn.
 */

import type { CallerContext } from "./context";
import { assertAllowedRequest } from "./guards";
import {
	type EventStream,
	type EventStreamHandlers,
	type EventStreamOpener,
	socketEventStream,
} from "./transport";
import type { LifecycleHandlers, PaneInfo, Subscription } from "./types";

/** Session-wide lifecycle subscription set (V-HDR-2); entries take no params. */
const LIFECYCLE_SUBSCRIPTIONS = [
	{ type: "tab.closed" },
	{ type: "pane.closed" },
	{ type: "pane.exited" },
	{ type: "pane.moved" },
	{ type: "workspace.closed" },
	{ type: "layout.updated" },
] as const;

const EVENTS_SUBSCRIBE_PARAMS = { subscriptions: [...LIFECYCLE_SUBSCRIPTIONS] };

/** Default bound on the subscription_started wait during events_lost recovery. */
const DEFAULT_RESUBSCRIBE_MS = 5000;

export interface SubscribeLifecycleOptions {
	/** Max wait for subscription_started after a resubscribe (default 5000ms). */
	resubscribeMs?: number;
}

type Frame = Record<string, unknown>;

function asRecord(value: unknown): Frame | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Frame)
		: null;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Snake-case wire PaneInfo (panes.rs) → adapter camelCase PaneInfo. */
function mapPaneInfo(wire: Frame): PaneInfo | null {
	const paneId = str(wire.pane_id);
	const tabId = str(wire.tab_id);
	const workspaceId = str(wire.workspace_id);
	if (paneId === undefined || tabId === undefined || workspaceId === undefined) return null;
	const pane: PaneInfo = { paneId, tabId, workspaceId };
	const title = str(wire.title);
	if (title !== undefined) pane.title = title;
	const agent = str(wire.agent);
	if (agent !== undefined) pane.agent = agent;
	return pane;
}

/**
 * Event-kind normalization mirrors the protocol's own stream parser
 * (herdr_protocol/events.rs): the kind may arrive dotted ("tab.closed") or
 * snake ("tab_closed"); a missing dot means the first "_" separates the group.
 */
function normalizeKind(raw: string): string {
	if (raw.includes(".")) return raw;
	return raw.replace("_", ".");
}

function dispatch(kind: string, data: Frame | null, h: LifecycleHandlers): void {
	switch (normalizeKind(kind)) {
		case "tab.closed": {
			const workspaceId = str(data?.workspace_id);
			const tabId = str(data?.tab_id);
			if (workspaceId !== undefined && tabId !== undefined) {
				h.onTabClosed?.({ workspaceId, tabId });
			}
			return;
		}
		case "pane.closed": {
			const workspaceId = str(data?.workspace_id);
			const paneId = str(data?.pane_id);
			if (workspaceId !== undefined && paneId !== undefined) {
				h.onPaneClosed?.({ workspaceId, paneId });
			}
			return;
		}
		case "pane.exited": {
			const workspaceId = str(data?.workspace_id);
			const paneId = str(data?.pane_id);
			if (workspaceId !== undefined && paneId !== undefined) {
				h.onPaneExited?.({ workspaceId, paneId });
			}
			return;
		}
		case "pane.moved": {
			const previousPaneId = str(data?.previous_pane_id);
			const previousWorkspaceId = str(data?.previous_workspace_id);
			const previousTabId = str(data?.previous_tab_id);
			const paneWire = asRecord(data?.pane);
			const pane = paneWire !== null ? mapPaneInfo(paneWire) : null;
			if (
				previousPaneId !== undefined &&
				previousWorkspaceId !== undefined &&
				previousTabId !== undefined &&
				pane !== null
			) {
				h.onPaneMoved?.({ previousPaneId, previousWorkspaceId, previousTabId, pane });
			}
			return;
		}
		case "workspace.closed": {
			const workspaceId = str(data?.workspace_id);
			if (workspaceId !== undefined) h.onWorkspaceClosed?.({ workspaceId });
			return;
		}
		case "layout.updated": {
			// wire: data.layout.tab_id (PaneLayoutSnapshot); fall back to data.tab_id
			const layout = asRecord(data?.layout);
			const tabId = str(layout?.tab_id) ?? str(data?.tab_id);
			if (tabId !== undefined) h.onLayoutUpdated?.({ tabId });
			return;
		}
		default:
			return; // unknown/subscribed-elsewhere kind — ignore
	}
}

/**
 * Subscribe to the session-wide lifecycle events for this caller.
 *
 * Resolves once the events.subscribe connection is open (established
 * subscription); rejects only if the connection itself cannot be opened.
 * The optional `openStream` is the test seam — production passes the real
 * socket via socketEventStream(c.socketPath).
 */
export async function subscribeLifecycle(
	c: CallerContext,
	handlers: LifecycleHandlers,
	openStream: EventStreamOpener = socketEventStream(c.socketPath),
	options: SubscribeLifecycleOptions = {},
): Promise<Subscription> {
	const resubscribeMs = options.resubscribeMs ?? DEFAULT_RESUBSCRIBE_MS;
	// Same boundary as guardedRequest: events.subscribe must pass the denylist
	// too, so a future param/method change cannot sneak a forbidden call past it.
	assertAllowedRequest("events.subscribe", EVENTS_SUBSCRIBE_PARAMS);

	let closed = false;
	let stream: EventStream | null = null;
	let token: object | null = null; // handlers of a superseded stream no-op on stale token
	let recoverPromise: Promise<void> | null = null;
	let closedPromiseResolve: (() => void) | null = null;
	let ackResolve: (() => void) | null = null;
	let acked = false; // subscription_started on the CURRENT stream (cleared per resubscribe)

	function notifyLost(): void {
		try {
			handlers.onEventsLost?.();
		} catch {
			// a throwing reconcile hook must not take the stream down
		}
	}

	/** Bounded wait for subscription_started (or close/timeout — never hangs). */
	async function awaitAck(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(resolve, resubscribeMs);
		ackResolve = () => {
			clearTimeout(timer);
			resolve();
		};
		closedPromiseResolve = () => {
			clearTimeout(timer);
			resolve();
		};
		if (acked) {
			// ack already arrived between stream open and this wait — settle now
			clearTimeout(timer);
			ackResolve = null;
			closedPromiseResolve = null;
			return;
		}
		await promise;
		ackResolve = null;
		closedPromiseResolve = null;
	}

	function handleFrame(frame: unknown): void {
		const rec = asRecord(frame);
		if (rec === null) return;

		// {"id", "error":{code,message}} — terminal for this subscription
		const error = asRecord(rec.error);
		if (error !== null) {
			recover();
			return;
		}

		// {"id", "result":{type:"subscription_started",…}} — the subscribe ack
		const result = asRecord(rec.result);
		if (result !== null) {
			if (str(result.type) === "subscription_started") {
				acked = true;
				ackResolve?.();
			}
			return;
		}

		// pushed event: {"event":"tab.closed","data":{…}} or nested {"event":{"event":…,"data":…}}
		const event = rec.event;
		if (typeof event === "string") {
			dispatch(event, asRecord(rec.data), handlers);
			return;
		}
		const nested = asRecord(event);
		if (nested !== null) {
			const kind = str(nested.event);
			if (kind !== undefined) dispatch(kind, asRecord(nested.data), handlers);
		}
	}

	function streamHandlers(t: object): EventStreamHandlers {
		return {
			onFrame: (frame) => {
				if (closed || t !== token) return;
				handleFrame(frame);
			},
			onClosed: () => {
				if (closed || t !== token) return;
				token = null; // the stream that died is already superseded
				stream = null;
				recover();
			},
		};
	}

	/** Transparent resubscribe (F-12): single-flighted, bounded, never throws. */
	function recover(): void {
		if (closed || recoverPromise !== null) return;
		recoverPromise = (async () => {
			token = null; // invalidate the dead stream's handlers before closing it
			const old = stream;
			stream = null;
			old?.close();
			if (closed) return;

			const next = {} as object;
			try {
				const opened = await openStream(
					c.socketPath,
					"events.subscribe",
					EVENTS_SUBSCRIBE_PARAMS,
					streamHandlers(next),
				);
				if (closed) {
					opened.close();
					return;
				}
				acked = false;
				stream = opened;
				token = next;
			} catch {
				// resubscribe could not even open; report the loss once and stay dead
				// rather than spin on a broken socket. The caller's reconcile still
				// runs — cached state is stale either way (V-HDR-4).
				notifyLost();
				return;
			}
			await awaitAck(); // subscription_started, or bounded timeout
			if (!closed) notifyLost();
		})().finally(() => {
			recoverPromise = null;
		});
	}

	const first = {} as object;
	stream = await openStream(
		c.socketPath,
		"events.subscribe",
		EVENTS_SUBSCRIBE_PARAMS,
		streamHandlers(first),
	);
	token = first;

	return {
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			token = null;
			closedPromiseResolve?.(); // unblock an in-flight ack wait
			stream?.close();
			stream = null;
			await recoverPromise; // let an in-flight resubscribe finish; it exits on `closed`
		},
	};
}
