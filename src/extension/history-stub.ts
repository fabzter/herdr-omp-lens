/**
 * HistorySource contract + empty stub (RC-6, D2 soft-coupling resolution).
 *
 * The extension activation path owns exactly ONE HistorySource and feeds
 * both seams: the bridge's `opts.history` (merged into every `hello`,
 * including reconnects) and topology's `onHistoryPresent` (startup
 * auto-open). Neither P2 nor P4 constructs the other's source.
 *
 * The v1 stub scans nothing and returns an empty result — P5 replaces it
 * with the real artifact-dir scan (`createHistorySource`); this file fixes
 * the interface so the P4-3 activation wiring is already settled.
 */
import type { WorkerSnapshot } from "../protocol/types";

export interface HistoryScanOptions {
	/** default 20 in the real scan */
	maxSessions?: number;
	/** default 100 in the real scan */
	maxWorkers?: number;
	/** per-transcript parse cap in the real scan */
	maxFileBytes?: number;
}

export interface HistoryScan {
	workers: WorkerSnapshot[];
	warnings: string[];
	scannedAt: number;
}

export interface HistorySource {
	scan(cwd: string, opts?: HistoryScanOptions): Promise<HistoryScan>;
}

/**
 * Empty scan — no session artifacts are read in v1 (RC-6). `scannedAt` is a
 * real timestamp so consumers can distinguish "scanned, empty" from "never
 * scanned" without an extra flag.
 */
export function createHistoryStub(): HistorySource {
	return {
		scan: () => Promise.resolve({ workers: [], warnings: [], scannedAt: Date.now() }),
	};
}
