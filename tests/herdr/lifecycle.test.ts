import { afterEach, describe, expect, jest, mock, test } from "bun:test";
import type { CallerContext } from "../../src/herdr/context";
import { subscribeLifecycle } from "../../src/herdr/lifecycle";
import type {
	EventStream,
	EventStreamHandlers,
	EventStreamOpener,
} from "../../src/herdr/transport";

/**
 * Mocked held-open event stream (the events.subscribe connection — the sole
 * streaming exception to one-request-per-connection). Wire shapes mirror the
 * observed Herdr protocol (V-HDR-2/3/4):
 *   request : {"id","method":"events.subscribe","params":{"subscriptions":[{"type":…}]}}
 *   ack     : {"id", "result":{"type":"subscription_started", …}}
 *   events  : {"event":"tab.closed","data":{…}}  (data carries a snake_case
 *             `type` discriminator like "pane_moved"; keys are snake_case)
 *   loss    : {"id","error":{"code":"events_lost","message":…}} then the server
 *             closes the connection.
 */

const CTX: CallerContext = {
	workspaceId: "w1",
	tabId: "t1",
	paneId: "p1",
	binPath: "/usr/local/bin/herdr",
	socketPath: "/tmp/herdr-test.sock",
};

const SIX_LIFECYCLE_SUBSCRIPTIONS = [
	{ type: "tab.closed" },
	{ type: "pane.closed" },
	{ type: "pane.exited" },
	{ type: "pane.moved" },
	{ type: "workspace.closed" },
	{ type: "layout.updated" },
];

const EVENTS_LOST = { id: "sub", error: { code: "events_lost", message: "event history overrun" } };
const SUBSCRIPTION_STARTED = { id: "sub", result: { type: "subscription_started" } };

class MockStream implements EventStream {
	readonly socketPath = CTX.socketPath;
	closed = false;

	constructor(private readonly handlers: EventStreamHandlers) {}

	/** Server → client pushed line (already JSON-decoded). */
	push(frame: unknown): void {
		if (!this.closed) this.handlers.onFrame(frame);
	}

	/** Server closed its side of the connection. */
	serverClose(): void {
		if (!this.closed) {
			this.closed = true;
			this.handlers.onClosed();
		}
	}

	close(): void {
		if (!this.closed) {
			this.closed = true;
			this.handlers.onClosed();
		}
	}
}

interface OpenedStream {
	method: string;
	params: unknown;
	stream: MockStream;
}

function harness(): { opened: OpenedStream[]; openStream: EventStreamOpener } {
	const opened: OpenedStream[] = [];
	const openStream: EventStreamOpener = (_socketPath, method, params, handlers) => {
		const stream = new MockStream(handlers);
		opened.push({ method, params, stream });
		return Promise.resolve(stream);
	};
	return { opened, openStream };
}

/** Index access under noUncheckedIndexedAccess: fails loudly when absent. */
function openedAt(opened: OpenedStream[], i: number): OpenedStream {
	const entry = opened[i];
	if (entry === undefined) throw new Error(`expected stream #${i} to have been opened`);
	return entry;
}

/** Microtask drain: lets the async resubscribe chain settle without timers. */
async function drain(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Deterministic wait for an observable condition (microtask polling). */
async function until(cond: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !cond(); i++) await Promise.resolve();
	if (!cond()) throw new Error("condition not reached after microtask drain");
}

afterEach(() => {
	jest.useRealTimers();
});

