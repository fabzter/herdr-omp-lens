/**
 * HistorySource contract + empty stub (RC-6, D2 soft-coupling resolution).
 *
 * The extension activation path owns exactly ONE HistorySource and feeds
 * both seams: the bridge's `opts.history` (merged into every `hello`,
 * including reconnects) and topology's `onHistoryPresent` (startup
 * auto-open). Neither P2 nor P4 constructs the other's source.
 *
 * The canonical interface definitions live in `src/extension/history`
 * (single definition — re-exported here for back-compat); the real
 * artifact-dir scan (`createHistorySource`) replaces the v1 stub in P5.
 */
import type { HistorySource } from "./history/index";

export type {
	HistoryScan,
	HistoryScanOptions,
	HistorySource,
} from "./history/index";

/**
 * Empty scan — kept for tests that need a no-op HistorySource. `scannedAt`
 * is a real timestamp so consumers can distinguish "scanned, empty" from
 * "never scanned" without an extra flag.
 */
export function createHistoryStub(): HistorySource {
	return {
		scan: () => Promise.resolve({ workers: [], warnings: [], scannedAt: Date.now() }),
	};
}
