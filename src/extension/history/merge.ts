/**
 * P5-R3/R5 — live-wins merge + transcript.ref construction.
 *
 * Pure helpers over WorkerSnapshot: no I/O, no mutation, no lease/control
 * verbs (read-only contract; `omp read history://` is never constructed).
 */
import { dirname } from "node:path";
import type { Message, WorkerSnapshot } from "../../protocol/types";

/**
 * Live is authoritative (P5-R3): any historical entry whose `id` already
 * exists in the live roster is dropped; the result is `live` (in order)
 * followed by the surviving historical entries. Inputs are never mutated.
 */
export function mergeLiveAndHistorical(
	live: WorkerSnapshot[],
	hist: WorkerSnapshot[],
): WorkerSnapshot[] {
	const liveIds = new Set(live.map((w) => w.id));
	return [...live, ...hist.filter((w) => !liveIds.has(w.id))];
}

/**
 * One transcript.ref shape for live and historical workers (RC-5);
 * `historical` on the snapshot distinguishes liveness. `artifactDir` is the
 * session artifact dir containing the worker JSONL. Returns null when the
 * snapshot carries no on-disk `sessionFile`.
 */
export function transcriptRefFor(
	w: WorkerSnapshot,
): Extract<Message, { type: "transcript.ref" }> | null {
	if (w.sessionFile === undefined) return null;
	return {
		v: 1,
		type: "transcript.ref",
		id: w.id,
		sessionFile: w.sessionFile,
		artifactDir: dirname(w.sessionFile),
	};
}