describe("subscribeLifecycle", () => {
	test("sends events.subscribe with the six session-wide lifecycle types", async () => {
		const { opened, openStream } = harness();
		await subscribeLifecycle(CTX, {}, openStream);
		expect(opened).toHaveLength(1);
		expect(openedAt(opened, 0).method).toBe("events.subscribe");
		expect(openedAt(opened, 0).params).toEqual({ subscriptions: SIX_LIFECYCLE_SUBSCRIPTIONS });
	});

	test("dispatches every lifecycle event type to its handler", async () => {
		const handlers = {
			onTabClosed: mock(() => {}),
			onPaneClosed: mock(() => {}),
			onPaneExited: mock(() => {}),
			onPaneMoved: mock(() => {}),
			onWorkspaceClosed: mock(() => {}),
			onLayoutUpdated: mock(() => {}),
		};
		const { opened, openStream } = harness();
		await subscribeLifecycle(CTX, handlers, openStream);
		const s = openedAt(opened, 0).stream;

		s.push({ event: "tab.closed", data: { type: "tab_closed", workspace_id: "w9", tab_id: "t9" } });
		s.push({ event: "pane.closed", data: { workspace_id: "w9", pane_id: "p9" } });
		s.push({ event: "pane.exited", data: { workspace_id: "w9", pane_id: "p8" } });
		s.push({
			event: "pane.moved",
			data: {
				type: "pane_moved",
				previous_pane_id: "p1",
				previous_workspace_id: "w1",
				previous_tab_id: "t1",
				pane: { pane_id: "p2", tab_id: "t2", workspace_id: "w2", title: "view", agent: "claude" },
			},
		});
		s.push({ event: "workspace.closed", data: { workspace_id: "w9" } });
		s.push({ event: "layout.updated", data: { type: "layout_updated", layout: { tab_id: "t7" } } });

		expect(handlers.onTabClosed).toHaveBeenCalledTimes(1);
		expect(handlers.onTabClosed).toHaveBeenCalledWith({ workspaceId: "w9", tabId: "t9" });
		expect(handlers.onPaneClosed).toHaveBeenCalledWith({ workspaceId: "w9", paneId: "p9" });
		expect(handlers.onPaneExited).toHaveBeenCalledWith({ workspaceId: "w9", paneId: "p8" });
		expect(handlers.onPaneMoved).toHaveBeenCalledWith({
			previousPaneId: "p1",
			previousWorkspaceId: "w1",
			previousTabId: "t1",
			pane: { paneId: "p2", tabId: "t2", workspaceId: "w2", title: "view", agent: "claude" },
		});
		expect(handlers.onWorkspaceClosed).toHaveBeenCalledWith({ workspaceId: "w9" });
		expect(handlers.onLayoutUpdated).toHaveBeenCalledWith({ tabId: "t7" });
	});

	test("tolerates nested {event:{event,data}} envelope and underscore event kinds", async () => {
		const onTabClosed = mock(() => {});
		const { opened, openStream } = harness();
		await subscribeLifecycle(CTX, { onTabClosed }, openStream);
		openedAt(opened, 0).stream.push({
			event: { event: "tab.closed", data: { workspace_id: "w9", tab_id: "t9" } },
		});
		openedAt(opened, 0).stream.push({
			event: "tab_closed",
			data: { workspace_id: "w8", tab_id: "t8" },
		});
		expect(onTabClosed).toHaveBeenCalledTimes(2);
		expect(onTabClosed).toHaveBeenLastCalledWith({ workspaceId: "w8", tabId: "t8" });
	});

	test("events_lost resubscribes, waits subscription_started, then calls onEventsLost once", async () => {
		const onEventsLost = mock(() => {});
		const onWorkspaceClosed = mock(() => {});
		const { opened, openStream } = harness();
		await subscribeLifecycle(CTX, { onEventsLost, onWorkspaceClosed }, openStream);

		openedAt(opened, 0).stream.push(EVENTS_LOST);
		await until(() => opened.length === 2);

		expect(openedAt(opened, 1).method).toBe("events.subscribe");
		expect(openedAt(opened, 1).params).toEqual({ subscriptions: SIX_LIFECYCLE_SUBSCRIPTIONS });
		expect(openedAt(opened, 0).stream.closed).toBe(true); // old stream torn down, no double subscription
		expect(onEventsLost).not.toHaveBeenCalled(); // still waiting subscription_started

		openedAt(opened, 1).stream.push(SUBSCRIPTION_STARTED);
		await drain();
		expect(onEventsLost).toHaveBeenCalledTimes(1);

		// the recovered stream is live again
		openedAt(opened, 1).stream.push({ event: "workspace.closed", data: { workspace_id: "w9" } });
		expect(onWorkspaceClosed).toHaveBeenCalledWith({ workspaceId: "w9" });
	});

	test("multiple events_lost frames before the ack yield a single resubscribe and one onEventsLost", async () => {
		const onEventsLost = mock(() => {});
		const { opened, openStream } = harness();
		await subscribeLifecycle(CTX, { onEventsLost }, openStream);

		openedAt(opened, 0).stream.push(EVENTS_LOST);
		openedAt(opened, 0).stream.push(EVENTS_LOST);
		await until(() => opened.length === 2);

		openedAt(opened, 1).stream.push(SUBSCRIPTION_STARTED);
		await drain();
		expect(onEventsLost).toHaveBeenCalledTimes(1);
	});

	test("events queued on the dead stream during recovery are dropped", async () => {
		const onTabClosed = mock(() => {});
		const { opened, openStream } = harness();
		await subscribeLifecycle(CTX, { onTabClosed }, openStream);

		openedAt(opened, 0).stream.push(EVENTS_LOST);
		openedAt(opened, 0).stream.push({
			event: "tab.closed",
			data: { workspace_id: "w9", tab_id: "t9" },
		});
		await until(() => opened.length === 2);
		openedAt(opened, 1).stream.push(SUBSCRIPTION_STARTED);
		await drain();

		expect(onTabClosed).not.toHaveBeenCalled();
	});

	test("unexpected server close resubscribes and reports events lost once", async () => {
		const onEventsLost = mock(() => {});
		const { opened, openStream } = harness();
		await subscribeLifecycle(CTX, { onEventsLost }, openStream);

		openedAt(opened, 0).stream.serverClose();
		await until(() => opened.length === 2);
		openedAt(opened, 1).stream.push(SUBSCRIPTION_STARTED);
		await drain();
		expect(onEventsLost).toHaveBeenCalledTimes(1);
	});

	test("missing subscription_started does not hang: onEventsLost still fires once (bounded)", async () => {
		jest.useFakeTimers();
		const onEventsLost = mock(() => {});
		const { opened, openStream } = harness();
		await subscribeLifecycle(CTX, { onEventsLost }, openStream, { resubscribeMs: 25 });

		openedAt(opened, 0).stream.push(EVENTS_LOST);
		await until(() => opened.length === 2);
		expect(onEventsLost).not.toHaveBeenCalled();

		jest.advanceTimersByTime(30); // resubscribeMs ack timeout elapses
		await drain();
		expect(onEventsLost).toHaveBeenCalledTimes(1);

		// a late ack must not fire the hook a second time
		openedAt(opened, 1).stream.push(SUBSCRIPTION_STARTED);
		await drain();
		expect(onEventsLost).toHaveBeenCalledTimes(1);
	});

	test("close() ends the subscription: stream closed, no dispatch, no recovery", async () => {
		const onTabClosed = mock(() => {});
		const onEventsLost = mock(() => {});
		const { opened, openStream } = harness();
		const sub = await subscribeLifecycle(CTX, { onTabClosed, onEventsLost }, openStream);

		await sub.close();
		expect(openedAt(opened, 0).stream.closed).toBe(true);

		openedAt(opened, 0).stream.serverClose(); // already closed → no frame delivery anyway
		openedAt(opened, 0).stream.push({
			event: "tab.closed",
			data: { workspace_id: "w9", tab_id: "t9" },
		});
		await drain();

		expect(onTabClosed).not.toHaveBeenCalled();
		expect(onEventsLost).not.toHaveBeenCalled();
		expect(opened).toHaveLength(1); // no resubscribe after close
	});
});
