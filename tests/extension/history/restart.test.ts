import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import lensExtension, { type LensExtensionDeps, lensReady, stopLens } from "../../../src/extension";
import type {
	LensCommandDefinition,
	LensContext,
	LensExtensionApi,
	LensHookHandler,
} from "../../../src/extension/api";
import type { BridgeHandle, BridgeOptions } from "../../../src/extension/bridge";
import { createHistorySource, transcriptRefFor } from "../../../src/extension/history";
import type { Roster } from "../../../src/extension/roster";
import type { TopologyDeps, TopologyManager } from "../../../src/extension/topology";
import type { CallerContext } from "../../../src/herdr/context";
import type { Message, WorkerSnapshot } from "../../../src/protocol/types";
import { makeFixtureTree, PROJECT_CWD } from "./fixtures";

/**
 * P5-R6 restart acceptance (fixture-driven): a NEW activation in the same
 * cwd re-scans the artifact tree and surfaces prior workers through the
 * merged `hello.history` seam — marked not-live (`historical: true`), with
 * a resolvable `transcript.ref`, no `worker.spawned`, and no live duplicate.
 *
 * The real-process variant (spawn + complete a worker, kill OMP, relaunch
 * in an isolated named Herdr session) is deferred: `tests/harness/
 * isolated-session.ts` is still the P1 stub (RC-6/P4 owns it). This fixture
 * run exercises the same acceptance contract a relaunch would: fresh
 * HistorySource, empty roster, hello.history without a spawn signal.
 */

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
const tmpDirs: string[] = [];

function setEnv(vars: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(vars)) {
		if (!saved.has(key)) saved.set(key, process.env[key]);
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
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

interface FakePi {
	pi: LensExtensionApi;
	hooks: Map<string, LensHookHandler[]>;
	emitHook(event: string, payload: unknown, ctx?: LensContext): void;
}

function fakePi(): FakePi {
	const hooks = new Map<string, LensHookHandler[]>();
	const pi: LensExtensionApi = {
		registerCommand(_name: string, _definition: LensCommandDefinition) {},
		on(event, handler) {
			const list = hooks.get(event) ?? [];
			list.push(handler);
			hooks.set(event, list);
		},
		events: { on() {} }, // bus present but silent — no live frames after "restart"
	};
	return {
		pi,
		hooks,
		emitHook(event, payload, ctx) {
			for (const h of [...(hooks.get(event) ?? [])]) h(payload, ctx);
		},
	};
}

function lensCtx(sessionId: string): LensContext {
	return { sessionManager: { getSessionId: () => sessionId } };
}

interface RestartActivation {
	topoCalls: string[];
	broadcasts: Message[];
	/** The merged history seam the bridge received (per-connect callback). */
	mergedHistory: () => WorkerSnapshot[];
}

/**
 * One full activation: real startObservation + real scan against the
 * fixture tree; bridge factory is seamed to capture opts.history and
 * post-scan broadcasts; topology factory records signals.
 */
function activate(sessionsRoot: string): RestartActivation {
	setEnv(FULL_ENV);
	const fake = fakePi();
	const topoCalls: string[] = [];
	const broadcasts: Message[] = [];
	let mergedHistory: () => WorkerSnapshot[] = () => [];
	const topo: TopologyManager = {
		onWorkerSpawned: () => {
			topoCalls.push("onWorkerSpawned");
			return Promise.resolve();
		},
		onHistoryPresent: () => {
			topoCalls.push("onHistoryPresent");
			return Promise.resolve();
		},
		onWorkerFinished: () => {},
		onRosterEmpty: () => {},
		openOverview: () => Promise.resolve(),
		openWorkerSplit: () => Promise.resolve({ paneId: "p-x" }),
		state: () => "closed",
		stop: () => Promise.resolve(),
	};
	const deps: LensExtensionDeps = {
		cwd: PROJECT_CWD,
		startBridge: (_roster: Roster, o: BridgeOptions) => {
			if (o.history !== undefined) mergedHistory = o.history;
			const handle: BridgeHandle = {
				socketPath: "/restart/bridge.sock",
				broadcast: (m: Message) => broadcasts.push(m),
				viewerCount: () => 0,
				close: () => Promise.resolve(),
			};
			return Promise.resolve(handle);
		},
		history: createHistorySource({ sessionsRoot }),
		createTopologyManager: (
			_ctx: CallerContext,
			_vc: string,
			_sock: string,
			_emit: (m: Message) => void,
			_tdeps?: TopologyDeps,
		) => topo,
	};
	lensExtension(fake.pi, deps);
	fake.emitHook("session_start", {}, lensCtx("sess-relaunch"));
	return { topoCalls, broadcasts, mergedHistory };
}

describe("restart acceptance (P5-R6)", () => {
	test("new activation surfaces prior workers: not-live, transcript.ref, no spawn, no live copy", async () => {
		// Prior OMP session artifact tree (spawned + completed workers exist
		// on disk; the process itself is gone — the fixture IS the "prior run").
		const tree = makeFixtureTree();
		tmpDirs.push(tree.sessionsRoot);

		// First activation sees the tree (simulating the OMP process that
		// wrote it); tearing down closes bridge + topology like an exit.
		activate(tree.sessionsRoot);
		await lensReady();
		await stopLens();

		// Relaunch: a NEW activation (fresh source, fresh roster) same cwd.
		const rel = activate(tree.sessionsRoot);
		await lensReady();

		// No worker.spawned: topology only learned about history, never a live spawn.
		expect(rel.topoCalls).not.toContain("onWorkerSpawned");
		// D2: non-empty scan still fires the auto-open signal on relaunch.
		expect(rel.topoCalls).toContain("onHistoryPresent");

		const hist = rel.mergedHistory();
		expect(hist.map((w) => w.id).sort()).toEqual(["w1", "w2", "w3"]);
		for (const w of hist) {
			expect(w.historical).toBe(true); // marked not-live
			expect(w.counters).toBeUndefined(); // no fabricated live counters
			// transcript.ref resolvable for every persisted worker.
			const ref = transcriptRefFor(w);
			expect(ref).not.toBeNull();
			expect(ref?.type).toBe("transcript.ref");
			if (ref !== null) {
				expect(ref.id).toBe(w.id);
				expect(existsSync(ref.sessionFile)).toBe(true);
				expect(ref.artifactDir).toBeDefined();
			}
		}
		// No live copy: the roster never saw these ids (no duplicate live row).
		expect(hist.filter((w) => w.historical !== true)).toEqual([]);

		// Post-scan upserts mark every replayed worker historical — never live.
		const upserts = rel.broadcasts.filter((m) => m.type === "worker.upsert");
		expect(upserts).toHaveLength(3);
		for (const u of upserts) {
			if (u.type === "worker.upsert") expect(u.worker.historical).toBe(true);
		}
	});
});
