import { describe, expect, test } from "bun:test";
import {
	createTopologyManager,
	OVERVIEW_TAB_LABEL,
	TOPOLOGY_METADATA_SOURCE,
	type TopologyAdapter,
} from "../../src/extension/topology";
import type { CallerContext } from "../../src/herdr/context";
import type {
	LifecycleHandlers,
	PaneInfo,
	PaneMetadata,
	SessionSnapshot,
	Subscription,
} from "../../src/herdr/types";
import type { Message } from "../../src/protocol/types";

const CTX: CallerContext = {
	workspaceId: "w1",
	tabId: "w1:t1",
	paneId: "w1:p1",
	binPath: "/bin/herdr",
	// F-01 tamper bait: the adapter transport socket — must NEVER leak into env.
	socketPath: "/WRONG/herdr.sock",
};

const BRIDGE = "/bridge/per-session.sock";
const VIEWER_CMD = "bun /pkg/src/viewer/cli.ts";

interface RecordedCall {
	method: string;
	args: unknown[];
}

/** Mock adapter: records calls, keeps an authoritative pane set, captures handlers. */
function mockAdapter(opts: { failOn?: string[]; deferSubscribe?: boolean } = {}) {
	const calls: RecordedCall[] = [];
	const panes = new Map<string, PaneInfo>();
	let handlers: LifecycleHandlers = {};
	let tabCounter = 0;
	let paneCounter = 0;
	let closedSubs = 0;
	const failOn = new Set(opts.failOn ?? []);
	let subResolve: (() => void) | null = null;

	function maybeFail(method: string): void {
		if (failOn.has(method)) throw new Error(`mock adapter failure: ${method}`);
	}

	const adapter: TopologyAdapter = {
		async createOverviewTab(label: string, env?: Record<string, string>) {
			calls.push({ method: "createOverviewTab", args: [label, env] });
			maybeFail("createOverviewTab");
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
			maybeFail("splitPane");
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
			maybeFail("runInPane");
		},
		async getPane(paneId: string) {
			calls.push({ method: "getPane", args: [paneId] });
			maybeFail("getPane");
			return panes.get(paneId) ?? null;
		},
		async snapshot(): Promise<SessionSnapshot> {
			calls.push({ method: "snapshot", args: [] });
			maybeFail("snapshot");
			return { workspaces: [], tabs: [], panes: [...panes.values()] };
		},
		async subscribeLifecycle(h: LifecycleHandlers): Promise<Subscription> {
			calls.push({ method: "subscribeLifecycle", args: [] });
			maybeFail("subscribeLifecycle");
			handlers = h;
			const sub: Subscription = {
				async close() {
					closedSubs += 1;
				},
			};
			if (opts.deferSubscribe === true) {
				const deferred = Promise.withResolvers<Subscription>();
				subResolve = () => deferred.resolve(sub);
				return deferred.promise;
			}
			return sub;
		},
		async reportMetadata(paneId: string, meta: PaneMetadata) {
			calls.push({ method: "reportMetadata", args: [paneId, meta] });
			maybeFail("reportMetadata");
		},
	};

	return {
		adapter,
		calls,
		panes,
		get handlers() {
			return handlers;
		},
		get closedSubs() {
			return closedSubs;
		},
		count(method: string) {
			return calls.filter((c) => c.method === method).length;
		},
		resolveSubscribe() {
			subResolve?.();
		},
	};
}

function make(overrides: {
	adapter?: TopologyAdapter;
	sessionId?: string;
	ctx?: CallerContext;
	bridgeSocketPath?: string;
}) {
	const messages: Message[] = [];
	const manager = createTopologyManager(
		overrides.ctx ?? CTX,
		VIEWER_CMD,
		overrides.bridgeSocketPath ?? BRIDGE,
		(m) => messages.push(m),
		{ adapter: overrides.adapter, sessionId: overrides.sessionId ?? "sess-1" },
	);
	return { manager, messages };
}

async function settle(manager: { settle?(): Promise<void> }): Promise<void> {
	if (manager.settle) await manager.settle();
}

