/**
 * Direct-workers-only roster reducer (P2-2).
 *
 * Reduces validated `task:subagent:*` bus frames + `before_subagent_spawn`
 * hooks into P1 `WorkerSnapshot`s (spec P2-R3/R4/R10):
 *
 * - FR-10 / RC-10 (safety invariant): `applySpawn` records `spawnKey` (== the
 *   worker id) in the direct-id set. The hook fires only for direct spawns, so
 *   frames whose id is absent — nested workers (depth >= 2) and other
 *   sessions' workers — are ignored and can never enter the roster.
 * - A worker joins the roster on its first lifecycle/progress/event frame and
 *   leaves on its terminal transition: `snapshot()` is live-only (P5 merges
 *   history separately).
 * - Status mapping: `started` -> `running` (`queued` when a pre-start frame
 *   arrived first); `progress.status` is authoritative while live; the first
 *   terminal status (`completed`/`failed`/`aborted`) wins and sticks;
 *   `idle`/`parked` map verbatim; unrecognized strings keep the last known
 *   status and emit a notice.
 * - Signals (P2-R10 / RC-1): `worker.spawned` on EVERY roster add (not just the
 *   first), `worker.finished` with the final snapshot on terminal transition,
 *   `roster.empty` when the last worker leaves.
 *
 * Fire-and-forget (FR-12): every method is synchronous and performs no I/O;
 * subscriber exceptions are swallowed into notices so a bad consumer can never
 * break the bus handler or an OMP turn.
 */
import type { WorkerSnapshot, WorkerStatus } from "../protocol/types";
import type {
	SubagentEvent,
	SubagentLifecycle,
	SubagentProgress,
	SubagentSpawn,
} from "./observe/schemas";

export type RosterSignal =
	| { type: "worker.spawned"; worker: WorkerSnapshot }
	| { type: "worker.finished"; id: string; worker: WorkerSnapshot }
	| { type: "roster.empty" };

const TERMINAL_STATUSES: Record<string, true> = {
	completed: true,
	failed: true,
	aborted: true,
};

/** Observed status vocabulary -> WorkerStatus (P2-R4 mapping table). */
const STATUS_MAP: Record<string, WorkerStatus> = {
	started: "running",
	queued: "queued",
	running: "running",
	idle: "idle",
	parked: "parked",
	completed: "completed",
	failed: "failed",
	aborted: "aborted",
};

type ProgressInner = SubagentProgress["progress"];

function mergeCounters(
	existing: WorkerSnapshot["counters"],
	p: ProgressInner,
): WorkerSnapshot["counters"] {
	const c: NonNullable<WorkerSnapshot["counters"]> = { ...existing };
	let touched = false;
	if (p.tokens !== undefined) {
		c.tokens = p.tokens;
		touched = true;
	}
	if (p.cost !== undefined) {
		c.cost = p.cost;
		touched = true;
	}
	if (p.requests !== undefined) {
		c.requests = p.requests;
		touched = true;
	}
	if (p.toolCount !== undefined) {
		c.toolCount = p.toolCount;
		touched = true;
	}
	if (p.durationMs !== undefined) {
		c.durationMs = p.durationMs;
		touched = true;
	}
	return touched ? c : existing;
}

/** Latest output line wins; otherwise the last tool name; otherwise leave unset. */
function deriveActivity(p: ProgressInner): string | undefined {
	const lastOutput = p.recentOutput?.at(-1);
	if (lastOutput !== undefined) return lastOutput;
	const lastTool = p.recentTools?.at(-1);
	if (lastTool !== undefined) return lastTool.tool;
	return undefined;
}

function copySnapshot(w: WorkerSnapshot): WorkerSnapshot {
	const copy: WorkerSnapshot = { ...w };
	if (w.counters !== undefined) copy.counters = { ...w.counters };
	return copy;
}

export class Roster {
	/** FR-10 direct-id set: populated ONLY by `before_subagent_spawn.spawnKey`. */
	private readonly directIds = new Set<string>();
	private readonly workers = new Map<string, WorkerSnapshot>();
	/** Ids that already reached a terminal status; late frames must not resurrect them. */
	private readonly finishedIds = new Set<string>();
	/** Spawn-hook metadata used to seed a worker before richer frames arrive. */
	private readonly spawnMeta = new Map<string, { agent: string; modelRole?: string }>();

	private readonly changeCbs: Array<(w: WorkerSnapshot) => void> = [];
	private readonly signalCbs: Array<(s: RosterSignal) => void> = [];
	private readonly noticeCbs: Array<(message: string) => void> = [];
	private readonly noticeLog: string[] = [];

	/** RC-10: extends the direct-id set; does not itself create a roster entry. */
	applySpawn(f: SubagentSpawn): void {
		this.directIds.add(f.spawnKey);
		const meta: { agent: string; modelRole?: string } = { agent: f.agent };
		if (f.modelRole !== undefined) meta.modelRole = f.modelRole;
		this.spawnMeta.set(f.spawnKey, meta);
	}

