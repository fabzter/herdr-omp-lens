/**
 * P6-R2 invariant tamper suite (SDD §10 / F-15): one test per safety
 * invariant, each proven red by a deliberate sabotage — the sabotage
 * patches and their red output are recorded verbatim in
 * tests/guards/sabotage.md.
 *
 * Invariants covered:
 *  (a) worker survives viewer close (FR-14)
 *  (b) no duplicate worker spawned by any view operation (FR-14)
 *  (c) no focus theft across open/split/reopen (FR-13)
 *  (d) control.* frames rejected at the handshake boundary (FR-11)
 *  (e) extension is a complete no-op outside Herdr (FR-01)
 *  (f) OMP turn completes with Herdr/bridge dead (FR-12)
 *  (g) every pi.on / pi.events.on handler enqueues synchronously, never
 *      awaits I/O (F-15)
 */
import { afterEach, describe, expect, test } from "bun:test";
import lensExtension, { activeObservation, lensReady, stopLens } from "../../src/extension";
import type { LensContext, LensExtensionApi } from "../../src/extension/api";
import type { BridgeHandle } from "../../src/extension/bridge";
import { createHistoryStub } from "../../src/extension/history-stub";
import type { Roster } from "../../src/extension/roster";
import {
	createTopologyManager,
	OVERVIEW_TAB_LABEL,
	type TopologyAdapter,
	type TopologyManager,
} from "../../src/extension/topology";
import {
	createOverviewTab,
	getPane,
	reportMetadata,
	runInPane,
	snapshot,
	splitPane,
} from "../../src/herdr/adapter";
import type { CallerContext } from "../../src/herdr/context";
import { assertAllowedRequest, DENIED_METHODS } from "../../src/herdr/guards";
import type { HerdrTransport } from "../../src/herdr/transport";
import type {
	LifecycleHandlers,
	PaneInfo,
	PaneMetadata,
	SessionSnapshot,
	Subscription,
} from "../../src/herdr/types";
import { decodeClientMessage } from "../../src/protocol/codec";
import type { Message } from "../../src/protocol/types";

// --- env discipline (same pattern as tests/extension/gate.test.ts) ---------

const HERDR_VARS = [
	"HERDR_ENV",
	"HERDR_WORKSPACE_ID",
	"HERDR_TAB_ID",
	"HERDR_PANE_ID",
	"HERDR_BIN_PATH",
	"HERDR_SOCKET_PATH",
] as const;

const FULL_ENV: Record<(typeof HERDR_VARS)[number], string> = {
	HERDR_ENV: "1",
	HERDR_WORKSPACE_ID: "w1",
	HERDR_TAB_ID: "w1:t1",
	HERDR_PANE_ID: "w1:p1",
	HERDR_BIN_PATH: "/bin/herdr",
	HERDR_SOCKET_PATH: "/sock",
};

const savedEnv = new Map<string, string | undefined>();