describe("topology manager — open / single-flight", () => {
	test("subscribes lifecycle before the first createOverviewTab (P4-R1)", async () => {
		const m = mockAdapter();
		const { manager } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		const order = m.calls.map((c) => c.method);
		expect(order.indexOf("subscribeLifecycle")).toBeGreaterThanOrEqual(0);
		expect(order.indexOf("subscribeLifecycle")).toBeLessThan(order.indexOf("createOverviewTab"));
		await manager.stop();
	});

	test("first spawn opens one no-focus overview tab and runs the viewer (P4-R2)", async () => {
		const m = mockAdapter();
		const { manager, messages } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		expect(m.count("createOverviewTab")).toBe(1);
		const create = m.calls.find((c) => c.method === "createOverviewTab");
		expect(create?.args[0]).toBe(OVERVIEW_TAB_LABEL);
		expect(m.count("runInPane")).toBe(1);
		const run = m.calls.find((c) => c.method === "runInPane");
		expect(run?.args[1]).toBe(VIEWER_CMD);
		expect(manager.state()).toBe("open");
		const topo = messages.find((msg) => msg.type === "topology");
		expect(topo).toMatchObject({ type: "topology", state: "open", tabId: "tab-1" });
		await manager.stop();
	});

	test("single-flight: parallel spawns create exactly one tab (P4-R4)", async () => {
		const m = mockAdapter();
		const { manager } = make({ adapter: m.adapter });
		await Promise.all([
			manager.onWorkerSpawned(),
			manager.onWorkerSpawned(),
			manager.onWorkerSpawned(),
		]);
		expect(m.count("createOverviewTab")).toBe(1);
		expect(manager.state()).toBe("open");
		await manager.stop();
	});

	test("spawn while open is a no-op", async () => {
		const m = mockAdapter();
		const { manager } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		await manager.onWorkerSpawned();
		expect(m.count("createOverviewTab")).toBe(1);
		await manager.stop();
	});

	test("env uses the bridge socket, never CallerContext.socketPath (F-01)", async () => {
		const m = mockAdapter();
		const { manager } = make({ adapter: m.adapter, sessionId: "sess-xyz" });
		await manager.onWorkerSpawned();
		const create = m.calls.find((c) => c.method === "createOverviewTab");
		const env = create?.args[1] as Record<string, string>;
		expect(env.LENS_SOCKET_PATH).toBe(BRIDGE);
		expect(env.LENS_SOCKET_PATH).not.toBe(CTX.socketPath);
		expect(env.LENS_SESSION).toBe("sess-xyz");
		await manager.stop();
	});

	test("owned panes are reported with source, never as an agent (P4-R13)", async () => {
		const m = mockAdapter();
		const { manager } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		const meta = m.calls.find((c) => c.method === "reportMetadata");
		const metaArg = meta?.args[1] as PaneMetadata | undefined;
		expect(metaArg?.source).toBe(TOPOLOGY_METADATA_SOURCE);
		expect(metaArg?.displayAgent).toBeUndefined();
		await manager.stop();
	});
});

