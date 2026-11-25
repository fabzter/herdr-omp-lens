/**
 * P5-R1 artifact-tree scan — layout detection + direct-only mapping.
 *
 * Verified layout (probe 2026-11-24):
 *   <sessionsRoot>/<encoded-cwd>/<ts>_<sessionId>/<workerId>.jsonl
 * where sessionsRoot = ~/.omp/agent/sessions and encoded-cwd is the
 * absolute cwd with every "/" replaced by "-".
 *
 * Read-only and fail-soft (NFR-02): absent/unreadable dirs, torn lines and
 * unparseable files degrade to warnings inside a partial result — the scan
 * never throws into an OMP turn. No lease, no `omp read history://`.
 */
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { WorkerSnapshot, WorkerStatus } from "../../protocol/types";
import type { HistorySource } from "./index";

/** <ISO-timestamp>_<uuid> session dir name. */
const SESSION_DIR_RE = /^\d{4}-.*Z_[0-9a-f-]+$/;
/** Top-level parent session transcript name: <ts>_<parentSessionId>.jsonl. */
const PARENT_SESSION_FILE_RE = /^\d{4}-.*Z_[^/]+\.jsonl$/;

const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_MAX_WORKERS = 100;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;

export interface HistoryDeps {
	/** default: ~/.omp/agent/sessions */
	sessionsRoot?: string;
	/** reserved for Task 2+ (`omp render` invocation); unused by the scan. */
	ompBin?: string;
	/** clock seam for deterministic `scannedAt` (default: Date.now). */
	now?: () => number;
	readDir?: (path: string) => Promise<string[]>;
	/** Transcript reader; `maxBytes` bounds the I/O when provided. */
	readFile?: (path: string, encoding: "utf8", maxBytes?: number) => Promise<string>;
	/** End-of-file reader for the terminal-marker window (default boundedTailReadFile). */
	readFileTail?: (path: string, encoding: "utf8", maxBytes?: number) => Promise<string>;
	stat?: (path: string) => Promise<{ mtimeMs: number; size?: number; isDirectory(): boolean }>;
}

/** Absolute cwd with every "/" replaced by "-" (verified 2026-11-24). */
export function encodeCwdSlug(cwd: string): string {
	return cwd.replaceAll("/", "-");
}
/**
 * Default read seam: reads at most `maxBytes` bytes via fs.open/read, then
 * utf8-decodes (a truncated multibyte tail is replaced by U+FFFD). Bounds
 * both I/O and peak memory — `readFile` alone would load the whole
 * transcript before the char-level slice ever ran (P5-R8 / NFR-03).
 */
export async function boundedReadFile(
	path: string,
	_encoding: "utf8",
	maxBytes: number,
): Promise<string> {
	if (maxBytes <= 0) return "";
	const fh = await open(path, "r");
	try {
		const buf = Buffer.allocUnsafe(maxBytes);
		const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
		return buf.subarray(0, bytesRead).toString("utf8");
	} finally {
		await fh.close();
	}
}

/**
 * Tail counterpart of `boundedReadFile`: reads at most `maxBytes` bytes from
 * the END of the file (position `size - maxBytes` via fh.read), utf8-decoded.
 * Needed because the verified `session_exit` terminal marker is the LAST
 * line — a head-only read truncates it away on transcripts > cap and
 * mislabels completed workers as aborted (P5-R4, review round 1).
 */
export async function boundedTailReadFile(
	path: string,
	_encoding: "utf8",
	maxBytes: number,
): Promise<string> {
	if (maxBytes <= 0) return "";
	const fh = await open(path, "r");
	try {
		const { size } = await fh.stat();
		const pos = Math.max(0, size - maxBytes);
		const buf = Buffer.allocUnsafe(Math.min(maxBytes, size));
		const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
		return buf.subarray(0, bytesRead).toString("utf8");
	} finally {
		await fh.close();
	}
}

interface SessionHeader {
	type?: unknown;
	id?: unknown;
	parentSession?: unknown;
}