function setEnv(vars: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(vars)) {
		if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

afterEach(async () => {
	await stopLens();
	for (const [key, original] of savedEnv) {
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
	}
	savedEnv.clear();
});

// --- fake pi: captures every registration so handlers stay invocable -------

interface FakePi {
	pi: LensExtensionApi;
	commands: Map<
		string,
		{ description: string; handler: (args: string, ctx?: LensContext) => void }
	>;
	hooks: Map<string, (event: unknown, ctx?: LensContext) => void>;
	bus: Map<string, (payload: unknown) => void>;
}

function fakePi(): FakePi {
	const commands: FakePi["commands"] = new Map();
	const hooks: FakePi["hooks"] = new Map();
	const bus: FakePi["bus"] = new Map();
	const pi: LensExtensionApi = {
		registerCommand(name, definition) {
			commands.set(name, { description: definition.description, handler: definition.handler });
		},
		on(event, handler) {
			hooks.set(event, handler);
		},
		off(event, handler) {
			if (hooks.get(event) === handler) hooks.delete(event);
		},
		events: {
			on(channel, handler) {
				bus.set(channel, handler);
			},
			off(channel, handler) {
				if (bus.get(channel) === handler) bus.delete(channel);
			},
		},
	};
	return { pi, commands, hooks, bus };
}

function lensCtx(sessionId: string): LensContext {
	return { sessionManager: { getSessionId: () => sessionId } };
}

// --- topology mock adapter (the topology.test.ts pattern) ------------------

interface RecordedTopoCall {
	method: string;
	args: unknown[];
}

const VIEWER_CMD = "bun /pkg/src/viewer/cli.ts";

function topoMockAdapter(): TopoMock {
	const calls: RecordedTopoCall[] = [];
	const panes = new Map<string, PaneInfo>();
	let handlers: LifecycleHandlers = {};
	let tabCounter = 0;
	let paneCounter = 0;

	const adapter: TopologyAdapter = {
		async createOverviewTab(label: string, env?: Record<string, string>) {
			calls.push({ method: "createOverviewTab", args: [label, env] });
			tabCounter += 1;
			paneCounter += 1;
			const tabId = `tab-${tabCounter}`;
			const rootPaneId = `pane-${paneCounter}`;
			panes.set(rootPaneId, { paneId: rootPaneId, tabId, workspaceId: "w1", title: label });
			return { tabId, rootPaneId };
		},
		async splitPane(targetPaneId: string, dir: "right" | "down", env?: Record<string, string>) {
			calls.push({ method: "splitPane", args: [targetPaneId, dir, env] });
			paneCounter += 1;
			const paneId = `pane-${paneCounter}`;
			const target = panes.get(targetPaneId);
			panes.set(paneId, { paneId, tabId: target?.tabId ?? "tab-?", workspaceId: "w1" });
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
		async subscribeLifecycle(h: LifecycleHandlers): Promise<Subscription> {
			calls.push({ method: "subscribeLifecycle", args: [] });
			handlers = h;
			return { async close() {} };
		},
		async reportMetadata(paneId: string, meta: PaneMetadata) {
			calls.push({ method: "reportMetadata", args: [paneId, meta] });
		},
	};

	return {
		adapter,
		calls,
		panes,
		get handlers() {
			return handlers;
		},
		count(method: string) {
			return calls.filter((c) => c.method === method).length;
		},
		/** Simulate the user closing a pane in Herdr: gone + lifecycle hint. */
		closePane(paneId: string) {
			panes.delete(paneId);
			handlers.onPaneClosed?.({ workspaceId: "w1", paneId });
		},
	};
}

interface TopoMock {
	adapter: TopologyAdapter;
	calls: RecordedTopoCall[];
	panes: Map<string, PaneInfo>;
	readonly handlers: LifecycleHandlers;
	count(method: string): number;
	/** Simulate the user closing a pane in Herdr: gone + lifecycle hint. */
	closePane(paneId: string): void;
}
// --- activation harness ----------------------------------------------------

interface Harness {
	pi: FakePi;
	sent: Message[];
	errors: unknown[];
	roster: () => Roster;
	topo: () => TopologyManager;
	adapterMock: TopoMock;
}

/**
 * Full activation with real wiring: real startObservation + real roster +
 * real topology manager over a mock Herdr adapter; bridge + transport seam
 * stubbed. The bridge viewer-count probe is disabled (viewerCount undefined)
 * so opens are deterministic — the same documented seam as topology.test.ts.
 */
async function activate(opts: { throwingBridge?: boolean } = {}): Promise<Harness> {
	setEnv(FULL_ENV);
	const fake = fakePi();
	const sent: Message[] = [];
	const errors: unknown[] = [];
	const adapterMock = topoMockAdapter();
	let topo: TopologyManager | undefined;

	const stubBridge: BridgeHandle = {
		socketPath: "/stub/bridge.sock",
		broadcast(m: Message) {
			if (opts.throwingBridge === true) throw new Error("dead bridge");
			sent.push(m);
		},
		viewerCount() {
			return 0;
		},
		async close() {},
	};

	lensExtension(fake.pi, {
		cwd: "/tmp/lens-guard-test",
		startBridge: () => Promise.resolve(stubBridge),
		history: createHistoryStub(),
		onObservationError: (err) => errors.push(err),
		createTopologyManager: (ctx, viewerCommand, bridgeSocketPath, emit, deps) => {
			topo = createTopologyManager(ctx, viewerCommand, bridgeSocketPath, emit, {
				...deps,
				sessionId: deps?.sessionId ?? "sess-inv",
				adapter: adapterMock.adapter,
				// Skip the post-launch viewer-connect wait: the stub bridge never
				// gains viewers (same seam the unit tests use).
				viewerCount: undefined,
			});
			return topo;
		},
	});
	await lensReady();

	const roster = (): Roster => {
		const obs = activeObservation();
		expect(obs).not.toBeNull();
		return (obs as NonNullable<typeof obs>).roster;
	};
	const getTopo = (): TopologyManager => {
		expect(topo).toBeDefined();
		return topo as TopologyManager;
	};
	return { pi: fake, sent, errors, roster, topo: getTopo, adapterMock };
}

/** Drive a direct worker into the roster through the real bus handlers. */
function feedWorker(h: Harness, id: string, status = "running"): void {
	h.pi.hooks.get("before_subagent_spawn")?.({
		type: "before_subagent_spawn",
		agent: "scout",
		spawnKey: id,
	});
	h.pi.bus.get("task:subagent:lifecycle")?.({ id, agent: "scout", status });
}

async function settle(h: Harness): Promise<void> {
	await h.topo().settle?.();
}

// --- the tamper suite -------------------------------------------------------

describe("P6-R2 invariant tamper tests", () => {
	test("(a) FR-14: closing the overview and a split never removes the worker", async () => {
		const h = await activate();
		h.pi.hooks.get("session_start")?.({}, lensCtx("sess-a"));
		feedWorker(h, "w-1");
		await settle(h);

		expect(
			h
				.roster()
				.snapshot()
				.map((w) => w.id),
		).toEqual(["w-1"]);
		// spawn auto-opened the overview; give w-1 a split, then close both views.
		expect(h.adapterMock.count("createOverviewTab")).toBe(1);
		await h.topo().openWorkerSplit("w-1");
		await settle(h);
		const split = h.adapterMock.calls.find((c) => c.method === "splitPane");
		expect(split?.args[2]).toMatchObject({ LENS_WORKER_ID: "w-1" });

		// user closes the split pane, then the whole overview pane
		h.adapterMock.closePane("pane-2");
		await settle(h);
		h.adapterMock.closePane("pane-1");
		await settle(h);

		expect(h.topo().state()).toBe("closed");
		// The worker MUST survive both closes — roster untouched.
		expect(
			h
				.roster()
				.snapshot()
				.map((w) => w.id),
		).toEqual(["w-1"]);
		// And no frame may claim the worker is gone.
		const removed = h.sent.filter((m) => m.type === "worker.removed");
		expect(removed).toHaveLength(0);
		// Only topology/notice frames are the legal close side-effects.
		expect(h.sent.some((m) => m.type === "topology" && m.state === "closed")).toBe(true);
	});

	test("(b) FR-14: open/split/close/reopen never spawns a duplicate worker", async () => {
		const h = await activate();
		h.pi.hooks.get("session_start")?.({}, lensCtx("sess-b"));
		feedWorker(h, "w-1");
		await settle(h);
		const before = h
			.roster()
			.snapshot()
			.map((w) => w.id)
			.sort();

		// every view operation: open, split, close, reopen-on-next-spawn
		await h.topo().openOverview();
		await h.topo().openWorkerSplit("w-1");
		await settle(h);
		h.adapterMock.closePane("pane-1");
		await settle(h);
		feedWorker(h, "w-2"); // reopen path: next spawn re-creates the view
		await settle(h);

		const after = h
			.roster()
			.snapshot()
			.map((w) => w.id)
			.sort();
		expect(after).toEqual([...before, "w-2"].sort());
		// View ops added NOTHING: roster grew only by the real bus-fed w-2.
		expect(after.length).toBe(before.length + 1);
		// The adapter surface can only create views, never agents.
		expect(
			h.adapterMock.calls.every((c) =>
				[
					"createOverviewTab",
					"splitPane",
					"runInPane",
					"getPane",
					"snapshot",
					"subscribeLifecycle",
					"reportMetadata",
				].includes(c.method),
			),
		).toBe(true);
		// Exactly one tab per open generation — reopen made a second, never more.
		expect(h.adapterMock.count("createOverviewTab")).toBe(2);
		// No pane ever ran anything but the viewer command.
		for (const c of h.adapterMock.calls.filter((c) => c.method === "runInPane")) {
			expect(String(c.args[1])).toContain("viewer");
		}
	});

	test("(c) FR-13: every adapter create/split/run is no-focus; guard still throws", async () => {
		const { calls, transport } = (() => {
			const rec: { method: string; params: unknown }[] = [];
			const t: HerdrTransport = {
				request: (method: string, params: unknown) => {
					rec.push({ method, params });
					return Promise.resolve(wireResult(method));
				},
			};
			return { calls: rec, transport: t };
		})();
		const ctx: CallerContext = {
			workspaceId: "w1",
			tabId: "w1:t1",
			paneId: "w1:p1",
			binPath: "/bin/herdr",
			socketPath: "/sock",
		};

		// open: tab.create + runInPane
		const { rootPaneId } = await createOverviewTab(ctx, OVERVIEW_TAB_LABEL, undefined, transport);
		await runInPane(ctx, rootPaneId, VIEWER_CMD, transport);
		// split: pane.split + runInPane
		const { paneId } = await splitPane(
			ctx,
			rootPaneId,
			"right",
			{ LENS_WORKER_ID: "w-1" },
			transport,
		);
		await runInPane(ctx, paneId, VIEWER_CMD, transport);
		// reopen/rebind path: getPane + snapshot + metadata
		await getPane(ctx, paneId, transport);
		await snapshot(ctx, transport);
		await reportMetadata(ctx, paneId, { source: "herdr-omp-lens" }, transport);

		expect(calls.length).toBeGreaterThanOrEqual(7);
		for (const c of calls) {
			// no denylisted method ever leaves the adapter
			expect(DENIED_METHODS).not.toContain(c.method);
			const params = c.params as Record<string, unknown>;
			// no request ever carries focus:true (focus theft)
			expect(params?.focus).not.toBe(true);
		}
		// create + split MUST carry focus:false explicitly
		const create = calls.find((c) => c.method === "tab.create");
		const split = calls.find((c) => c.method === "pane.split");
		expect(create).toBeDefined();
		expect(split).toBeDefined();
		expect((create?.params ?? {}) as Record<string, unknown>).toMatchObject({ focus: false });
		expect((split?.params ?? {}) as Record<string, unknown>).toMatchObject({ focus: false });
		// and the runtime guard independently refuses focus theft
		expect(() => assertAllowedRequest("tab.create", { focus: true })).toThrow(/focus/i);
		expect(() => assertAllowedRequest("pane.split", { focus: true })).toThrow(/focus/i);
	});

	test("(d) FR-11: control.* frames are rejected at decodeClientMessage", () => {
		// a valid handshake still passes
		expect(decodeClientMessage('{"v":1,"role":"viewer","session":"s-1"}').ok).toBe(true);
		// every control-injection shape fails at the same boundary
		for (const frame of [
			'{"v":1,"role":"viewer","session":"s-1","control":{"type":"spawn","agent":"x"}}',
			'{"v":1,"role":"viewer","session":"s-1","type":"control.spawn"}',
			'{"v":1,"role":"viewer","session":"s-1","control.kill":"w-1"}',
			'{"v":1,"role":"control","session":"s-1"}',
			"not json at all",
		]) {
			const r = decodeClientMessage(frame);
			expect(r.ok).toBe(false);
		}
	});

	test("(e) FR-01: HERDR_ENV unset — extension registers nothing, activates nothing", () => {
		setEnv(Object.fromEntries(HERDR_VARS.map((k) => [k, undefined])));
		const fake = fakePi();
		let activated = 0;
		let topoMade = 0;

		lensExtension(fake.pi, {
			startObservation: (() => {
				activated++;
				return Promise.reject(new Error("must never be called"));
			}) as never,
			createTopologyManager: (() => {
				topoMade++;
				throw new Error("must never be called");
			}) as never,
			startBridge: () => Promise.reject(new Error("must never bind a socket")),
		});

		expect(fake.commands.size).toBe(0);
		expect(fake.hooks.size).toBe(0);
		expect(fake.bus.size).toBe(0);
		expect(activated).toBe(0);
		expect(topoMade).toBe(0);
		expect(activeObservation()).toBeNull();
	});

	test("(f) FR-12: handlers never throw when bridge + Herdr are dead", async () => {
		const h = await activate({ throwingBridge: true });

		// every OMP-facing handler must return, never throw, never leak a rejection
		expect(() => {
			h.pi.hooks.get("session_start")?.({}, lensCtx("sess-f"));
			h.pi.hooks.get("before_subagent_spawn")?.({
				type: "before_subagent_spawn",
				agent: "a",
				spawnKey: "w-x",
			});
			h.pi.bus.get("task:subagent:lifecycle")?.({ id: "w-x", agent: "a", status: "running" });
			// an unrecognized status routes through roster.notice → dead broadcast
			h.pi.bus.get("task:subagent:lifecycle")?.({ id: "w-x", agent: "a", status: "not-a-status" });
			h.pi.bus.get("task:subagent:progress")?.({ progress: { id: "w-x", status: "running" } });
			h.pi.bus.get("task:subagent:event")?.({ id: "w-x", event: { type: "agent_start" } });
			const lens = h.pi.commands.get("lens");
			if (lens === undefined) throw new Error("lens command not registered");
			lens.handler("", lensCtx("sess-f"));
			lens.handler("split w-x", lensCtx("sess-f"));
		}).not.toThrow();
		// let every fire-and-forget promise settle; failures surface via onError,
		// never as unhandled rejections that would kill the turn.
		await settle(h);
		await Promise.resolve();
		expect(h.errors).toHaveLength(0);
		expect(
			h
				.roster()
				.snapshot()
				.map((w) => w.id),
		).toContain("w-x");
	});

	test("(g) F-15: every pi.on / pi.events.on / command handler is synchronous", async () => {
		const h = await activate();
		const returns: unknown[] = [];

		const record = <T extends unknown[]>(fn: (...a: T) => unknown, ...args: T): void => {
			returns.push(fn(...args));
		};

		record(() => h.pi.hooks.get("session_start")?.({}, lensCtx("sess-g")));
		record(() =>
			h.pi.hooks.get("before_subagent_spawn")?.({
				type: "before_subagent_spawn",
				agent: "a",
				spawnKey: "w-g",
			}),
		);
		record(() =>
			h.pi.bus.get("task:subagent:lifecycle")?.({ id: "w-g", agent: "a", status: "running" }),
		);
		record(() =>
			h.pi.bus.get("task:subagent:progress")?.({ progress: { id: "w-g", status: "running" } }),
		);
		record(() =>
			h.pi.bus.get("task:subagent:event")?.({ id: "w-g", event: { type: "agent_start" } }),
		);
		const lens = h.pi.commands.get("lens");
		if (lens === undefined) throw new Error("lens command not registered");
		record(() => lens.handler("", lensCtx("sess-g")));
		record(() => lens.handler("split w-g", lensCtx("sess-g")));

		// every handler returned undefined — a Promise means async work was
		// scheduled inside the handler body (an await, an I/O call), which is
		// exactly what F-15 forbids on the OMP hot path.
		for (const r of returns) {
			expect(r).toBeUndefined();
			expect(r instanceof Promise).toBe(false);
		}
		// and the roster effect was visible BEFORE the handler returned — parse
		// + reduce ran synchronously, not deferred into a microtask.
		expect(
			h
				.roster()
				.snapshot()
				.map((w) => w.id),
		).toContain("w-g");
	});
});

/** Canned wire responses for the real adapter (shapes from adapter.test.ts). */
function wireResult(method: string): unknown {
	switch (method) {
		case "tab.create":
			return {
				type: "tab_created",
				tab: { tab_id: "w1:t9", workspace_id: "w1" },
				root_pane: { pane_id: "w1:p9", tab_id: "w1:t9", workspace_id: "w1" },
			};
		case "pane.split":
			return {
				type: "pane_info",
				pane: { pane_id: "w1:p10", tab_id: "w1:t9", workspace_id: "w1" },
			};
		case "pane.get":
			return {
				type: "pane_info",
				pane: { pane_id: "w1:p10", tab_id: "w1:t9", workspace_id: "w1" },
			};
		case "session.snapshot":
			return {
				type: "session_snapshot",
				snapshot: {
					version: "0.9.5",
					protocol: 22,
					workspaces: [],
					tabs: [],
					panes: [{ pane_id: "w1:p9", tab_id: "w1:t9", workspace_id: "w1" }],
					layouts: [],
					agents: [],
				},
			};
		default:
			return { type: "ok" };
	}
}