describe("topology manager — history + close/reopen", () => {
	test("onHistoryPresent auto-opens the overview with no spawn (D2)", async () => {
		const m = mockAdapter();
		const { manager } = make({ adapter: m.adapter });
		await manager.onHistoryPresent?.();
		expect(m.count("createOverviewTab")).toBe(1);
		expect(manager.state()).toBe("open");
		await manager.stop();
	});

	test("manual close is respected; next spawn reopens exactly once (P4-R3)", async () => {
		const m = mockAdapter();
		const { manager, messages } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		// user closes the tab; the authoritative snapshot agrees the pane is gone
		m.panes.clear();
		const callCountAtClose = m.calls.length;
		m.handlers.onTabClosed?.({ workspaceId: CTX.workspaceId, tabId: "tab-1" });
		await settle(manager);
		expect(manager.state()).toBe("closed");
		const closed = messages.filter((msg) => msg.type === "topology" && msg.state === "closed");
		expect(closed.length).toBe(1);
		// no mutation calls after close — only the confirm read
		const afterClose = m.calls.slice(callCountAtClose);
		expect(
			afterClose.every(
				(c) =>
					c.method === "snapshot" || c.method === "getPane" || c.method === "subscribeLifecycle",
			),
		).toBe(true);
		await manager.onWorkerSpawned();
		expect(m.count("createOverviewTab")).toBe(2);
		expect(manager.state()).toBe("open");
		await manager.stop();
	});

	test("tab.closed while pane still present in snapshot does NOT mark closed (moved race)", async () => {
		const m = mockAdapter();
		const { manager, messages } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		// pane still in panes map → snapshot() will show it
		m.handlers.onTabClosed?.({ workspaceId: CTX.workspaceId, tabId: "tab-1" });
		await settle(manager);
		expect(manager.state()).toBe("open");
		expect(
			messages.filter((msg) => msg.type === "topology" && msg.state === "closed"),
		).toHaveLength(0);
		await manager.stop();
	});

	test("pane.moved rewrites the stored id; later close matches the new id (P4-R9)", async () => {
		const m = mockAdapter();
		const { manager } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		m.panes.set("pane-9", {
			paneId: "pane-9",
			tabId: "tab-9",
			workspaceId: CTX.workspaceId,
			title: OVERVIEW_TAB_LABEL,
		});
		m.handlers.onPaneMoved?.({
			previousPaneId: "pane-1",
			previousWorkspaceId: CTX.workspaceId,
			previousTabId: "tab-1",
			pane: m.panes.get("pane-9") as PaneInfo,
		});
		await settle(manager);
		expect(manager.state()).toBe("open");
		// close the moved pane; snapshot confirms absence of the new id
		m.panes.delete("pane-9");
		m.handlers.onPaneClosed?.({ workspaceId: CTX.workspaceId, paneId: "pane-9" });
		await settle(manager);
		expect(manager.state()).toBe("closed");
		await manager.stop();
	});

	test("pane.exited emits a notice and does not auto-reopen (U-HDR-3)", async () => {
		const m = mockAdapter();
		const { manager, messages } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		m.handlers.onPaneExited?.({ workspaceId: CTX.workspaceId, paneId: "pane-1" });
		await settle(manager);
		expect(messages.some((msg) => msg.type === "notice")).toBe(true);
		expect(m.count("createOverviewTab")).toBe(1);
		await manager.stop();
	});

	test("workspace.closed makes the manager inert (P4-R9)", async () => {
		const m = mockAdapter();
		const { manager } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		m.panes.clear();
		m.handlers.onWorkspaceClosed?.({ workspaceId: CTX.workspaceId });
		await settle(manager);
		expect(manager.state()).toBe("closed");
		await manager.onWorkerSpawned();
		expect(m.count("createOverviewTab")).toBe(1);
		await manager.stop();
	});

	test("events_lost reconciles owned ids against snapshot (P4-R10)", async () => {
		const m = mockAdapter();
		const { manager } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		m.panes.clear();
		m.handlers.onEventsLost?.();
		await settle(manager);
		expect(manager.state()).toBe("closed");
		await manager.stop();
	});
});