interface ModelChange {
	type?: unknown;
	model?: unknown;
	role?: unknown;
}

/**
 * Direct-only filter (FR-10): `parentSession` must point at a TOP-LEVEL
 * session transcript `<projectDir>/<ts>_<parentSessionId>.jsonl` — never a
 * worker JSONL nested inside a session subdir.
 */
function isDirectWorker(parentSession: string, projectDir: string): boolean {
	if (dirname(parentSession) !== projectDir) return false;
	return PARENT_SESSION_FILE_RE.test(basename(parentSession));
}

/**
 * P5-R4 honest status mapping. Scans raw JSONL lines from the end for the
 * verified terminal marker
 * `{type:"custom",customType:"session_exit",data:{kind,reason,recordedAt}}`:
 * `kind:"normal"` -> completed, `kind:"signal"` -> aborted, `kind:"error"`/
 * `"failed"` -> failed, no marker -> aborted (the session ended mid-run).
 * Torn/malformed lines are skipped; the LAST terminal marker wins. Never
 * throws (NFR-02).
 */
export function mapTerminalStatus(lines: string[]): WorkerStatus {
	for (const line of [...lines].reverse()) {
		const trimmed = line.trim();
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue; // torn trailing line / noise — not a marker, keep looking
		}
		if (typeof parsed !== "object" || parsed === null) continue;
		if (!("type" in parsed) || parsed.type !== "custom") continue;
		if (!("customType" in parsed) || parsed.customType !== "session_exit") {
			continue;
		}
		if (!("data" in parsed)) return "aborted";
		const data = parsed.data;
		if (typeof data !== "object" || data === null) return "aborted";
		if (!("kind" in data)) return "aborted";
		if (data.kind === "normal") return "completed";
		if (data.kind === "error" || data.kind === "failed") return "failed";
		return "aborted"; // "signal" and unrecognised kinds
	}
	return "aborted";
}

export function mapTranscriptToSnapshot(
	workerId: string,
	sessionFile: string,
	lines: string[],
	mtimeMs: number,
	projectDir: string,
	/**
	 * Lines to derive status from — normally a bounded TAIL window so the
	 * last-line session_exit marker survives the head cap (P5-R4). Defaults
	 * to `lines` when no tail was read.
	 */
	statusLines?: string[],
): WorkerSnapshot | null {
	let header: SessionHeader | null = null;
	let agent = "task";
	let model: string | undefined;
	let modelRole: string | undefined;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue; // torn trailing line / noise (P5-R7) — skip deterministically
		}
		if (typeof parsed !== "object" || parsed === null) continue;
		const rec = parsed as SessionHeader & ModelChange;
		if (header === null && rec.type === "session") {
			header = rec;
			continue;
		}
		if (rec.type === "model_change" && model === undefined && modelRole === undefined) {
			if (typeof rec.model === "string") model = rec.model;
			if (typeof rec.role === "string") {
				modelRole = rec.role;
				if (rec.role.startsWith("subagent:")) agent = "task";
			}
		}
	}
	if (header === null) return null;
	if (typeof header.parentSession !== "string") return null;
	if (!isDirectWorker(header.parentSession, projectDir)) return null;
	const snapshot: WorkerSnapshot = {
		id: workerId,
		agent,
		status: mapTerminalStatus(statusLines ?? lines), // P5-R4 honest marker mapping
		sessionFile,
		historical: true,
		updatedAt: mtimeMs,
	};
	if (model !== undefined) snapshot.model = model;
	if (modelRole !== undefined) snapshot.modelRole = modelRole;
	return snapshot;
}

