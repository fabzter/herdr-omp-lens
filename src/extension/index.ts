import { type CallerContext, callerContext } from "../herdr/context";
import type { Message } from "../protocol/types";
import type { LensContext, LensExtensionApi } from "./api";
import { startBridge } from "./bridge";
import { createHistorySource, mergeLiveAndHistorical } from "./history/index";
import type { HistoryScan, HistorySource } from "./history-stub";
import {
	type Observation,
	type ObservationDeps,
	type StartObservation,
	startObservation,
} from "./observe";
import { resolveViewerCommand } from "./resolve";
import { createTopologyManager, type TopologyDeps, type TopologyManager } from "./topology";

/**
 * OMP extension entry (bound via package.json `omp.extensions`).
 *
 * Herdr activation gate (FR-01): outside a Herdr pane this is a complete
 * no-op — no commands registered, no hooks or bus channels subscribed.
 * Inside Herdr it registers the read-only `/lens` commands (P4-3: `/lens`
 * opens the overview no-focus; `/lens split <workerId>` opens a
 * worker-scoped split, D3) and activates observation (P2-4): bus
 * subscriptions, roster reducer, bridge publisher, topology manager.
 *
 * Activation runs fire-and-forget off the gate's synchronous signature —
 * bus/frame handlers never await I/O on the hot path, so an OMP turn is
 * never blocked (FR-12 / F-15).
 */

export interface LensExtensionDeps extends ObservationDeps {
	/** Test seam: observation starter (default: the P2-4 wiring). */
	readonly startObservation?: StartObservation;
	/** Sink for activation failures; defaults to a bounded stderr report. */
	readonly onObservationError?: (err: unknown) => void;
	/**
	 * Test seam: the single activation-owned HistorySource (RC-6 / D2 soft
	 * coupling). Default: the real artifact-tree scan (P5) over
	 * `~/.omp/agent/sessions/<encoded-cwd>` — read-only, fail-soft.
	 */
	readonly history?: HistorySource;
	/**
	 * `omp` binary for the scan's render seam (forwarded to
	 * `createHistorySource`; default "omp").
	 */
	readonly ompBin?: string;
	/**
	 * Test seam: topology factory (default: `createTopologyManager`). The
	 * real session id and the bridge viewer probe are wired by activation.
	 */
	readonly createTopologyManager?: (
		ctx: CallerContext,
		viewerCommand: string,
		bridgeSocketPath: string,
		emit: (m: Message) => void,
		deps?: TopologyDeps,
	) => TopologyManager;
}

const defaultObservationErrorSink = (err: unknown): void => {
	try {
		console.error(`herdr-omp-lens: observation failed to start: ${String(err)}`);
	} catch {
		// A broken console must never break OMP activation.
	}
};

/**
 * Per-activation runtime. One per gate pass; commands capture it in a
 * closure so a second activation can never hijack an earlier session's
 * commands. `ensureTopology` is closed over the same structure.
 */
interface LensRuntime {
	/** Resolved observation session (observation + bridge). */
	observation?: Observation;
	/** Real OMP session id, captured from the first ctx-bearing hook/command. */
	sessionId?: string;
	/** Topology manager, created lazily once sessionId + observation exist. */
	topology?: TopologyManager;
	/** Cached latest history scan result; undefined until the scan resolves. */
	lastScan?: HistoryScan;
	/** D2: whether the scan reported non-empty workers. */
	historyPresent: boolean;
	/** D2: whether onHistoryPresent already fired for this activation. */
	historySignaled: boolean;
	stopped: boolean;
}

let runtime: LensRuntime | null = null;
let ready: Promise<void> = Promise.resolve();

export function activeObservation(): Observation | null {
	return runtime?.observation ?? null;
}

/**
 * Test seam: resolves once the activation chain has settled — observation
 * wired, roster->topology signals attached, history scan consumed.
 */
export function lensReady(): Promise<void> {
	return ready;
}

/** Tear down topology + observation + bridge; idempotent. */
export async function stopLens(): Promise<void> {
	const rt = runtime;
	if (rt === null || rt.stopped) return;
	rt.stopped = true;
	runtime = null;
	try {
		await rt.topology?.stop();
	} catch {
		// teardown must never throw into OMP unload
	}
	try {
		await rt.observation?.stop();
	} catch {
		// teardown must never throw into OMP unload
	}
}

