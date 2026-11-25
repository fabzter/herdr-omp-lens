/**
 * Pure viewer state reducer (P3-R14).
 *
 * `applyMessage` folds validated P1 `Message`s into an immutable `ViewerState`;
 * the roster, selection, collapse and thinking-toggle state live here so the
 * renderer can be exercised without a TTY or bridge. It NEVER throws (NFR-02):
 * unknown or structurally-bad input returns the same state reference.
 *
 * Semantics (phase-03 spec):
 * - `hello` replaces state verbatim — workers + `history` merged into one map;
 *   history entries carry `historical:true` (RC-3) and a history-only hello
 *   marks `degraded` (D1). A second hello never merges (P3-R8).
 * - `worker.upsert` upserts; a live snapshot for a historical id replaces the
 *   not-live entry (live-wins dedupe).
 * - `worker.removed` removes; `transcript.ref` records the tail ref; unknown
 *   ids create no phantom rows (P3-R8).
 * - `notice` appends (capped); warn/error sets `degraded` (D1).
 * - `live` is false until the first hello and again after disconnect until the
 *   next hello resyncs (P3-R10).
 */
import type { Message, WorkerSnapshot, WorkerStatus } from "../protocol/types";

export interface ViewerNotice {
	level: "info" | "warn" | "error";
	message: string;
}

export interface TranscriptRef {
	sessionFile: string;
	artifactDir?: string;
}

export interface ViewerTopology {
	tabId?: string;
	paneIds: string[];
	state: "open" | "closed";
}

export interface ViewerState {
	session?: string;
	/** Includes historical entries; `historical:true` carries the not-live label. */
	workers: Map<string, WorkerSnapshot>;
	/** Default true (FR-08): finished workers collapse into one section. */
	finishedCollapsed: boolean;
	/** Default false — viewer-local toggle (D4); never fetched from OMP. */
	thinkingVisible: boolean;
	selectedId?: string;
	/** Worker-scoped mode (D3); set from LENS_WORKER_ID/--worker by the CLI. */
	scope?: { workerId?: string };
	/** Set by warn/error notice or a history-only hello (D1). */
	degraded: boolean;
	notices: ViewerNotice[];
	/** Transcript tail refs by worker id (transcript.ref frames, RC-5). */
	transcriptRefs: Map<string, TranscriptRef>;
	/** Latest topology frame; informational only in v1. */
	topology?: ViewerTopology;
	/** False after disconnect until re-hello (P3-R10). */
	live: boolean;
}

const MAX_NOTICES = 100;
const FINISHED: Record<string, true> = { completed: true, failed: true, aborted: true };

/** FR-08 collapse partition: renderer uses this; the reducer only keeps the flag. */
export function isFinishedStatus(status: WorkerStatus): boolean {
	return Object.hasOwn(FINISHED, status);
}

export function initialViewerState(init?: Partial<ViewerState>): ViewerState {
	return {
		workers: new Map(),
		finishedCollapsed: true,
		thinkingVisible: false,
		degraded: false,
		notices: [],
		transcriptRefs: new Map(),
		live: false,
		...init,
	};
}

function isMessage(m: unknown): m is Message {
	return typeof m === "object" && m !== null && "type" in m && typeof m.type === "string";
}

function withNotice(s: ViewerState, notice: ViewerNotice): ViewerState {
	const notices = s.notices.length >= MAX_NOTICES ? s.notices.slice(1) : s.notices.slice();
	notices.push(notice);
	return { ...s, notices };
}

/** Client-side fold for connection events that are not wire Messages. */
export function applyInternal(s: ViewerState, _event: { type: "disconnected" }): ViewerState {
	return { ...s, live: false };
}

function applyHello(s: ViewerState, m: Extract<Message, { type: "hello" }>): ViewerState {
	const workers = new Map<string, WorkerSnapshot>();
	for (const w of m.workers) workers.set(w.id, w);
	for (const w of m.history ?? []) {
		// Live wins: a history entry must never overwrite a live row (RC-3).
		if (workers.has(w.id)) continue;
		// hello.history entries are historical by definition; normalize the flag
		// so the not-live label never depends on the publisher remembering it.
		workers.set(w.id, w.historical === true ? w : { ...w, historical: true });
	}
	const historyOnly = m.workers.length === 0 && (m.history?.length ?? 0) > 0;
	const next: ViewerState = {
		...s,
		session: m.session,
		workers,
		live: true,
		degraded: s.degraded || historyOnly,
	};
	return next.selectedId !== undefined && !workers.has(next.selectedId)
		? { ...next, selectedId: undefined }
		: next;
}

function reduceMessage(s: ViewerState, m: Message): ViewerState {
	switch (m.type) {
		case "hello":
			return applyHello(s, m);
		case "worker.upsert": {
			const workers = new Map(s.workers);
			workers.set(m.worker.id, m.worker);
			return { ...s, workers };
		}
		case "worker.removed": {
			if (!s.workers.has(m.id)) return s;
			const workers = new Map(s.workers);
			workers.delete(m.id);
			const next: ViewerState = { ...s, workers };
			if (s.selectedId === m.id) next.selectedId = undefined;
			if (s.transcriptRefs.has(m.id)) {
				const transcriptRefs = new Map(s.transcriptRefs);
				transcriptRefs.delete(m.id);
				next.transcriptRefs = transcriptRefs;
			}
			return next;
		}
		case "transcript.ref": {
			const transcriptRefs = new Map(s.transcriptRefs);
			const ref: TranscriptRef = { sessionFile: m.sessionFile };
			if (m.artifactDir !== undefined) ref.artifactDir = m.artifactDir;
			transcriptRefs.set(m.id, ref);
			return { ...s, transcriptRefs };
		}
		case "topology": {
			const topology: ViewerTopology = { paneIds: [...m.paneIds], state: m.state };
			if (m.tabId !== undefined) topology.tabId = m.tabId;
			return { ...s, topology };
		}
		case "notice": {
			const next = withNotice(s, { level: m.level, message: m.message });
			return m.level === "info" ? next : { ...next, degraded: true };
		}
		default:
			return s;
	}
}

export function applyMessage(s: ViewerState, m: Message): ViewerState {
	if (!isMessage(m) || !shapeOk(m)) return s;
	try {
		// A known type with missing/bad fields must degrade to a no-op, never a
		// TypeError — decodeMessage is the validation boundary, this is the floor.
		return reduceMessage(s, m);
	} catch {
		return s;
	}
}

/**
 * Structural floor for a known type: the required fields must exist with the
 * right primitive shapes, else the frame is a no-op. decodeMessage is the real
 * validator; this only guarantees applyMessage NEVER mis-applies junk (NFR-02).
 */
function shapeOk(m: Message): boolean {
	switch (m.type) {
		case "hello":
			return Array.isArray(m.workers) && (m.history === undefined || Array.isArray(m.history));
		case "worker.upsert":
			return typeof m.worker === "object" && m.worker !== null && typeof m.worker.id === "string";
		case "worker.removed":
			return typeof m.id === "string";
		case "transcript.ref":
			return typeof m.id === "string" && typeof m.sessionFile === "string";
		case "topology":
			return Array.isArray(m.paneIds) && (m.state === "open" || m.state === "closed");
		case "notice":
			return (
				(m.level === "info" || m.level === "warn" || m.level === "error") &&
				typeof m.message === "string"
			);
		default:
			return false;
	}
}
