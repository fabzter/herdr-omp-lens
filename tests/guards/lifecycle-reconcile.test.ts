import { describe, expect, test } from "bun:test";
import {
	createTopologyManager,
	OVERVIEW_TAB_LABEL,
	type TopologyAdapter,
} from "../../src/extension/topology";
import type { CallerContext } from "../../src/herdr/context";
import { subscribeLifecycle } from "../../src/herdr/lifecycle";
import type {
	EventStream,
	EventStreamHandlers,
	EventStreamOpener,
} from "../../src/herdr/transport";
import type {
	LifecycleHandlers,
	PaneInfo,
	PaneMetadata,
	SessionSnapshot,
} from "../../src/herdr/types";
import type { Message } from "../../src/protocol/types";

/**
 * P6-R4 ordered-mock suite (V-HDR-4, R-07, F-12): the lifecycle subscription
 * is established before any tab.create; viewer liveness is always confirmed
 * by an authoritative getPane/snapshot read (never purely event-derived);
 * pane.moved rewrites stored ids; and a simulated events_lost ends with
 * exactly ONE live subscription — P1's transparent resubscribe waits
 * subscription_started itself, then the onEventsLost hook drives P4's
 * snapshot() reconcile of owned ids — never a double subscription and never
 * a duplicate viewer.
 *
 * Unlike tests/extension/topology-herdr.test.ts (which stubs the whole
 * adapter), this suite wires the REAL subscribeLifecycle into the mock
 * adapter through its openStream seam, so the resubscribe path under test is
 * the production code path — including the wire-level events_lost frame.
 */

const CTX: CallerContext = {
	workspaceId: "w1",
	tabId: "w1:t1",
	paneId: "w1:p1",
	binPath: "/bin/herdr",
	socketPath: "/tmp/herdr-lens-test.sock",
};

const BRIDGE = "/bridge/session.sock";
const VIEWER_CMD = "bun /pkg/src/viewer/cli.ts";
const SESSION = "omp-session-p6r4";

// Wire frames (shapes mirror tests/herdr/lifecycle.test.ts).
const EVENTS_LOST = { id: "sub", error: { code: "events_lost", message: "event history overrun" } };
const SUBSCRIPTION_STARTED = { id: "sub", result: { type: "subscription_started" } };

interface RecordedCall {
	method: string;
	args: unknown[];
}

/** Held-open events.subscribe stream; wire shapes mirror lifecycle.test.ts. */
class MockStream implements EventStream {
	readonly socketPath = CTX.socketPath;
	closed = false;

	constructor(private readonly handlers: EventStreamHandlers) {}

	push(frame: unknown): void {
		if (!this.closed) this.handlers.onFrame(frame);
	}

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
	stream: MockStream;
}

/** Held-open first subscription when gateFirstOpen is set. */
interface OpenGate {
	promise: Promise<EventStream>;
	resolve(stream: EventStream): void;
	reject(reason?: unknown): void;
}
/** Ordered-mock adapter surface returned by mockLifecycleAdapter. */
interface LifecycleMock {
	adapter: TopologyAdapter;
	/** Every adapter call plus every wire-level events.subscribe open, in order. */
	calls: RecordedCall[];
	/** Authoritative pane set the snapshot/getPane reads answer from. */
	panes: Map<string, PaneInfo>;
	/** Streams whose open resolved (gated opens appear only once resolved). */
	opened: OpenedStream[];
	/** Held-open first subscription when gateFirstOpen is set. */
	pendingOpens: OpenGate[];
	methods(): string[];
	count(method: string): number;
	/** Manager-facing subscribeLifecycle calls (never the wire-level resubscribe). */
	readonly subCalls: number;
	/** Manager-held subscriptions not yet closed (the "exactly one" invariant). */
	readonly liveSubs: number;
	/** Streams the server still has open (the "no double subscription" invariant). */
	liveStreams(): number;
}

function openedAt(opened: OpenedStream[], i: number): OpenedStream {
	const entry = opened[i];
	if (entry === undefined) throw new Error(`expected stream #${i} to have been opened`);
	return entry;
}

/** Microtask drain — no wall-clock. */
async function drain(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Deterministic wait for an observable condition (microtask polling). */
async function until(cond: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !cond(); i++) await Promise.resolve();
	if (!cond()) throw new Error("condition not reached after microtask drain");
}