describe("topology manager — worker splits (D3)", () => {
	test("openWorkerSplit creates a no-focus worker-scoped split (P4-R7)", async () => {
		const m = mockAdapter();
		const { manager } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		const { paneId } = await manager.openWorkerSplit("w-1");
		const split = m.calls.find((c) => c.method === "splitPane");
		expect(split).toBeDefined();
		expect(split?.args[0]).toBe("pane-1"); // overview root pane is the target
		expect(split?.args[1]).toBe("right");
		const env = split?.args[2] as Record<string, string>;
		expect(env.LENS_WORKER_ID).toBe("w-1");
		expect(env.LENS_SOCKET_PATH).toBe(BRIDGE);
		expect(paneId).toBe("pane-2");
		const run = m.calls.filter((c) => c.method === "runInPane");
		expect(run.some((c) => c.args[0] === "pane-2" && c.args[1] === VIEWER_CMD)).toBe(true);
		await manager.stop();
	});

	test("one split per worker: repeat call returns the live pane (Q-P4-3)", async () => {
		const m = mockAdapter();
		const { manager } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		const first = await manager.openWorkerSplit("w-1");
		const second = await manager.openWorkerSplit("w-1");
		expect(second.paneId).toBe(first.paneId);
		expect(m.count("splitPane")).toBe(1);
		await manager.stop();
	});

	test("onWorkerFinished drops the split binding only — never worker effects (P4-R8)", async () => {
		const m = mockAdapter();
		const { manager, messages } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		const first = await manager.openWorkerSplit("w-1");
		manager.onWorkerFinished("w-1");
		await settle(manager);
		expect(messages.some((msg) => msg.type === "worker.removed")).toBe(false);
		const second = await manager.openWorkerSplit("w-1");
		expect(second.paneId).not.toBe(first.paneId);
		expect(m.count("splitPane")).toBe(2);
		await manager.stop();
	});

	test("closing a split emits topology, never worker.removed (P4-R8/FR-14)", async () => {
		const m = mockAdapter();
		const { manager, messages } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		const { paneId } = await manager.openWorkerSplit("w-1");
		m.panes.delete(paneId);
		m.handlers.onPaneClosed?.({ workspaceId: CTX.workspaceId, paneId });
		await settle(manager);
		expect(messages.some((msg) => msg.type === "worker.removed")).toBe(false);
		// overview stays open
		expect(manager.state()).toBe("open");
		await manager.stop();
	});

	test("onRosterEmpty is a no-op on views", async () => {
		const m = mockAdapter();
		const { manager } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		manager.onRosterEmpty?.();
		await settle(manager);
		expect(manager.state()).toBe("open");
		expect(m.count("createOverviewTab")).toBe(1);
		await manager.stop();
	});
});

describe("topology manager — degradation + stop", () => {
	test("adapter failure degrades + notice, spawn signals still flow (P4-R11)", async () => {
		const m = mockAdapter({ failOn: ["createOverviewTab"] });
		const { manager, messages } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		expect(manager.state()).toBe("degraded");
		expect(messages.some((msg) => msg.type === "notice" && msg.level === "error")).toBe(true);
		// second signal must not throw and must not stack duplicate notices forever —
		// it retries but stays degraded
		await manager.onWorkerSpawned();
		expect(manager.state()).toBe("degraded");
		await manager.stop();
	});

	test("stop() closes the subscription and freezes the manager", async () => {
		const m = mockAdapter();
		const { manager } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		await manager.stop();
		expect(m.closedSubs).toBe(1);
		await manager.onWorkerSpawned();
		expect(m.count("createOverviewTab")).toBe(1);
	});
});