function describeErr(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Real artifact-tree scan. `scan(cwd)` enumerates ONLY the queried cwd's
 * encoded slug dir — foreign cwd trees are never touched.
 */
export function createHistorySource(deps: HistoryDeps = {}): HistorySource {
	const sessionsRoot = deps.sessionsRoot ?? join(homedir(), ".omp", "agent", "sessions");
	const now = deps.now ?? Date.now;
	const readDir = deps.readDir ?? readdir;
	const readFileSeam = deps.readFile ?? boundedReadFile;
	const statSeam = deps.stat ?? stat;
	const readFileTailSeam = deps.readFileTail ?? boundedTailReadFile;

	return {
		scan: async (cwd, opts) => {
			const warnings: string[] = [];
			const workers: WorkerSnapshot[] = [];
			const scannedAt = now();
			const maxSessions = opts?.maxSessions ?? DEFAULT_MAX_SESSIONS;
			const maxWorkers = opts?.maxWorkers ?? DEFAULT_MAX_WORKERS;
			const maxFileBytes = opts?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
			const projectDir = join(sessionsRoot, encodeCwdSlug(cwd));

			let entries: string[];
			try {
				entries = await readDir(projectDir);
			} catch (err) {
				warnings.push(`history scan: ${projectDir} unreadable: ${describeErr(err)}`);
				return { workers, warnings, scannedAt };
			}

			// Newest session dirs first (ISO prefix sorts chronologically).
			const sessionDirs = entries
				.filter((e) => SESSION_DIR_RE.test(e))
				.sort()
				.reverse()
				.slice(0, maxSessions);

			for (const sessionDirName of sessionDirs) {
				if (workers.length >= maxWorkers) break;
				const sessionDir = join(projectDir, sessionDirName);
				try {
					const s = await statSeam(sessionDir);
					if (!s.isDirectory()) continue;
				} catch (err) {
					warnings.push(`history scan: ${sessionDir} unstat-able: ${describeErr(err)}`);
					continue;
				}

				let children: string[];
				try {
					children = await readDir(sessionDir);
				} catch (err) {
					warnings.push(`history scan: ${sessionDir} unreadable: ${describeErr(err)}`);
					continue;
				}

				for (const child of children.sort()) {
					if (workers.length >= maxWorkers) break;
					if (child.startsWith(".")) continue; // dotfiles
					if (!child.endsWith(".jsonl")) continue; // *.md, *.lock.os, noise
					const sessionFile = join(sessionDir, child);
					let mtimeMs: number;
					let fileSize: number | undefined;
					try {
						const s = await statSeam(sessionFile);
						if (s.isDirectory()) continue; // subdirectory, never a transcript
						mtimeMs = s.mtimeMs;
						fileSize = s.size;
					} catch (err) {
						warnings.push(`history scan: ${sessionFile} unstat-able: ${describeErr(err)}`);
						continue;
					}

					let content: string;
					try {
						content = await readFileSeam(sessionFile, "utf8", maxFileBytes);
					} catch (err) {
						warnings.push(`history scan: ${sessionFile} unreadable: ${describeErr(err)}`);
						continue;
					}
					// Char-level safety net for seams that ignore maxBytes.
					if (content.length > maxFileBytes) {
						content = content.slice(0, maxFileBytes);
					}

					// Bounded TAIL window for the terminal marker (P5-R4): the
					// verified session_exit line is the transcript's LAST line,
					// so a head-capped read truncates it on files > cap. Fails
					// soft to head-only status (conservative "aborted") on error.
					let statusLines: string[] | undefined;
					if (fileSize !== undefined && fileSize > maxFileBytes) {
						try {
							let tail = await readFileTailSeam(sessionFile, "utf8", maxFileBytes);
							if (tail.length > maxFileBytes) {
								tail = tail.slice(-maxFileBytes);
							}
							statusLines = tail.split("\n");
						} catch (err) {
							warnings.push(`history scan: ${sessionFile} tail unreadable: ${describeErr(err)}`);
						}
					}

					const workerId = child.slice(0, -".jsonl".length);
					const snapshot = mapTranscriptToSnapshot(
						workerId,
						sessionFile,
						content.split("\n"),
						mtimeMs,
						projectDir,
						statusLines,
					);
					if (snapshot !== null) workers.push(snapshot);
				}
			}
			return { workers, warnings, scannedAt };
		},
	};
}