async function settle(manager: { settle?(): Promise<void> }): Promise<void> {
	if (manager.settle) await manager.settle();
}

/**
 * Ordered-mock adapter: records every call, keeps an authoritative pane set,
 * and — unlike the stub in topology-herdr.test.ts — delegates
 * subscribeLifecycle to the REAL P1 function through the openStream seam.
 * `gateFirstOpen` holds the first events.subscribe open pending so tests can
 * prove nothing downstream runs before the subscription resolves.
 */
function mockLifecycleAdapter(opts: { gateFirstOpen?: boolean } = {}): LifecycleMock {
	const calls: RecordedCall[] = [];
	const panes = new Map<string, PaneInfo>();
	const opened: OpenedStream[] = [];
	const pendingOpens: OpenGate[] = [];
	let tabCounter = 0;
	let paneCounter = 0;
	let subCalls = 0;
	let liveSubs = 0;
	let gated = false;

	const openStream: EventStreamOpener = (_path, _method, params, handlers) => {
		calls.push({ method: "events.subscribe", args: [params] });
		const stream = new MockStream(handlers);
		if (opts.gateFirstOpen === true && !gated) {
			// Resolve later, but hand the REAL stream back — handlers stay live so
			// frames pushed after the gate opens still dispatch.
			gated = true;
			const gate = Promise.withResolvers<EventStream>();
			pendingOpens.push(gate);
			void gate.promise.then(() => opened.push({ stream }));
			return gate.promise.then(() => stream);
		}
		opened.push({ stream });
		return Promise.resolve(stream);
	};

	const adapter: TopologyAdapter = {
		async subscribeLifecycle(h: LifecycleHandlers) {
			calls.push({ method: "subscribeLifecycle", args: [] });
			subCalls += 1;
			liveSubs += 1;
			const inner = await subscribeLifecycle(CTX, h, openStream);
			return {
				async close() {
					liveSubs -= 1;
					await inner.close();
				},
			};
		},
		async createOverviewTab(label: string, env?: Record<string, string>) {
			calls.push({ method: "createOverviewTab", args: [label, env] });
			tabCounter += 1;
			paneCounter += 1;
			const tabId = `tab-${tabCounter}`;
			const rootPaneId = `pane-${paneCounter}`;
			panes.set(rootPaneId, {
				paneId: rootPaneId,
				tabId,
				workspaceId: CTX.workspaceId,
				title: label,
			});
			return { tabId, rootPaneId };
		},
		async splitPane(targetPaneId: string, dir: "right" | "down", env?: Record<string, string>) {
			calls.push({ method: "splitPane", args: [targetPaneId, dir, env] });
			paneCounter += 1;
			const paneId = `pane-${paneCounter}`;
			const target = panes.get(targetPaneId);
			panes.set(paneId, {
				paneId,
				tabId: target?.tabId ?? "tab-?",
				workspaceId: CTX.workspaceId,
			});
			return { paneId };
		},
		async runInPane(paneId: string, command: string) {
			calls.push({ method: "runInPane", args: [paneId, command] });
		},
		async getPane(paneId: string) {
			calls.push({ method: "getPane", args: [paneId] });
			return panes.get(paneId) ?? null;
		},
		async snapshot(): Promise<SessionSnapshot> {
			calls.push({ method: "snapshot", args: [] });
			return { workspaces: [], tabs: [], panes: [...panes.values()] };
		},
		async reportMetadata(paneId: string, meta: PaneMetadata) {
			calls.push({ method: "reportMetadata", args: [paneId, meta] });
		},
	};

	return {
		adapter,
		calls,
		panes,
		opened,
		pendingOpens,
		methods() {
			return calls.map((c) => c.method);
		},
		count(method: string) {
			return calls.filter((c) => c.method === method).length;
		},
		get subCalls() {
			return subCalls;
		},
		get liveSubs() {
			return liveSubs;
		},
		liveStreams() {
			return opened.filter((o) => !o.stream.closed).length;
		},
	};
}

function make(m: LifecycleMock) {
	const messages: Message[] = [];
	const manager = createTopologyManager(CTX, VIEWER_CMD, BRIDGE, (msg) => messages.push(msg), {
		sessionId: SESSION,
		adapter: m.adapter,
	});
	return { manager, messages };
}