describe("topology manager — review-fix regressions", () => {
	test("F1: survivor rebind relaunches the viewer with refreshed LENS_* env (P4-R4/D2)", async () => {
		const m = mockAdapter();
		// A surviving "OMP subagents" pane from a PREVIOUS OMP session
		m.panes.set("old-pane", {
			paneId: "old-pane",
			tabId: "old-tab",
			workspaceId: CTX.workspaceId,
			title: OVERVIEW_TAB_LABEL,
		});
		const { manager } = make({ adapter: m.adapter, sessionId: "sess-new" });
		await manager.onWorkerSpawned();
		expect(m.count("createOverviewTab")).toBe(0); // rebind, not recreate
		expect(manager.state()).toBe("open");
		const run = m.calls.find((c) => c.method === "runInPane" && c.args[0] === "old-pane");
		expect(run).toBeDefined();
		const command = String(run?.args[1]);
		expect(command).toContain(`LENS_SOCKET_PATH='${BRIDGE}'`);
		expect(command).toContain("LENS_SESSION='sess-new'");
		expect(command).toContain(VIEWER_CMD);
		await manager.stop();
	});

	test("F2: a split moved out of the tab does not block tab.closed confirm (FR-05)", async () => {
		const m = mockAdapter();
		const { manager } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		const { paneId: splitPane } = await manager.openWorkerSplit("w-1");
		// user drags the split out of the OMP subagents tab — id rewrite on move
		m.handlers.onPaneMoved?.({
			previousPaneId: splitPane,
			previousWorkspaceId: CTX.workspaceId,
			previousTabId: "tab-1",
			pane: { paneId: splitPane, tabId: "tab-other", workspaceId: CTX.workspaceId },
		});
		await settle(manager);
		// now the tab itself closes: overview pane gone, moved-out split still live
		m.panes.delete("pane-1");
		m.handlers.onTabClosed?.({ workspaceId: CTX.workspaceId, tabId: "tab-1" });
		await settle(manager);
		expect(manager.state()).toBe("closed");
		// next spawn reopens exactly one fresh view (FR-05)
		await manager.onWorkerSpawned();
		expect(m.count("createOverviewTab")).toBe(2);
		await manager.stop();
	});

	test("F3: stop() closes a subscription assigned mid-drain (event-stream leak)", async () => {
		const m = mockAdapter({ deferSubscribe: true });
		const { manager } = make({ adapter: m.adapter });
		const spawned = manager.onWorkerSpawned();
		// let the queued transition reach the deferred subscribeLifecycle call
		for (let i = 0; i < 200 && m.count("subscribeLifecycle") === 0; i++) {
			await Promise.resolve();
		}
		expect(m.count("subscribeLifecycle")).toBe(1);
		// stop() drains while subscribe is still unresolved, then it resolves late
		const stopping = manager.stop();
		m.resolveSubscribe();
		await Promise.all([spawned, stopping]);
		expect(m.closedSubs).toBe(1);
	});

	test("final F2: overview pane.exited marks the view dead; next spawn relaunches in the same pane", async () => {
		const m = mockAdapter();
		const { manager, messages } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		expect(m.count("runInPane")).toBe(1);
		// viewer process dies; the pane itself survives in Herdr
		m.handlers.onPaneExited?.({ workspaceId: CTX.workspaceId, paneId: "pane-1" });
		await settle(manager);
		expect(messages.some((msg) => msg.type === "notice")).toBe(true);
		expect(manager.state()).toBe("closed"); // not stuck "open" on a dead viewer
		// next spawn relaunches into the surviving pane with refreshed env (no second tab)
		await manager.onWorkerSpawned();
		expect(m.count("createOverviewTab")).toBe(1);
		const relaunch = m.calls
			.slice()
			.reverse()
			.find((c) => c.method === "runInPane" && c.args[0] === "pane-1");
		expect(relaunch).toBeDefined();
		expect(String(relaunch?.args[1])).toContain("LENS_SOCKET_PATH=");
		expect(String(relaunch?.args[1])).toContain(VIEWER_CMD);
		expect(manager.state()).toBe("open");
		await manager.stop();
	});

	test("final F6: a split-titled pane is not adopted as the overview survivor", async () => {
		const m = mockAdapter();
		// "OMP subagents · w-1" — a worker split (or user pane) whose title merely
		// CONTAINS the overview label must not be adopted as the overview.
		m.panes.set("stray", {
			paneId: "stray",
			tabId: "stray-tab",
			workspaceId: CTX.workspaceId,
			title: `${OVERVIEW_TAB_LABEL} · w-1`,
		});
		const { manager } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		expect(m.count("createOverviewTab")).toBe(1); // creates its own tab
		expect(m.calls.some((c) => c.method === "runInPane" && c.args[0] === "stray")).toBe(false);
		expect(manager.state()).toBe("open");
		await manager.stop();
	});

	test("final F6: an exact-title survivor is still adopted (positive control)", async () => {
		const m = mockAdapter();
		m.panes.set("old-pane", {
			paneId: "old-pane",
			tabId: "old-tab",
			workspaceId: CTX.workspaceId,
			title: OVERVIEW_TAB_LABEL,
		});
		const { manager } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		expect(m.count("createOverviewTab")).toBe(0);
		expect(m.calls.some((c) => c.method === "runInPane" && c.args[0] === "old-pane")).toBe(true);
		await manager.stop();
	});
});
