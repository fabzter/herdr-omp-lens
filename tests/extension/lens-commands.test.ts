import { afterEach, describe, expect, test } from "bun:test";
import lensExtension, { lensReady, stopLens } from "../../src/extension";
import type {
	LensCommandDefinition,
	LensContext,
	LensExtensionApi,
	LensHookHandler,
} from "../../src/extension/api";
import type { BridgeHandle, BridgeOptions } from "../../src/extension/bridge";
import type { HistorySource } from "../../src/extension/history-stub";
import type { Observation, ObservationDeps, StartObservation } from "../../src/extension/observe";
import type { SubagentLifecycle } from "../../src/extension/observe/schemas";
import { Roster } from "../../src/extension/roster";
import type { TopologyDeps, TopologyManager } from "../../src/extension/topology";
import type { CallerContext } from "../../src/herdr/context";
import type { Message, WorkerSnapshot } from "../../src/protocol/types";

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

const saved = new Map<string, string | undefined>();

function setEnv(vars: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(vars)) {
		if (!saved.has(key)) saved.set(key, process.env[key]);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

afterEach(async () => {
	await stopLens();
	for (const [key, original] of saved) {
		if (original === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = original;
		}
	}
	saved.clear();
});

/** Structural stub of the OMP extension surface — records, never invokes. */
interface FakePi {
	pi: LensExtensionApi;
	commands: Map<string, LensCommandDefinition>;
	hooks: Map<string, LensHookHandler[]>;
	busSubs: string[];
}

function fakePi(): FakePi {
	const commands = new Map<string, LensCommandDefinition>();
	const hooks = new Map<string, LensHookHandler[]>();
	const busSubs: string[] = [];
	const pi: LensExtensionApi = {
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		on(event, handler) {
			const list = hooks.get(event) ?? [];
			list.push(handler);
			hooks.set(event, list);
		},
		events: {
			on(channel) {
				busSubs.push(channel);
			},
		},
	};
	return { pi, commands, hooks, busSubs };
}

/** Minimal structural OMP handler ctx exposing the real session id. */
function lensCtx(sessionId: string): LensContext {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
		},
	};
}

function invokeCommand(fake: FakePi, name: string, args: string, ctx?: LensContext): void {
	const def = fake.commands.get(name);
	if (def === undefined) throw new Error(`command ${name} not registered`);
	def.handler(args, ctx);
}

function emitHook(fake: FakePi, event: string, payload: unknown, ctx?: LensContext): void {
	for (const handler of fake.hooks.get(event) ?? []) {
		handler(payload, ctx);
	}
}

function fakeBridge(viewerCountValue = 0): BridgeHandle & { sent: Message[] } {
	const sent: Message[] = [];
	return {
		socketPath: "/bridge/sess.sock",
		sent,
		broadcast(m: Message) {
			sent.push(m);
		},
		viewerCount() {
			return viewerCountValue;
		},
		close: () => Promise.resolve(),
	};
}

interface TopologyCreated {
	ctx: CallerContext;
	viewerCommand: string;
	bridgeSocketPath: string;
	emit: (m: Message) => void;
	deps?: TopologyDeps;
}

interface FakeTopology {
	manager: TopologyManager;
	calls: string[];
	splits: { workerId: string; dir?: "right" | "down" }[];
	stopCalls: number;
}

function fakeTopology(): FakeTopology {
	const fake: FakeTopology = {
		calls: [],
		splits: [],
		stopCalls: 0,
		manager: {
			onWorkerSpawned: () => {
				fake.calls.push("onWorkerSpawned");
				return Promise.resolve();
			},
			onHistoryPresent: () => {
				fake.calls.push("onHistoryPresent");
				return Promise.resolve();
			},
			onWorkerFinished: (workerId: string) => {
				fake.calls.push(`onWorkerFinished:${workerId}`);
			},
			onRosterEmpty: () => {
				fake.calls.push("onRosterEmpty");
			},
			openOverview: () => {
				fake.calls.push("openOverview");
				return Promise.resolve();
			},
			openWorkerSplit: (workerId: string, dir?: "right" | "down") => {
				fake.splits.push({ workerId, dir });
				return Promise.resolve({ paneId: `p-${workerId}` });
			},
			state: () => "closed",
			stop: () => {
				fake.stopCalls++;
				return Promise.resolve();
			},
		},
	};
	return fake;
}

interface Harness {
	fake: FakePi;
	observation: Observation;
	observationStopCalls: { count: number };
	created: TopologyCreated[];
	topo: FakeTopology;
	capturedObsDeps?: ObservationDeps;
	bridgeFactoryCalls: BridgeOptions[];
}

/**
 * Drive the full activation: lensExtension under the Herdr env with a stub
 * observation, a recording topology factory, and the given history source.
 */
