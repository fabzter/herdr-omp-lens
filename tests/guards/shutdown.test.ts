/**
 * P6-R5 / U-OMP-5 shutdown guard: OMP emits `session_shutdown` when the
 * owning session ends (verified in the installed 19.0.1 binary alongside
 * `session_start`). The lens MUST bind `stopLens` there — topology +
 * observation + bridge (socket unlink) are torn down by the session that
 * opened them, not by process-exit luck.
 *
 * The binding is fire-and-forget (F-15 / P6-R2(g)): the hook handler
 * returns undefined synchronously; teardown runs off the OMP hot path.
 */
import { afterEach, describe, expect, test } from "bun:test";
import lensExtension, { activeObservation, lensReady, stopLens } from "../../src/extension";
import type {
	LensCommandDefinition,
	LensContext,
	LensExtensionApi,
	LensHookHandler,
} from "../../src/extension/api";
import type { BridgeHandle, BridgeOptions } from "../../src/extension/bridge";
import { createHistoryStub } from "../../src/extension/history-stub";
import type { Observation, StartObservation } from "../../src/extension/observe";
import { Roster } from "../../src/extension/roster";
import type { TopologyDeps, TopologyManager } from "../../src/extension/topology";
import type { CallerContext } from "../../src/herdr/context";
import type { Message } from "../../src/protocol/types";

// --- env discipline (same pattern as tests/extension/lens-commands.test.ts) -

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
	for (const key of HERDR_VARS) {
		if (!saved.has(key)) saved.set(key, process.env[key]);
		const value = vars[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

afterEach(async () => {
	await stopLens();
	for (const [key, original] of saved) {
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
	}
	saved.clear();
});

// --- fake pi: records hook registrations so handlers stay invocable --------

interface FakePi {
	pi: LensExtensionApi;
	commands: Map<string, LensCommandDefinition>;
	hooks: Map<string, LensHookHandler[]>;
}

function fakePi(): FakePi {
	const commands = new Map<string, LensCommandDefinition>();
	const hooks = new Map<string, LensHookHandler[]>();
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
			on(_channel, _handler) {},
		},
	};
	return { pi, commands, hooks };
}

function lensCtx(sessionId: string): LensContext {
	return { sessionManager: { getSessionId: () => sessionId } };
}

/** Invoke every registered handler for `event`; returns their return values. */
function emitHook(fake: FakePi, event: string, payload: unknown, ctx?: LensContext): unknown[] {
	return (fake.hooks.get(event) ?? []).map((h) => h(payload, ctx));
}

// --- fakes -----------------------------------------------------------------

function fakeBridge(): BridgeHandle & { sent: Message[] } {
	const sent: Message[] = [];
	return {
		socketPath: "/bridge/sess.sock",
		sent,
		broadcast(m: Message) {
			sent.push(m);
		},
		viewerCount() {
			return 0;
		},
		close: () => Promise.resolve(),
	};
}

interface FakeTopology {
	manager: TopologyManager;
	stopCalls: number;
}

function fakeTopology(): FakeTopology {
	const fake: FakeTopology = {
		stopCalls: 0,
		manager: {
			onWorkerSpawned: () => Promise.resolve(),
			onHistoryPresent: () => Promise.resolve(),
			onWorkerFinished: () => {},
			onRosterEmpty: () => {},
			openOverview: () => Promise.resolve(),
			openWorkerSplit: () => Promise.resolve({ paneId: "p-x" }),
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
	topo: FakeTopology;
	topologyCreates: number;
}

function activate(): Harness {
	setEnv(FULL_ENV);
	const fake = fakePi();
	const roster = new Roster();
	const observationStopCalls = { count: 0 };
	const observation: Observation = {
		roster,
		bridge: fakeBridge(),
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
		topo,
		topologyCreates: 0,
	};
	const startObservation: StartObservation = (_pi, _ctx, _deps) => Promise.resolve(observation);
	lensExtension(fake.pi, {
		startObservation,
		startBridge: (_r: Roster, _o: BridgeOptions) => Promise.resolve(observation.bridge),
		history: createHistoryStub(),
		createTopologyManager: (
			_ctx: CallerContext,
			_viewerCommand: string,
			_bridgeSocketPath: string,
			_emit: (m: Message) => void,
			_deps?: TopologyDeps,
		) => {
			harness.topologyCreates++;
			return topo.manager;
		},
	});
	return harness;
}

/** Let the fire-and-forget stopLens() chain run past its awaits. */
async function flushTeardown(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
	await Promise.resolve();
}

// --- the guard --------------------------------------------------------------

describe("session_shutdown → stopLens (P6-R5)", () => {
	test("the session_shutdown hook is registered", () => {
		const h = activate();
		expect(h.fake.hooks.has("session_shutdown")).toBe(true);
		expect(h.fake.hooks.get("session_shutdown")?.length).toBe(1);
	});

	test("session_shutdown tears down topology + observation, synchronously from the handler", async () => {
		const h = activate();
		emitHook(h.fake, "session_start", {}, lensCtx("sess-shut-1"));
		await lensReady();
		expect(h.topologyCreates).toBe(1);

		// Fire-and-forget: the handler itself returns undefined, the async
		// teardown runs off the OMP hot path (P6-R2(g) invariant).
		const returns = emitHook(h.fake, "session_shutdown", { type: "session_shutdown" });
		for (const r of returns) {
			expect(r).toBeUndefined();
			expect(r instanceof Promise).toBe(false);
		}

		await flushTeardown();
		expect(h.topo.stopCalls).toBe(1);
		expect(h.observationStopCalls.count).toBe(1);
		expect(activeObservation()).toBeNull();
	});

	test("session_shutdown before the session id arrives still stops the observation", async () => {
		const h = activate();
		// No session_start yet: topology never existed, but the in-flight
		// observation MUST still be torn down (wire() stops a late observation).
		emitHook(h.fake, "session_shutdown", { type: "session_shutdown" });
		await lensReady();
		await flushTeardown();
		expect(h.topologyCreates).toBe(0);
		expect(h.topo.stopCalls).toBe(0);
		expect(h.observationStopCalls.count).toBe(1);
		expect(activeObservation()).toBeNull();
	});

	test("session_shutdown is idempotent — a second emit stops nothing twice", async () => {
		const h = activate();
		emitHook(h.fake, "session_start", {}, lensCtx("sess-shut-2"));
		await lensReady();
		emitHook(h.fake, "session_shutdown", { type: "session_shutdown" });
		emitHook(h.fake, "session_shutdown", { type: "session_shutdown" });
		await flushTeardown();
		expect(h.topo.stopCalls).toBe(1);
		expect(h.observationStopCalls.count).toBe(1);
	});
});
