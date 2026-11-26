import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveViewerCommand } from "../../src/extension/resolve";
import {
	createTopologyManager,
	OVERVIEW_TAB_LABEL,
	TOPOLOGY_METADATA_SOURCE,
	type TopologyAdapter,
	type TopologyDeps,
} from "../../src/extension/topology";
import type { CallerContext } from "../../src/herdr/context";
import type {
	LifecycleHandlers,
	PaneInfo,
	PaneMetadata,
	SessionSnapshot,
	Subscription,
	TabInfo,
} from "../../src/herdr/types";
import type { Message } from "../../src/protocol/types";

const CTX: CallerContext = {
	workspaceId: "w1",
	tabId: "w1:t1",
	paneId: "w1:p1",
	binPath: "/bin/herdr",
	// F-01 tamper bait: Herdr's own transport socket — must NEVER reach viewer env.
	socketPath: "/WRONG/herdr.sock",
};

const BRIDGE = "/bridge/session-A.sock";
const BRIDGE_RESTARTED = "/bridge/session-B.sock";
const VIEWER_CMD = "bun /pkg/src/viewer/cli.ts";
const SESSION = "omp-session-real-1";
const SESSION_RESTARTED = "omp-session-real-2";

interface RecordedCall {
	method: string;
	args: unknown[];
}

/**
 * Mock adapter: records calls, keeps an authoritative pane set, captures the
 * LifecycleHandlers P4 registers, and simulates viewer bridge connections via
 * `connected` (bumped inside runInPane when `connectsOnRun` is set).
 */
