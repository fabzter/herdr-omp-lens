/**
 * Topology manager (P4): the single-flight state machine that owns the
 * viewer's place in Herdr — one no-focus "OMP subagents" overview tab,
 * optional per-worker splits, authoritative close detection, reopen on the
 * next spawn only.
 *
 * Invariants:
 * - SINGLE-FLIGHT (F-10): every transition is serialized behind one in-memory
 *   promise queue; parallel spawn signals can never double-create.
 * - NO-FOCUS (P4-R5/FR-13): only the adapter's no-focus paths are used.
 * - F-01: viewer env is `LENS_SOCKET_PATH` = the BRIDGE socket (the
 *   `bridgeSocketPath` argument), NEVER `CallerContext.socketPath` (Herdr's).
 * - FR-14: closing any view emits `topology`/`notice` only — never
 *   `worker.removed`, never a worker-side effect.
 * - Close confirm (V-HDR-3/4): `tab.closed`/`pane.closed` are hints; state is
 *   marked closed only after `snapshot()` confirms the stored ids are gone
 *   (pane.moved race). `pane.moved` rewrites stored ids.
 * - Fail-soft (P4-R11): adapter errors degrade to `notice` + "degraded";
 *   lifecycle handlers enqueue work fire-and-forget and never await I/O.
 *
 * Herdr orchestration wiring (P2 roster signals, /lens commands, activation)
 * lands in P4-2/P4-3; this file is the state machine plus its injectable
 * adapter seam.
 */

import {
	createOverviewTab,
	getPane,
	reportMetadata,
	runInPane,
	snapshot,
	splitPane,
} from "../herdr/adapter";
import type { CallerContext } from "../herdr/context";
import { subscribeLifecycle } from "../herdr/lifecycle";
import type {
	LifecycleHandlers,
	PaneInfo,
	PaneMetadata,
	SessionSnapshot,
	Subscription,
} from "../herdr/types";
import type { Message } from "../protocol/types";

export const OVERVIEW_TAB_LABEL = "OMP subagents";
export const TOPOLOGY_METADATA_SOURCE = "herdr-omp-lens";

export type TopologyState = "closed" | "opening" | "open" | "degraded";

/**
 * The Herdr surface the manager orchestrates, with `CallerContext` already
 * bound. Implemented by the default adapter below; tests inject a mock.
 */
export interface TopologyAdapter {
	createOverviewTab(
		label: string,
		env?: Record<string, string>,
	): Promise<{ tabId: string; rootPaneId: string }>;
	splitPane(
		targetPaneId: string,
		dir: "right" | "down",
		env?: Record<string, string>,
	): Promise<{ paneId: string }>;
	runInPane(paneId: string, command: string): Promise<void>;
	getPane(paneId: string): Promise<PaneInfo | null>;
	snapshot(): Promise<SessionSnapshot>;
	subscribeLifecycle(handlers: LifecycleHandlers): Promise<Subscription>;
	reportMetadata(paneId: string, meta: PaneMetadata): Promise<void>;
}

export interface TopologyDeps {
	/** Injectable adapter; defaults to the P1 Herdr adapter bound to `ctx`. */
	adapter?: TopologyAdapter;
	/**
	 * OMP session id exported to the viewer as `LENS_SESSION`. Defaults to the
	 * OMP process id until P4-2 wires the real session id.
	 */
	sessionId?: string;
}

export interface TopologyManager {
	/** "worker.spawned" — auto-open / reopen-on-next-subtask. Fail-soft. */
	onWorkerSpawned(): Promise<void>;
	/** P5 history-scan non-emptiness at activation (D2): startup auto-open. */
	onHistoryPresent?(): Promise<void>;
	/** "worker.finished" — drop that worker's split binding only (FR-14). */
	onWorkerFinished(workerId: string): void;
	/** "roster.empty" — no-op on views; closing them is the user's call. */
	onRosterEmpty?(): void;
	/** D3: invoked only by the read-only `/lens split <workerId>` command. */
	openWorkerSplit(workerId: string, dir?: "right" | "down"): Promise<{ paneId: string }>;
	state(): TopologyState;
	/** End subscription + tracking; owned panes are left to the user (Q-P4-1). */
	stop(): Promise<void>;
	/** Test seam: resolves once every queued transition has settled. */
	settle?(): Promise<void>;
}