	applyLifecycle(f: SubagentLifecycle): void {
		const entry = this.ensure(f.id, f.agent, "queued");
		if (entry === undefined) return;
		const { worker, isNew } = entry;
		worker.agent = f.agent;
		if (f.parentToolCallId !== undefined) worker.parentToolCallId = f.parentToolCallId;
		if (f.index !== undefined) worker.index = f.index;
		if (f.sessionFile !== undefined) worker.sessionFile = f.sessionFile;
		this.applyStatus(worker, f.status, "lifecycle");
		this.touch(worker, isNew);
	}

	applyProgress(f: SubagentProgress): void {
		const p = f.progress;
		const entry = this.ensure(p.id, f.agent, "running");
		if (entry === undefined) return;
		const { worker, isNew } = entry;
		if (f.agent !== undefined) worker.agent = f.agent;
		if (f.parentToolCallId !== undefined) worker.parentToolCallId = f.parentToolCallId;
		if (f.index !== undefined) worker.index = f.index;
		if (f.assignment !== undefined) worker.assignment = f.assignment;
		if (f.sessionFile !== undefined) worker.sessionFile = f.sessionFile;
		if (p.resolvedModelIdentity !== undefined) worker.model = p.resolvedModelIdentity;
		if (p.modelRole !== undefined) worker.modelRole = p.modelRole;
		if (p.resolvedThinkingLevel !== undefined) worker.thinkingLevel = p.resolvedThinkingLevel;
		const counters = mergeCounters(worker.counters, p);
		if (counters !== undefined) worker.counters = counters;
		const activity = deriveActivity(p);
		if (activity !== undefined) worker.activity = activity;
		this.applyStatus(worker, p.status, "progress");
		this.touch(worker, isNew);
	}

	/** Activity bookkeeping only; no transcript bytes cross this boundary. */
	applyEvent(f: SubagentEvent): void {
		const entry = this.ensure(f.id, undefined, "queued");
		if (entry === undefined) return;
		const { worker, isNew } = entry;
		if (worker.activity === undefined) worker.activity = f.event.type;
		this.touch(worker, isNew);
	}

	/** Live workers only; finished workers are removed (P5 merges history). */
	snapshot(): WorkerSnapshot[] {
		return [...this.workers.values()].map(copySnapshot);
	}

	/** Accumulated notices (e.g. unrecognized status strings). */
	notices(): string[] {
		return [...this.noticeLog];
	}

	onChange(cb: (w: WorkerSnapshot) => void): void {
		this.changeCbs.push(cb);
	}

	onSignal(cb: (s: RosterSignal) => void): void {
		this.signalCbs.push(cb);
	}

	onNotice(cb: (message: string) => void): void {
		this.noticeCbs.push(cb);
	}

	/**
	 * Returns the live worker plus whether it was just created, or undefined
	 * when the id is outside the direct-id set or already finished.
	 */
	private ensure(
		id: string,
		agent: string | undefined,
		defaultStatus: WorkerStatus,
	): { worker: WorkerSnapshot; isNew: boolean } | undefined {
		if (!this.directIds.has(id) || this.finishedIds.has(id)) return undefined;
		const existing = this.workers.get(id);
		if (existing !== undefined) return { worker: existing, isNew: false };
		const meta = this.spawnMeta.get(id);
		const worker: WorkerSnapshot = {
			id,
			agent: agent ?? meta?.agent ?? "",
			status: defaultStatus,
			updatedAt: Date.now(),
		};
		if (meta?.modelRole !== undefined) worker.modelRole = meta.modelRole;
		this.workers.set(id, worker);
		return { worker, isNew: true };
	}

	private applyStatus(worker: WorkerSnapshot, status: string, source: string): void {
		const mapped = STATUS_MAP[status];
		if (mapped === undefined) {
			this.notice(
				`worker ${worker.id}: unrecognized ${source} status "${status}"; keeping "${worker.status}"`,
			);
			return;
		}
		// Terminal lifecycle wins: once terminal, the status is frozen.
		if (TERMINAL_STATUSES[worker.status] === true) return;
		worker.status = mapped;
	}

	private touch(worker: WorkerSnapshot, isNew: boolean): void {
		worker.updatedAt = Date.now();
		const snap = copySnapshot(worker);
		if (isNew) this.emitSignal({ type: "worker.spawned", worker: snap });
		this.emitChange(snap);
		if (TERMINAL_STATUSES[worker.status] === true) {
			this.finishedIds.add(worker.id);
			this.workers.delete(worker.id);
			this.emitSignal({ type: "worker.finished", id: worker.id, worker: snap });
			if (this.workers.size === 0) this.emitSignal({ type: "roster.empty" });
		}
	}

	private emitChange(w: WorkerSnapshot): void {
		for (const cb of this.changeCbs) {
			try {
				cb(w);
			} catch (err) {
				this.notice(
					`onChange subscriber threw: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}

	private emitSignal(s: RosterSignal): void {
		for (const cb of this.signalCbs) {
			try {
				cb(s);
			} catch (err) {
				this.notice(
					`onSignal subscriber threw: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}

	private notice(message: string): void {
		this.noticeLog.push(message);
		for (const cb of this.noticeCbs) {
			try {
				cb(message);
			} catch {
				// A throwing notice subscriber must never break the reducer.
			}
		}
	}
}