function mockAdapter(
	opts: { failOn?: string[]; connectsOnRun?: boolean; connected?: { count: number } } = {},
) {
	const calls: RecordedCall[] = [];
	const panes = new Map<string, PaneInfo>();
	/** Authoritative tab set (wire `label` — pane.title is null on Herdr 0.9.5). */
	const tabs = new Map<string, TabInfo>();
	let handlers: LifecycleHandlers = {};
	let tabCounter = 0;
	let paneCounter = 0;
	let closedSubs = 0;
	const failOn = new Set(opts.failOn ?? []);

	function maybeFail(method: string): void {
		if (failOn.has(method)) throw new Error(`mock adapter failure: ${method}`);
	}
	function maybeConnect(): void {
		if (opts.connectsOnRun === true && opts.connected !== undefined) {
			opts.connected.count += 1;
		}
	}

	const adapter: TopologyAdapter = {
		async createOverviewTab(label: string, env?: Record<string, string>) {
			calls.push({ method: "createOverviewTab", args: [label, env] });
			maybeFail("createOverviewTab");
			tabCounter += 1;
			paneCounter += 1;
			const tabId = `tab-${tabCounter}`;
			const rootPaneId = `pane-${paneCounter}`;
			tabs.set(tabId, { tabId, workspaceId: CTX.workspaceId, label });
			panes.set(rootPaneId, {
				paneId: rootPaneId,
				tabId,
				workspaceId: CTX.workspaceId,
				// Herdr 0.9.5: snapshot pane.title stays null — label lives on the tab.
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
			maybeConnect();
		},
		async getPane(paneId: string) {
			calls.push({ method: "getPane", args: [paneId] });
			maybeFail("getPane");
			return panes.get(paneId) ?? null;
		},
		async snapshot(): Promise<SessionSnapshot> {
			calls.push({ method: "snapshot", args: [] });
			maybeFail("snapshot");
			return { workspaces: [], tabs: [...tabs.values()], panes: [...panes.values()] };
		},
		async subscribeLifecycle(h: LifecycleHandlers): Promise<Subscription> {
			calls.push({ method: "subscribeLifecycle", args: [] });
			maybeFail("subscribeLifecycle");
			handlers = h;
			return {
				async close() {
					closedSubs += 1;
				},
			};
		},
		async reportMetadata(paneId: string, meta: PaneMetadata) {
			calls.push({ method: "reportMetadata", args: [paneId, meta] });
			maybeFail("reportMetadata");
		},
	};

	return {
		adapter,
		calls,
		tabs,
		panes,
		/** Live failure set — delete a method name to heal the adapter. */
		failures: failOn,
		get handlers() {
			return handlers;
		},
		get closedSubs() {
			return closedSubs;
		},
		count(method: string) {
			return calls.filter((c) => c.method === method).length;
		},
		callsOf(method: string) {
			return calls.filter((c) => c.method === method);
		},
	};
}

function make(overrides: {
	adapter?: TopologyAdapter;
	deps?: Partial<TopologyDeps>;
	ctx?: CallerContext;
	bridgeSocketPath?: string;
	viewerCommand?: string;
}) {
	const messages: Message[] = [];
	const deps: TopologyDeps = {
		sessionId: SESSION,
		...overrides.deps,
		...(overrides.adapter !== undefined ? { adapter: overrides.adapter } : {}),
	};
	const manager = createTopologyManager(
		overrides.ctx ?? CTX,
		overrides.viewerCommand ?? VIEWER_CMD,
		overrides.bridgeSocketPath ?? BRIDGE,
		(m) => messages.push(m),
		deps,
	);
	return { manager, messages };
}

async function settle(manager: { settle?(): Promise<void> }): Promise<void> {
	if (manager.settle) await manager.settle();
}

describe("P4-2 — real session id (no pid default)", () => {
	test("throws when deps.sessionId is absent or empty", () => {
		const emit = (_m: Message): void => {};
		expect(() => createTopologyManager(CTX, VIEWER_CMD, BRIDGE, emit)).toThrow();
		expect(() => createTopologyManager(CTX, VIEWER_CMD, BRIDGE, emit, { sessionId: "" })).toThrow(
			/sessionId/,
		);
	});

	test("LENS_SESSION carries the real session id, never the pid fallback", async () => {
		const m = mockAdapter();
		const { manager } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		const create = m.calls.find((c) => c.method === "createOverviewTab");
		const env = create?.args[1] as Record<string, string>;
		expect(env.LENS_SESSION).toBe(SESSION);
		expect(env.LENS_SESSION).not.toBe(String(process.pid));
		await manager.stop();
	});
});

describe("P4-2 — orchestration of the P1 adapter", () => {
	test("subscribe resolves before snapshot reconcile before create (P4-R1/R4)", async () => {
		const m = mockAdapter();
		const { manager } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		const order = m.calls.map((c) => c.method);
		const sub = order.indexOf("subscribeLifecycle");
		const snap = order.indexOf("snapshot");
		const create = order.indexOf("createOverviewTab");
		expect(sub).toBeGreaterThanOrEqual(0);
		expect(sub).toBeLessThan(snap);
		expect(snap).toBeLessThan(create);
		await manager.stop();
	});

	test("viewer env: LENS_SOCKET_PATH is the bridge socket, never ctx.socketPath (F-01)", async () => {
		const m = mockAdapter();
		const { manager } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		const create = m.calls.find((c) => c.method === "createOverviewTab");
		expect(create?.args[0]).toBe(OVERVIEW_TAB_LABEL);
		const env = create?.args[1] as Record<string, string>;
		expect(env.LENS_SOCKET_PATH).toBe(BRIDGE);
		expect(env.LENS_SOCKET_PATH).not.toBe(CTX.socketPath);
		expect(env.LENS_SESSION).toBe(SESSION);
		await manager.stop();
	});

	test("runInPane sends the short viewer command verbatim into the root pane", async () => {
		const m = mockAdapter();
		const { manager } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		const run = m.calls.find((c) => c.method === "runInPane");
		expect(run?.args[0]).toBe("pane-1");
		// v1.4: argv0 ownership wrap — the resolved command rides inside
		expect(run?.args[1]).toContain(VIEWER_CMD);
		expect(run?.args[1]).toMatch(/exec -a lens:[^:]+:\d+/);
		expect(String(run?.args[1]).length).toBeLessThan(256);
		await manager.stop();
	});

	test("no-focus surface: topology never emits focus/ forbidden calls (P4-R5/R6 tamper)", () => {
		const root = join(import.meta.dir, "../..");
		const topoSrc = readFileSync(join(root, "src/extension/topology.ts"), "utf8");
		const adapterSrc = readFileSync(join(root, "src/herdr/adapter.ts"), "utf8");
		for (const banned of [
			"focus: true",
			"report_agent",
			"agent.start",
			"agent.view.set",
			"layout.apply",
		]) {
			expect(topoSrc).not.toContain(banned);
			expect(adapterSrc).not.toContain(banned);
		}
		// the P1 adapter pins focus:false on both mutation calls
		expect(adapterSrc).toContain("focus: false");
	});

	test("every reportMetadata carries source; nothing reports an agent (P4-R13)", async () => {
		const m = mockAdapter();
		const { manager } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		await manager.openWorkerSplit("w-1");
		const metas = m.callsOf("reportMetadata");
		expect(metas.length).toBeGreaterThanOrEqual(2);
		for (const c of metas) {
			const meta = c.args[1] as PaneMetadata;
			expect(meta.source).toBe(TOPOLOGY_METADATA_SOURCE);
			expect(meta.displayAgent).toBeUndefined();
		}
		await manager.stop();
	});
});

describe("P4-2 — surviving-tab rebind (D2)", () => {
	test("a surviving OMP subagents pane is rebound to the NEW bridge socket, not duplicated", async () => {
		// First session opened the tab; its bridge socket is now dead.
		const first = mockAdapter();
		const m1 = make({ adapter: first.adapter });
		await m1.manager.onWorkerSpawned();
		await m1.manager.stop();

		// Restart: same surviving TAB+pane visible in the snapshot — pane.title
		// is null on Herdr 0.9.5, so the label lives on the tab.
		const survivor = first.panes.get("pane-1");
		expect(survivor).toBeDefined();
		const m = mockAdapter();
		m.tabs.set("tab-1", {
			tabId: "tab-1",
			workspaceId: CTX.workspaceId,
			label: OVERVIEW_TAB_LABEL,
		});
		if (survivor !== undefined) m.panes.set(survivor.paneId, survivor);
		const { manager } = make({
			adapter: m.adapter,
			bridgeSocketPath: BRIDGE_RESTARTED,
			deps: { sessionId: SESSION_RESTARTED },
		});
		await manager.onHistoryPresent?.();
		expect(m.count("createOverviewTab")).toBe(0); // rebind, never a duplicate tab
		expect(manager.state()).toBe("open");
		const run = m.calls.find((c) => c.method === "runInPane" && c.args[0] === "pane-1");
		expect(run).toBeDefined();
		const command = String(run?.args[1]);
		// D2/F-11: env must ride the relaunch command — env is create-time only.
		expect(command).toContain(`LENS_SOCKET_PATH='${BRIDGE_RESTARTED}'`);
		expect(command).toContain(`LENS_SESSION='${SESSION_RESTARTED}'`);
		expect(command).not.toContain(BRIDGE); // dead socket must not leak
		expect(command).not.toContain(SESSION);
		expect(command).toContain(VIEWER_CMD);
		const meta = m.calls.find((c) => c.method === "reportMetadata");
		expect(meta).toBeDefined();
		expect((meta?.args[1] as PaneMetadata | undefined)?.source).toBe(TOPOLOGY_METADATA_SOURCE);
		await manager.stop();
	});
});

describe("P4-2 — viewer health via bridge connection, not pane.get alone", () => {
	test("launch with no bridge connection degrades even though the pane exists", async () => {
		const m = mockAdapter();
		const { manager, messages } = make({
			adapter: m.adapter,
			deps: { viewerCount: () => 0, viewerHealthTimeoutMs: 0 },
		});
		await manager.onWorkerSpawned();
		expect(manager.state()).toBe("degraded");
		expect(messages.some((msg) => msg.type === "notice" && msg.level === "error")).toBe(true);
		await manager.stop();
	});

	test("viewer connecting on the bridge lets the open transition complete", async () => {
		const connected = { count: 0 };
		const m = mockAdapter({ connectsOnRun: true, connected });
		const { manager } = make({
			adapter: m.adapter,
			deps: { viewerCount: () => connected.count, viewerHealthTimeoutMs: 0 },
		});
		await manager.onWorkerSpawned();
		expect(manager.state()).toBe("open");
		await manager.stop();
	});

	test("rebind of a pane whose viewer never connects also degrades", async () => {
		const m = mockAdapter();
		m.tabs.set("old-tab", {
			tabId: "old-tab",
			workspaceId: CTX.workspaceId,
			label: OVERVIEW_TAB_LABEL,
		});
		m.panes.set("old-pane", {
			paneId: "old-pane",
			tabId: "old-tab",
			workspaceId: CTX.workspaceId,
		});
		const { manager } = make({
			adapter: m.adapter,
			deps: { viewerCount: () => 0, viewerHealthTimeoutMs: 0 },
		});
		await manager.onWorkerSpawned();
		expect(manager.state()).toBe("degraded");
		expect(m.count("createOverviewTab")).toBe(0);
		await manager.stop();
	});

	test("split reuse relaunches the viewer when no viewer is connected (pane.get alone insufficient)", async () => {
		const connected = { count: 1 }; // overview viewer already on the bridge
		const m = mockAdapter({ connectsOnRun: true, connected });
		const { manager } = make({
			adapter: m.adapter,
			deps: { viewerCount: () => connected.count, viewerHealthTimeoutMs: 0 },
		});
		await manager.onWorkerSpawned();
		const first = await manager.openWorkerSplit("w-1");
		expect(m.count("splitPane")).toBe(1);
		// Live pane + viewers connected → reuse without relaunch.
		const second = await manager.openWorkerSplit("w-1");
		expect(second.paneId).toBe(first.paneId);
		expect(m.count("splitPane")).toBe(1);
		// Viewer died (pane.get still returns the pane): reuse must relaunch.
		connected.count = 0;
		const runsBefore = m.count("runInPane");
		const third = await manager.openWorkerSplit("w-1");
		expect(third.paneId).toBe(first.paneId);
		expect(m.count("splitPane")).toBe(1);
		expect(m.count("runInPane")).toBeGreaterThan(runsBefore);
		const runs = m.callsOf("runInPane").filter((c) => c.args[0] === first.paneId);
		const relaunch = runs.length > 0 ? runs[runs.length - 1] : undefined;
		expect(String(relaunch?.args[1])).toContain("LENS_SOCKET_PATH");
		await manager.stop();
	});
});

describe("P4-2 — lifecycle reconcile", () => {
	test("events_lost: P4 reconciles via snapshot; P1 owns resubscribe (F-12/P4-R10)", async () => {
		const m = mockAdapter();
		const { manager } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		expect(m.count("subscribeLifecycle")).toBe(1);
		m.panes.clear(); // everything vanished while the stream was blind
		const snapshotsBefore = m.count("snapshot");
		m.handlers.onEventsLost?.();
		await settle(manager);
		expect(m.count("subscribeLifecycle")).toBe(1); // P4 must not resubscribe itself
		expect(m.count("snapshot")).toBeGreaterThan(snapshotsBefore);
		expect(manager.state()).toBe("closed");
		await manager.stop();
	});

	test("pane.closed is a hint: snapshot confirm keeps a still-present pane open", async () => {
		const m = mockAdapter();
		const { manager, messages } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		m.handlers.onPaneClosed?.({ workspaceId: CTX.workspaceId, paneId: "pane-1" });
		await settle(manager);
		expect(manager.state()).toBe("open"); // pane still in snapshot → hint only
		expect(
			messages.filter((msg) => msg.type === "topology" && msg.state === "closed"),
		).toHaveLength(0);
		await manager.stop();
	});

	test("pane.moved rewrites owned ids; closed on the NEW ids confirms (V-HDR-3)", async () => {
		const m = mockAdapter();
		const { manager } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		m.panes.delete("pane-1");
		m.panes.set("pane-9", {
			paneId: "pane-9",
			tabId: "tab-9",
			workspaceId: CTX.workspaceId,
			title: OVERVIEW_TAB_LABEL,
		});
		const moved = m.panes.get("pane-9");
		expect(moved).toBeDefined();
		if (moved === undefined) return;
		m.handlers.onPaneMoved?.({
			previousPaneId: "pane-1",
			previousWorkspaceId: CTX.workspaceId,
			previousTabId: "tab-1",
			pane: moved,
		});
		await settle(manager);
		// close on the OLD tab id no longer matches — manager stays open
		m.handlers.onTabClosed?.({ workspaceId: CTX.workspaceId, tabId: "tab-1" });
		await settle(manager);
		expect(manager.state()).toBe("open");
		// close on the NEW ids: event hint + snapshot confirm → closed
		m.panes.delete("pane-9");
		m.handlers.onTabClosed?.({ workspaceId: CTX.workspaceId, tabId: "tab-9" });
		await settle(manager);
		expect(manager.state()).toBe("closed");
		await manager.stop();
	});

	test("degraded recovers through the events_lost reconcile path (P4-R11/D1)", async () => {
		const m = mockAdapter({ failOn: ["createOverviewTab"] });
		const { manager } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		expect(manager.state()).toBe("degraded");
		m.failures.delete("createOverviewTab");
		m.handlers.onEventsLost?.();
		await settle(manager);
		expect(manager.state()).toBe("closed");
		// and the next spawn opens normally
		await manager.onWorkerSpawned();
		expect(manager.state()).toBe("open");
		expect(m.count("createOverviewTab")).toBe(2);
		await manager.stop();
	});
});

describe("final F1 — real resolveViewerCommand() through the launch path", () => {
	test("the production viewer command word is a runnable `bun <cli.ts>` invocation", async () => {
		const realViewerCommand = resolveViewerCommand();
		// the command word itself must be executable — a bare .ts path is not.
		expect(realViewerCommand.startsWith("bun ")).toBe(true);
		expect(realViewerCommand.endsWith("cli.ts")).toBe(true);
		expect(existsSync(realViewerCommand.slice(4))).toBe(true);

		const m = mockAdapter();
		const { manager } = make({ adapter: m.adapter, viewerCommand: realViewerCommand });
		await manager.onWorkerSpawned();
		const run = m.calls.find((c) => c.method === "runInPane");
		// the launch path must send the RESOLVED command — no baked test prefix
		// masking a broken resolver (v1.4 wraps it in an argv0 ownership token).
		expect(run?.args[1]).toContain(realViewerCommand);
		await manager.stop();

		// survivor-rebind path: env prefix + the same runnable command word.
		const m2 = mockAdapter();
		m2.tabs.set("old-tab", {
			tabId: "old-tab",
			workspaceId: CTX.workspaceId,
			label: OVERVIEW_TAB_LABEL,
		});
		m2.panes.set("old-pane", {
			paneId: "old-pane",
			tabId: "old-tab",
			workspaceId: CTX.workspaceId,
		});
		const { manager: manager2 } = make({
			adapter: m2.adapter,
			viewerCommand: realViewerCommand,
		});
		await manager2.onWorkerSpawned();
		const relaunch = m2.calls.find((c) => c.method === "runInPane");
		expect(String(relaunch?.args[1])).toContain(realViewerCommand);
		await manager2.stop();
	});
});

describe("one-tab survivor regression (FR-04/FR-05, Herdr 0.9.5)", () => {
	test("pane.title is null but the tab is labeled — rebind, never a second tab", async () => {
		// Herdr 0.9.5 reports pane.title=null in session.snapshot; the overview
		// is identified ONLY by the tab label. A pane-title match never fires,
		// so the pre-fix code minted a duplicate "OMP subagents" tab per reopen.
		const m = mockAdapter();
		m.tabs.set("surv-tab", {
			tabId: "surv-tab",
			workspaceId: CTX.workspaceId,
			label: OVERVIEW_TAB_LABEL,
		});
		m.panes.set("surv-pane", {
			paneId: "surv-pane",
			tabId: "surv-tab",
			workspaceId: CTX.workspaceId,
		});
		const { manager } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		expect(m.count("createOverviewTab")).toBe(0);
		expect(manager.state()).toBe("open");
		expect(m.calls.some((c) => c.method === "runInPane" && c.args[0] === "surv-pane")).toBe(true);

		// Second reopen (viewer exit marks the view dead; the pane survives):
		// still reuses the labeled tab — exactly one "OMP subagents" tab, ever.
		m.handlers.onPaneExited?.({ workspaceId: CTX.workspaceId, paneId: "surv-pane" });
		await settle(manager);
		expect(manager.state()).toBe("closed");
		await manager.onWorkerSpawned();
		expect(m.count("createOverviewTab")).toBe(0);
		expect(manager.state()).toBe("open");
		await manager.stop();
	});

	test("duplicate labeled tabs from the earlier bug: rebind the first, mint none", async () => {
		const m = mockAdapter();
		m.tabs.set("tab-a", {
			tabId: "tab-a",
			workspaceId: CTX.workspaceId,
			label: OVERVIEW_TAB_LABEL,
		});
		m.tabs.set("tab-b", {
			tabId: "tab-b",
			workspaceId: CTX.workspaceId,
			label: OVERVIEW_TAB_LABEL,
		});
		m.panes.set("pane-a", { paneId: "pane-a", tabId: "tab-a", workspaceId: CTX.workspaceId });
		m.panes.set("pane-b", { paneId: "pane-b", tabId: "tab-b", workspaceId: CTX.workspaceId });
		const { manager, messages } = make({ adapter: m.adapter });
		await manager.onWorkerSpawned();
		expect(m.count("createOverviewTab")).toBe(0);
		expect(manager.state()).toBe("open");
		// The FIRST labeled tab's pane is rebound — extras are left to the user.
		expect(m.calls.some((c) => c.method === "runInPane" && c.args[0] === "pane-a")).toBe(true);
		expect(m.calls.some((c) => c.method === "runInPane" && c.args[0] === "pane-b")).toBe(false);
		expect(messages.some((msg) => msg.type === "notice" && msg.level === "warn")).toBe(true);
		await manager.stop();
	});
});
