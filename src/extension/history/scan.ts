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
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { WorkerSnapshot } from "../../protocol/types";
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
	readFile?: (path: string, encoding: "utf8") => Promise<string>;
	stat?: (path: string) => Promise<{ mtimeMs: number; isDirectory(): boolean }>;
}

/** Absolute cwd with every "/" replaced by "-" (verified 2026-11-24). */
export function encodeCwdSlug(cwd: string): string {
	return cwd.replaceAll("/", "-");
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

function mapTranscriptToSnapshot(
	workerId: string,
	sessionFile: string,
	lines: string[],
	mtimeMs: number,
	projectDir: string,
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
		// Task 1 default; real terminal-marker mapping is Task 2 (P5-R4).
		status: "aborted",
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
	const readFileSeam = deps.readFile ?? readFile;
	const statSeam = deps.stat ?? stat;

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
					try {
						const s = await statSeam(sessionFile);
						if (s.isDirectory()) continue; // subdirectory, never a transcript
						mtimeMs = s.mtimeMs;
					} catch (err) {
						warnings.push(`history scan: ${sessionFile} unstat-able: ${describeErr(err)}`);
						continue;
					}

					let content: string;
					try {
						content = await readFileSeam(sessionFile, "utf8");
					} catch (err) {
						warnings.push(`history scan: ${sessionFile} unreadable: ${describeErr(err)}`);
						continue;
					}
					if (content.length > maxFileBytes) {
						content = content.slice(0, maxFileBytes);
					}

					const workerId = child.slice(0, -".jsonl".length);
					const snapshot = mapTranscriptToSnapshot(
						workerId,
						sessionFile,
						content.split("\n"),
						mtimeMs,
						projectDir,
					);
					if (snapshot !== null) workers.push(snapshot);
				}
			}
			return { workers, warnings, scannedAt };
		},
	};
}