export default function lensExtension(pi: LensExtensionApi, deps?: LensExtensionDeps): void {
	const ctx = callerContext();
	if (ctx === null) return;

	const start = deps?.startObservation ?? startObservation;
	const onError = deps?.onObservationError ?? defaultObservationErrorSink;
	const history = deps?.history ?? createHistorySource({ ompBin: deps?.ompBin ?? "omp" });
	const makeTopology = deps?.createTopologyManager ?? createTopologyManager;

	const rt: LensRuntime = { historyPresent: false, historySignaled: false, stopped: false };
	runtime = rt;

	/** The real OMP session id arrives via handler ctx — capture once. */
	const captureSession = (handlerCtx?: LensContext): void => {
		if (rt.sessionId !== undefined) return;
		const id = handlerCtx?.sessionManager?.getSessionId?.();
		if (typeof id === "string" && id !== "") rt.sessionId = id;
	};

	/**
	 * Lazily create the topology manager once the three prerequisites exist:
	 * observation (bridge), the real session id (RC-4 — no pid fallback),
	 * and this activation still live. Returns null until ready. Also fires
	 * onHistoryPresent once when a non-empty scan preceded topology creation.
	 */
	const ensureTopology = (): TopologyManager | null => {
		if (rt.stopped || rt.observation === undefined || rt.sessionId === undefined) {
			return null;
		}
		if (rt.topology === undefined) {
			rt.topology = makeTopology(
				ctx,
				resolveViewerCommand(),
				rt.observation.bridge.socketPath,
				rt.observation.bridge.broadcast,
				{
					sessionId: rt.sessionId,
					viewerCount: () => rt.observation?.bridge.viewerCount() ?? 0,
				},
			);
		}
		const topo = rt.topology;
		if (rt.historyPresent && !rt.historySignaled) {
			rt.historySignaled = true;
			void topo.onHistoryPresent?.().catch(() => {
				// topology signals degrade internally; a throwing fake must never
				// leak into a command or roster handler (FR-12).
			});
		}
		return topo;
	};

	// --- read-only commands (P4-3 / D3) -------------------------------------

	// OMP slash dispatch resolves the command name only up to the FIRST
	// literal space (docs/slash-command-internals.md §5), so `/lens split
	// <id>` arrives here as args "split <id>" — a "lens split" command name
	// can never match. The split subcommand is parsed from the arg tail.
	pi.registerCommand("lens", {
		description:
			"open the herdr-omp-lens overview (read-only, no focus); " +
			"/lens split <workerId> opens a worker-scoped split",
		handler: (args, handlerCtx) => {
			captureSession(handlerCtx);
			const topo = ensureTopology();
			if (topo === null) return;
			const tail = args.trim();
			const head = tail.split(/\s+/, 1)[0];
			if (head === "split") {
				const workerId = tail.slice(head.length).trim();
				if (workerId === "") return;
				void topo.openWorkerSplit(workerId).catch(onError);
				return;
			}
			void topo.openOverview().catch(onError);
		},
	});

	// Earliest documented ctx-bearing hook; identity capture is idempotent.
	pi.on("session_start", (_event, handlerCtx) => {
		captureSession(handlerCtx);
		ensureTopology();
	});

	// --- activation ----------------------------------------------------------

	// The activation path owns the ONE HistorySource (D2 soft coupling):
	// its merged output feeds P2's bridge `opts.history` per-viewer-connect
	// and P4's `onHistoryPresent` for the startup auto-open.
	const obsDeps: ObservationDeps = {
		cwd: deps?.cwd,
		startBridge: (roster, opts) =>
			(deps?.startBridge ?? startBridge)(roster, {
				...opts,
				history: () => mergeLiveAndHistorical(roster.snapshot(), rt.lastScan?.workers ?? []),
			}),
	};

	const wire = async (obs: Observation): Promise<void> => {
		if (rt.stopped) {
			await obs.stop().catch(() => {});
			return;
		}
		rt.observation = obs;
		obs.roster.onSignal((s) => {
			const topo = ensureTopology();
			if (topo === null) return;
			switch (s.type) {
				case "worker.spawned":
					void topo.onWorkerSpawned().catch(onError);
					break;
				case "worker.finished":
					topo.onWorkerFinished(s.id);
					break;
				case "roster.empty":
					topo.onRosterEmpty?.();
					break;
			}
		});
		ensureTopology(); // session id may already be captured
		const scan = await history.scan(deps?.cwd ?? process.cwd());
		rt.lastScan = scan;
		// D2: auto-open only when the scan actually surfaces workers — warnings
		// alone never trigger onHistoryPresent.
		rt.historyPresent = scan.workers.length > 0;
		ensureTopology(); // fires onHistoryPresent when the scan is non-empty
		if (rt.stopped) return;
		// Late-scan deltas (F-08): a viewer that connected before the scan
		// resolved gets the persisted workers as worker.upsert{historical}
		// (live-wins: ids already live in the roster are not replayed).
		const liveIds = new Set(obs.roster.snapshot().map((w) => w.id));
		for (const w of scan.workers) {
			if (w.historical === true && !liveIds.has(w.id)) {
				obs.bridge.broadcast({ v: 1, type: "worker.upsert", worker: w });
			}
		}
		// Fail-soft visibility (NFR-02): partial scan problems reach viewers
		// as exactly ONE warn notice — never one broadcast per warning.
		if (scan.warnings.length > 0) {
			obs.bridge.broadcast({
				v: 1,
				type: "notice",
				level: "warn",
				message: `history scan degraded (${scan.warnings.length} warnings): ${scan.warnings.join("; ")}`,
			});
		}
	};
	// onError rides .then's reject slot so a start rejection reports at the
	// same microtask depth the P2-4 wiring had; the trailing catch covers
	// errors thrown inside wire itself.
	ready = start(pi, ctx, obsDeps).then(wire, onError).catch(onError);
}