describe("P6-R4 — subscribe-before-create + events_lost reconcile", () => {
	test("subscribeLifecycle resolves before any snapshot or tab.create (P4-R1/R4)", async () => {
		// The first events.subscribe open is held pending: a create fired while
		// the subscription is still unresolved would prove the order is violated.
		const m = mockLifecycleAdapter({ gateFirstOpen: true });
		const { manager } = make(m);

		const spawned = manager.onWorkerSpawned();
		await drain();

		expect(m.count("subscribeLifecycle")).toBe(1);
		expect(m.count("createOverviewTab")).toBe(0);
		expect(m.count("snapshot")).toBe(0);

		const gate = m.pendingOpens[0];
		if (gate === undefined) throw new Error("expected the first stream open to be gated");
		gate.resolve(new MockStream({ onFrame: () => {}, onClosed: () => {} }));
		await spawned;

		const order = m.methods();
		const sub = order.indexOf("subscribeLifecycle");
		const snap = order.indexOf("snapshot");
		const create = order.indexOf("createOverviewTab");
		expect(sub).toBeGreaterThanOrEqual(0);
		expect(sub).toBeLessThan(snap);
		expect(snap).toBeLessThan(create);
		expect(manager.state()).toBe("open");
		await manager.stop();
	});

	test("closed events are hints: state clears only after an authoritative snapshot miss (V-HDR-3)", async () => {
		const m = mockLifecycleAdapter();
		const { manager } = make(m);
		await manager.onWorkerSpawned();
		const stream = openedAt(m.opened, 0).stream;

		// pane.closed on the overview pane, but the pane is still present:
		// the hint is confirmed against snapshot() and the view stays open.
		const snapBefore = m.count("snapshot");
		stream.push({
			event: "pane.closed",
			data: { workspace_id: CTX.workspaceId, pane_id: "pane-1" },
		});
		await settle(manager);
		expect(m.count("snapshot")).toBeGreaterThan(snapBefore); // confirm read ran
		expect(manager.state()).toBe("open");

		// Now the pane is really gone: same hint + authoritative miss → closed.
		m.panes.delete("pane-1");
		stream.push({
			event: "tab.closed",
			data: { workspace_id: CTX.workspaceId, tab_id: "tab-1" },
		});
		await until(() => manager.state() === "closed");
		await settle(manager);
		expect(manager.state()).toBe("closed");
		await manager.stop();
	});

	test("split liveness is confirmed via getPane before reuse — never event-derived", async () => {
		const m = mockLifecycleAdapter();
		const { manager } = make(m);
		await manager.onWorkerSpawned();
		const first = await manager.openWorkerSplit("w-1");
		expect(m.count("splitPane")).toBe(1);

		const second = await manager.openWorkerSplit("w-1");
		expect(second.paneId).toBe(first.paneId);
		expect(m.count("splitPane")).toBe(1); // reused, not duplicated
		const gets = m.calls.filter((c) => c.method === "getPane" && c.args[0] === first.paneId);
		expect(gets.length).toBeGreaterThanOrEqual(1); // authoritative read ran
		await manager.stop();
	});

	test("pane.moved rewrites stored overview ids; a later close matches only the new ids (V-HDR-3)", async () => {
		const m = mockLifecycleAdapter();
		const { manager } = make(m);
		await manager.onWorkerSpawned();
		const stream = openedAt(m.opened, 0).stream;

		// Server moves pane-1 into a new tab as pane-9.
		m.panes.delete("pane-1");
		m.panes.set("pane-9", {
			paneId: "pane-9",
			tabId: "tab-9",
			workspaceId: CTX.workspaceId,
			title: OVERVIEW_TAB_LABEL,
		});
		stream.push({
			event: "pane.moved",
			data: {
				previous_pane_id: "pane-1",
				previous_workspace_id: CTX.workspaceId,
				previous_tab_id: "tab-1",
				pane: { pane_id: "pane-9", tab_id: "tab-9", workspace_id: CTX.workspaceId },
			},
		});
		await settle(manager);

		// A close on the OLD tab id must not match anymore — stored ids moved.
		stream.push({
			event: "tab.closed",
			data: { workspace_id: CTX.workspaceId, tab_id: "tab-1" },
		});
		await settle(manager);
		expect(manager.state()).toBe("open");

		// Close on the NEW ids: hint + authoritative miss → closed.
		m.panes.delete("pane-9");
		stream.push({
			event: "tab.closed",
			data: { workspace_id: CTX.workspaceId, tab_id: "tab-9" },
		});
		await until(() => manager.state() === "closed");
		expect(manager.state()).toBe("closed");
		await manager.stop();
	});

	test("pane.moved rewrites the worker split binding so a later pane.closed hits the new id", async () => {
		const m = mockLifecycleAdapter();
		const { manager } = make(m);
		await manager.onWorkerSpawned();
		const split = await manager.openWorkerSplit("w-1"); // pane-2
		const stream = openedAt(m.opened, 0).stream;

		// Move the split pane-2 → pane-8 (same tab).
		m.panes.delete("pane-2");
		m.panes.set("pane-8", {
			paneId: "pane-8",
			tabId: "tab-1",
			workspaceId: CTX.workspaceId,
		});
		stream.push({
			event: "pane.moved",
			data: {
				previous_pane_id: split.paneId,
				previous_workspace_id: CTX.workspaceId,
				previous_tab_id: "tab-1",
				pane: { pane_id: "pane-8", tab_id: "tab-1", workspace_id: CTX.workspaceId },
			},
		});
		await settle(manager);

		// Reuse must hit the NEW id through getPane — proof the binding moved.
		const reuse = await manager.openWorkerSplit("w-1");
		expect(reuse.paneId).toBe("pane-8");
		expect(m.count("splitPane")).toBe(1);
		const gets = m.calls.filter((c) => c.method === "getPane" && c.args[0] === "pane-8");
		expect(gets.length).toBeGreaterThanOrEqual(1);
		await manager.stop();
	});

	test("events_lost: exactly one live subscription, transparent resubscribe, snapshot reconcile, no duplicate viewer", async () => {
		const m = mockLifecycleAdapter();
		const { manager, messages } = make(m);
		await manager.onWorkerSpawned();
		await manager.openWorkerSplit("w-1"); // pane-2 tracked in the roster
		expect(m.subCalls).toBe(1);
		expect(m.liveSubs).toBe(1);
		expect(m.opened).toHaveLength(1);

		// Blind window: the split pane dies while the stream cannot see it.
		m.panes.delete("pane-2");

		// Server reports the loss twice before the ack (the dying stream keeps
		// erroring): P1 owns ONE resubscribe — the manager-facing
		// subscribeLifecycle must never be called a second time and no third
		// stream may appear.
		const snapBefore = m.count("snapshot");
		openedAt(m.opened, 0).stream.push(EVENTS_LOST);
		openedAt(m.opened, 0).stream.push(EVENTS_LOST);
		await until(() => m.opened.length === 2);
		expect(m.opened).toHaveLength(2); // single-flighted resubscribe — never a third stream
		expect(openedAt(m.opened, 0).stream.closed).toBe(true); // old stream torn down first
		expect(m.count("events.subscribe")).toBe(2);
		expect(m.subCalls).toBe(1); // P4 did not resubscribe itself (F-12)

		// The ack gates the hook: even after the microtask queue drains, no
		// reconcile may run before subscription_started.
		await drain();
		expect(m.count("snapshot")).toBe(snapBefore);
		openedAt(m.opened, 1).stream.push(SUBSCRIPTION_STARTED);
		await until(() => m.count("snapshot") > snapBefore);
		await settle(manager);

		// Reconciled roster: dead split dropped, overview still open, no new tab.
		expect(manager.state()).toBe("open");
		expect(m.count("createOverviewTab")).toBe(1);
		const lastOpen = [...messages]
			.reverse()
			.find(
				(msg): msg is Extract<Message, { type: "topology" }> =>
					msg.type === "topology" && msg.state === "open",
			);
		expect(lastOpen?.paneIds).toEqual(["pane-1"]); // pane-2 pruned by reconcileOwned
		expect(m.liveSubs).toBe(1);
		expect(m.liveStreams()).toBe(1); // exactly one live subscription — never two

		// The rebound stream is live: a fresh hint on the overview confirms → closed.
		m.panes.delete("pane-1");
		openedAt(m.opened, 1).stream.push({
			event: "pane.closed",
			data: { workspace_id: CTX.workspaceId, pane_id: "pane-1" },
		});
		await until(() => manager.state() === "closed");
		expect(manager.state()).toBe("closed");
		await manager.stop();
		expect(m.liveSubs).toBe(0);
	});
});