interface OverviewRef {
	tabId: string;
	paneId: string;
}

function defaultAdapter(ctx: CallerContext): TopologyAdapter {
	return {
		createOverviewTab: (label, env) => createOverviewTab(ctx, label, env),
		splitPane: (targetPaneId, dir, env) => splitPane(ctx, targetPaneId, dir, env),
		runInPane: (paneId, command) => runInPane(ctx, paneId, command),
		getPane: (paneId) => getPane(ctx, paneId),
		snapshot: () => snapshot(ctx),
		subscribeLifecycle: (handlers) => subscribeLifecycle(ctx, handlers),
		reportMetadata: (paneId, meta) => reportMetadata(ctx, paneId, meta),
	};
}

export function createTopologyManager(
	ctx: CallerContext,
	viewerCommand: string,
	bridgeSocketPath: string,
	emit: (m: Message) => void,
	deps?: TopologyDeps,
): TopologyManager {
	const adapter = deps?.adapter ?? defaultAdapter(ctx);
	const sessionId = deps?.sessionId ?? String(process.pid);

	let state: TopologyState = "closed";
	let overview: OverviewRef | null = null;
	const splits = new Map<string, string>(); // workerId -> paneId
	let subscription: Subscription | null = null;
	let stopped = false;
	let workspaceGone = false;
	let degradedNoticeSent = false;

	// --- single-flight queue ---------------------------------------------------
	// Every transition — public API and lifecycle events alike — runs inside
	// this one queue, so check-then-act is atomic (F-10).
	let queueTail: Promise<void> = Promise.resolve();

	function enqueue<T>(fn: () => Promise<T> | T): Promise<T> {
		const run = queueTail.then(fn);
		queueTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	// --- emissions -------------------------------------------------------------
	function safeEmit(m: Message): void {
		try {
			emit(m);
		} catch {
			// a throwing bridge sink must never break the state machine (FR-12)
		}
	}

	function notice(level: "info" | "warn" | "error", message: string): void {
		safeEmit({ v: 1, type: "notice", level, message });
	}

	function emitTopology(topologyState: "open" | "closed"): void {
		safeEmit({
			v: 1,
			type: "topology",
			...(topologyState === "open" && overview !== null ? { tabId: overview.tabId } : {}),
			paneIds: [
				...(overview !== null && topologyState === "open" ? [overview.paneId] : []),
				...splits.values(),
			],
			state: topologyState,
		});
	}

	function degrade(err: unknown): void {
		state = "degraded";
		if (!degradedNoticeSent) {
			degradedNoticeSent = true;
			notice("error", `topology degraded: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	function restoreFromDegraded(): void {
		if (state === "degraded") {
			state = "closed";
			degradedNoticeSent = false;
		}
	}

	async function ensureSubscribed(): Promise<void> {
		if (stopped || workspaceGone) throw new Error("topology manager inactive");
		if (subscription === null) {
			subscription = await adapter.subscribeLifecycle(lifecycleHandlers());
		}
	}
	function viewerEnv(extra?: Record<string, string>): Record<string, string> {
		return {
			LENS_SOCKET_PATH: bridgeSocketPath,
			LENS_SESSION: sessionId,
			...extra,
		};
	}

	// --- subscription (P4-R1: before the first create) -------------------------
	function lifecycleHandlers(): LifecycleHandlers {
		const enqueueEvent = (fn: () => Promise<void>): void => {
			if (stopped) return;
			enqueue(fn).catch(() => {
				// adapter errors inside handlers degrade fail-soft, never propagate
			});
		};
		return {
			onTabClosed: (e) => {
				enqueueEvent(async () => handleTabClosed(e.tabId));
			},
			onPaneClosed: (e) => {
				enqueueEvent(async () => handlePaneClosed(e.paneId));
			},
			onPaneExited: (e) => {
				enqueueEvent(async () => handlePaneExited(e.paneId));
			},
			onPaneMoved: (e) => {
				enqueueEvent(async () => handlePaneMoved(e.previousPaneId, e.pane));
			},
			onWorkspaceClosed: (e) => {
				enqueueEvent(async () => handleWorkspaceClosed(e.workspaceId));
			},
			onEventsLost: () => {
				enqueueEvent(async () => reconcileOwned());
			},
		};
	}

	// --- transitions (always inside the queue) ---------------------------------
	/**
	 * Open-or-rebind the overview. Must run inside the queue. Throws adapter
	 * errors to the caller, who decides fail-soft vs. propagate.
	 */
	async function ensureOverviewOpen(): Promise<OverviewRef> {
		if (stopped) throw new Error("topology manager stopped");
		if (state === "open" && overview !== null) return overview;

		await ensureSubscribed(); // P4-R1: subscribe resolves before any create

		// P4-R4: authoritative reconcile before creating — covers the
		// close-before-subscribe race and a surviving pane from a previous
		// session (D2 rebind), which gets a fresh viewer + env, never a second tab.
		const snap = await adapter.snapshot();
		const survivor = snap.panes.find(
			(p) =>
				p.workspaceId === ctx.workspaceId &&
				p.title !== undefined &&
				p.title.includes(OVERVIEW_TAB_LABEL),
		);
		if (survivor !== undefined) {
			overview = { tabId: survivor.tabId, paneId: survivor.paneId };
			await adapter.runInPane(survivor.paneId, viewerCommand);
			await adapter.reportMetadata(survivor.paneId, {
				source: TOPOLOGY_METADATA_SOURCE,
				title: OVERVIEW_TAB_LABEL,
			});
			state = "open";
			degradedNoticeSent = false;
			emitTopology("open");
			return overview;
		}

		state = "opening";
		const { tabId, rootPaneId } = await adapter.createOverviewTab(OVERVIEW_TAB_LABEL, viewerEnv());
		overview = { tabId, paneId: rootPaneId };
		await adapter.runInPane(rootPaneId, viewerCommand);
		await adapter.reportMetadata(rootPaneId, {
			source: TOPOLOGY_METADATA_SOURCE,
			title: OVERVIEW_TAB_LABEL,
		});
		state = "open";
		degradedNoticeSent = false;
		emitTopology("open");
		return overview;
	}

	/** Confirm via snapshot() that none of the given pane ids still exist. */
	async function confirmedGone(paneIds: string[]): Promise<boolean> {
		const snap = await adapter.snapshot();
		const present = new Set(snap.panes.map((p) => p.paneId));
		return paneIds.every((id) => !present.has(id));
	}

	function clearOverviewClosed(): void {
		overview = null;
		splits.clear();
		state = "closed";
		emitTopology("closed");
	}

	async function handleTabClosed(tabId: string): Promise<void> {
		if (overview === null || overview.tabId !== tabId) return;
		// V-HDR-3: tab.closed is a hint — the pane may have been moved out first.
		if (!(await confirmedGone([overview.paneId, ...splits.values()]))) return;
		clearOverviewClosed();
	}

	async function handlePaneClosed(paneId: string): Promise<void> {
		if (overview !== null && overview.paneId === paneId) {
			if (!(await confirmedGone([paneId]))) return;
			clearOverviewClosed();
			return;
		}
		for (const [workerId, splitPaneId] of splits) {
			if (splitPaneId === paneId) {
				splits.delete(workerId);
				if (state === "open") emitTopology("open");
				return;
			}
		}
	}

	function handlePaneExited(paneId: string): void {
		const isOverview = overview !== null && overview.paneId === paneId;
		const isSplit = [...splits.values()].includes(paneId);
		if (!isOverview && !isSplit) return;
		// U-HDR-3/Q-P4-2: viewer process crash → notice only, no auto-relaunch.
		notice(
			"warn",
			`viewer process exited in pane ${paneId}; view stays closed until the next spawn`,
		);
	}

	function handlePaneMoved(previousPaneId: string, pane: PaneInfo): void {
		// V-HDR-3: rewrite stored ids so a later close still matches.
		if (overview !== null && overview.paneId === previousPaneId) {
			overview = { tabId: pane.tabId, paneId: pane.paneId };
			return;
		}
		for (const [workerId, splitPaneId] of splits) {
			if (splitPaneId === previousPaneId) {
				splits.set(workerId, pane.paneId);
				return;
			}
		}
	}

	function handleWorkspaceClosed(workspaceId: string): void {
		if (workspaceId !== ctx.workspaceId) return;
		if (overview === null && splits.size === 0 && state === "closed") {
			workspaceGone = true;
			return;
		}
		overview = null;
		splits.clear();
		state = "closed";
		workspaceGone = true;
		emitTopology("closed");
		notice("info", "caller workspace closed; viewer panes released");
	}

	async function reconcileOwned(): Promise<void> {
		// F-12/P4-R10: after P1's transparent resubscribe, reconcile stored ids
		// against the authoritative snapshot. Degradation recovers here.
		const snap = await adapter.snapshot();
		const present = new Set(snap.panes.map((p) => p.paneId));
		restoreFromDegraded();
		if (overview !== null && !present.has(overview.paneId)) overview = null;
		for (const [workerId, paneId] of splits) {
			if (!present.has(paneId)) splits.delete(workerId);
		}
		if (overview === null) {
			if (state !== "closed") {
				state = "closed";
				emitTopology("closed");
			}
			return;
		}
		state = "open";
		emitTopology("open");
	}

	// --- public API -------------------------------------------------------------
	async function signalEnsureOpen(): Promise<void> {
		await enqueue(async () => {
			if (stopped || workspaceGone) return;
			try {
				await ensureOverviewOpen();
			} catch (err) {
				degrade(err); // P4-R11: fail-soft — the spawn signal still flows to P2/P3
			}
		});
	}

	return {
		onWorkerSpawned: () => signalEnsureOpen(),
		onHistoryPresent: () => signalEnsureOpen(),

		onWorkerFinished(workerId: string): void {
			if (stopped) return;
			enqueue(() => {
				// FR-14: drop the binding only — never touches the worker or pane.
				if (splits.delete(workerId) && state === "open") emitTopology("open");
			}).catch(() => {});
		},

		onRosterEmpty(): void {
			// No-op on views: closing them is the user's call (spec interface note).
		},

		openWorkerSplit(workerId: string, dir: "right" | "down" = "right") {
			return enqueue(async () => {
				if (stopped || workspaceGone) {
					throw new Error("topology manager inactive");
				}
				const existing = splits.get(workerId);
				if (existing !== undefined) {
					const live = await adapter.getPane(existing);
					if (live !== null) return { paneId: existing };
					splits.delete(workerId);
				}
				const base = await ensureOverviewOpen();
				const { paneId } = await adapter.splitPane(
					base.paneId,
					dir,
					viewerEnv({ LENS_WORKER_ID: workerId }),
				);
				splits.set(workerId, paneId);
				await adapter.runInPane(paneId, viewerCommand);
				await adapter.reportMetadata(paneId, {
					source: TOPOLOGY_METADATA_SOURCE,
					title: `${OVERVIEW_TAB_LABEL} · ${workerId}`,
				});
				emitTopology("open");
				return { paneId };
			}).catch((err) => {
				// explicit command path: surface the failure; degrade only on
				// adapter errors (an inactive manager stays "closed", not degraded)
				if (!(err instanceof Error && err.message === "topology manager inactive")) {
					degrade(err);
				}
				throw err;
			});
		},

		state: () => state,

		async stop(): Promise<void> {
			if (stopped) return;
			stopped = true;
			const sub = subscription;
			subscription = null;
			await queueTail; // drain in-flight transitions before tearing down
			if (sub !== null) {
				try {
					await sub.close();
				} catch {
					// closing the event stream must never throw into OMP unload
				}
			}
		},

		settle: () => queueTail,
	};
}