function activate(opts: { history?: HistorySource; viewerCount?: number }): Harness {
	setEnv(FULL_ENV);
	const fake = fakePi();
	const bridge = fakeBridge(opts.viewerCount ?? 0);
	const roster = new Roster();
	const observationStopCalls = { count: 0 };
	const observation: Observation = {
		roster,
		bridge,
		stop: () => {
			observationStopCalls.count++;
			return Promise.resolve();
		},
	};
	const topo = fakeTopology();
	const harness: Harness = {
		fake,
		observation,
		observationStopCalls,
		created: [],
		topo,
		bridgeFactoryCalls: [],
	};
	const startObservation: StartObservation = (_pi, _ctx, deps) => {
		harness.capturedObsDeps = deps;
		return Promise.resolve(observation);
	};
	const baseStartBridge = (_roster: Roster, o: BridgeOptions): Promise<BridgeHandle> => {
		harness.bridgeFactoryCalls.push(o);
		return Promise.resolve(bridge);
	};
	lensExtension(fake.pi, {
		startObservation,
		startBridge: baseStartBridge,
		history: opts.history,
		createTopologyManager: (ctx, viewerCommand, bridgeSocketPath, emit, deps) => {
			harness.created.push({ ctx, viewerCommand, bridgeSocketPath, emit, deps });
			return topo.manager;
		},
	});
	return harness;
}

function lifecycle(id: string, status: string): SubagentLifecycle {
	return { id, agent: "scout", status };
}

function spawn(id: string): Parameters<Roster["applySpawn"]>[0] {
	return { type: "before_subagent_spawn", agent: "scout", spawnKey: id };
}

const HISTORY_WORKER: WorkerSnapshot = {
	id: "old-1",
	agent: "scout",
	status: "completed",
	historical: true,
	updatedAt: 1,
};

const FALLBACK_WORKER: WorkerSnapshot = {
	id: "fallback-1",
	agent: "scout",
	status: "queued",
	updatedAt: 1,
};

function historySource(
	scan: () => Promise<{
		workers: WorkerSnapshot[];
		warnings: string[];
		scannedAt: number;
	}>,
): HistorySource {
	return { scan };
}

describe("lens gate — outside Herdr", () => {
	test("no commands or hooks register without the Herdr env", () => {
		setEnv(Object.fromEntries(HERDR_VARS.map((k) => [k, undefined])));
		const fake = fakePi();
		lensExtension(fake.pi);
		expect(fake.commands.size).toBe(0);
		expect(fake.hooks.size).toBe(0);
		expect(fake.busSubs).toHaveLength(0);
	});
});

describe("/lens commands", () => {
	test("registers a single /lens command plus the session_start capture hook", () => {
		const h = activate({});
		expect(h.fake.commands.has("lens")).toBe(true);
		// Host dispatch splits the name at the FIRST literal space
		// (docs/slash-command-internals.md §5): a "lens split" name is
		// unreachable — the split subcommand must live inside /lens.
		expect(h.fake.commands.has("lens split")).toBe(false);
		expect([...h.fake.commands.keys()]).toEqual(["lens"]);
		expect(h.fake.hooks.has("session_start")).toBe(true);
	});

	test("/lens opens the overview read-only; topology gets the real session id", async () => {
		const h = activate({});
		emitHook(h.fake, "session_start", {}, lensCtx("sess-real-1"));
		await lensReady();
		invokeCommand(h.fake, "lens", "", lensCtx("sess-real-1"));
		expect(h.topo.calls).toContain("openOverview");
		expect(h.created).toHaveLength(1);
		const created = h.created[0];
		expect(created?.deps?.sessionId).toBe("sess-real-1");
		expect(created?.deps?.sessionId).not.toBe(String(process.pid));
		expect(created?.bridgeSocketPath).toBe("/bridge/sess.sock");
		expect(created?.viewerCommand.endsWith("viewer/cli.ts")).toBe(true);
	});

	test("/lens is a no-op until the session id is known", async () => {
		const h = activate({});
		await lensReady();
		invokeCommand(h.fake, "lens", "");
		expect(h.created).toHaveLength(0);
		expect(h.topo.calls).toHaveLength(0);
	});

	test("/lens with unknown args still opens the overview (read-only)", async () => {
		const h = activate({});
		emitHook(h.fake, "session_start", {}, lensCtx("sess-1"));
		await lensReady();
		invokeCommand(h.fake, "lens", "open", lensCtx("sess-1"));
		invokeCommand(h.fake, "lens", "bogus-thing", lensCtx("sess-1"));
		expect(h.topo.calls.filter((c) => c === "openOverview")).toHaveLength(2);
		expect(h.topo.splits).toHaveLength(0);
	});

	test("/lens split <id> dispatches through the lens handler to openWorkerSplit", async () => {
		const h = activate({});
		emitHook(h.fake, "session_start", {}, lensCtx("sess-1"));
		await lensReady();
		// Host-equivalent dispatch: name "lens", args tail "split w-42".
		invokeCommand(h.fake, "lens", "split w-42", lensCtx("sess-1"));
		expect(h.topo.splits).toEqual([{ workerId: "w-42", dir: undefined }]);
		expect(h.topo.calls).not.toContain("openOverview");
	});

	test("/lens split without an id does nothing", async () => {
		const h = activate({});
		emitHook(h.fake, "session_start", {}, lensCtx("sess-1"));
		await lensReady();
		invokeCommand(h.fake, "lens", "split", lensCtx("sess-1"));
		invokeCommand(h.fake, "lens", "split   ", lensCtx("sess-1"));
		expect(h.topo.splits).toHaveLength(0);
		expect(h.topo.calls).toHaveLength(0);
	});

	test("commands create the topology at most once and stay read-only", async () => {
		const h = activate({});
		emitHook(h.fake, "session_start", {}, lensCtx("sess-1"));
		await lensReady();
		invokeCommand(h.fake, "lens", "", lensCtx("sess-1"));
		invokeCommand(h.fake, "lens", "split w-1", lensCtx("sess-1"));
		invokeCommand(h.fake, "lens", "", lensCtx("sess-1"));
		expect(h.created).toHaveLength(1);
		expect(h.topo.calls.filter((c) => c === "openOverview")).toHaveLength(2);
		expect(h.topo.splits).toHaveLength(1);
	});
});

