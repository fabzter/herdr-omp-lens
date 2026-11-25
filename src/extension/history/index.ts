/**
 * History (P5) — single definition of the HistorySource contract (RC-6).
 *
 * Types moved here from `history-stub.ts` (re-exported there for
 * back-compat). The real artifact-tree scan lives in `scan.ts`.
 */
import type { WorkerSnapshot } from "../../protocol/types";

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
export {
	boundedReadFile,
	createHistorySource,
	encodeCwdSlug,
	type HistoryDeps,
} from "./scan";