describe("activation wiring", () => {
	test("viewerCount probe is wired to the bridge authed-client count", async () => {
		const h = activate({ viewerCount: 3 });
		emitHook(h.fake, "session_start", {}, lensCtx("sess-1"));
		await lensReady();
		invokeCommand(h.fake, "lens", "", lensCtx("sess-1"));
		expect(h.created[0]?.deps?.viewerCount?.()).toBe(3);
	});

	test("roster signals drive the topology manager", async () => {
		const h = activate({});
		emitHook(h.fake, "session_start", {}, lensCtx("sess-1"));
		await lensReady();

		h.observation.roster.applySpawn(spawn("w1"));
		h.observation.roster.applyLifecycle(lifecycle("w1", "started"));
		expect(h.topo.calls).toContain("onWorkerSpawned");

		h.observation.roster.applyLifecycle(lifecycle("w1", "completed"));
		expect(h.topo.calls).toContain("onWorkerFinished:w1");
		expect(h.topo.calls).toContain("onRosterEmpty");
	});

	test("the single HistorySource feeds the bridge opts.history seam", async () => {
		const h = activate({
			history: historySource(() =>
				Promise.resolve({ workers: [HISTORY_WORKER], warnings: [], scannedAt: 1 }),
			),
		});
		const startBridgeFn = h.capturedObsDeps?.startBridge;
		if (startBridgeFn === undefined) {
			throw new Error("activation must hand a wrapped startBridge to observation");
		}
		// Before the scan lands, the merged callback defers to the caller's history.
		await startBridgeFn(new Roster(), { history: () => [FALLBACK_WORKER] });
		expect(h.bridgeFactoryCalls[0]?.history?.()).toEqual([FALLBACK_WORKER]);

		await lensReady(); // scan consumed deterministically
		await startBridgeFn(new Roster(), { history: () => [FALLBACK_WORKER] });
		expect(h.bridgeFactoryCalls[1]?.history?.()).toEqual([HISTORY_WORKER]);
	});

	test("non-empty history scan triggers onHistoryPresent (D2 auto-open)", async () => {
		const h = activate({
			history: historySource(() =>
				Promise.resolve({ workers: [HISTORY_WORKER], warnings: [], scannedAt: 1 }),
			),
		});
		emitHook(h.fake, "session_start", {}, lensCtx("sess-1"));
		await lensReady();
		expect(h.topo.calls).toContain("onHistoryPresent");
	});

	test("empty history scan does not auto-open", async () => {
		const h = activate({});
		emitHook(h.fake, "session_start", {}, lensCtx("sess-1"));
		await lensReady();
		expect(h.topo.calls).not.toContain("onHistoryPresent");
	});
});

describe("stopLens teardown", () => {
	test("stops the topology and the observation, idempotent", async () => {
		const h = activate({});
		emitHook(h.fake, "session_start", {}, lensCtx("sess-1"));
		await lensReady();
		invokeCommand(h.fake, "lens", "", lensCtx("sess-1"));
		await stopLens();
		expect(h.topo.stopCalls).toBe(1);
		expect(h.observationStopCalls.count).toBe(1);
		await stopLens();
		expect(h.topo.stopCalls).toBe(1);
		expect(h.observationStopCalls.count).toBe(1);
	});
});
