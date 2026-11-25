import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCwdSlug } from "../../../src/extension/history";

/** The cwd every worker transcript in the fixture claims. */
export const PROJECT_CWD = "/proj/a";

export const SESSION_1 = "2026-11-24T09-00-00.000Z_11111111-2222-3333-4444-555555555555";
export const SESSION_2 = "2026-11-24T10-00-00.000Z_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

export interface FixtureWorker {
	id: string;
	sessionFile: string;
	mtimeMs: number;
}

export interface FixtureTree {
	/** Synthetic sessions root passed as HistoryDeps.sessionsRoot. */
	sessionsRoot: string;
	/** <root>/<encoded-cwd> — the queried project artifact dir. */
	projectDir: string;
	sessionDirs: string[];
	/** The three legit direct workers (w1, w2, w3). */
	workers: FixtureWorker[];
	/** Depth>=2 nested worker file — must be excluded. */
	nestedFile: string;
	/** Direct worker whose parentSession points at a worker JSONL — excluded. */
	badParentFile: string;
	/** Worker under a different encoded-cwd tree — excluded. */
	foreignFile: string;
}

function sessionHeaderLines(id: string, parentSession?: string): string[] {
	const header: Record<string, unknown> = {
		type: "session",
		version: 3,
		id,
		cwd: PROJECT_CWD,
	};
	if (parentSession !== undefined) header.parentSession = parentSession;
	return [JSON.stringify(header)];
}

/**
 * Write one worker transcript: `session` header + `model_change` +
 * optional torn trailing line. Returns the file + stamped mtime.
 */
export function addWorker(
	sessionDir: string,
	id: string,
	parentSession: string,
	opts: { mtimeMs?: number; omitModelChange?: boolean; torn?: boolean } = {},
): FixtureWorker {
	const lines = sessionHeaderLines(id, parentSession);
	if (opts.omitModelChange !== true) {
		lines.push(
			JSON.stringify({
				type: "model_change",
				model: "devin/swe-2",
				role: `subagent:${id}`,
			}),
		);
	}
	lines.push(JSON.stringify({ type: "message", role: "assistant" }));
	if (opts.torn === true) lines.push('{"type":"mess'); // truncated flush
	const sessionFile = join(sessionDir, `${id}.jsonl`);
	writeFileSync(sessionFile, `${lines.join("\n")}\n`);
	const mtimeMs = opts.mtimeMs ?? 1700000000000;
	const d = new Date(mtimeMs);
	utimesSync(sessionFile, d, d);
	return { id, sessionFile, mtimeMs };
}

/**
 * Synthetic artifact tree (verified P5-R1 layout):
 *   <root>/<encoded-cwd>/<ts>_<sessionId>/<workerId>.jsonl
 *
 * 2 session dirs, 3 direct workers (w1 in session 1, w2+w3 in session 2),
 * plus exclusions: one nested (depth>=2) worker, one worker whose
 * parentSession points at a worker JSONL, noise files, and a foreign
 * `-proj-b` tree that a scan of PROJECT_CWD must never touch.
 */
export function makeFixtureTree(): FixtureTree {
	const sessionsRoot = mkdtempSync(join(tmpdir(), "omp-lens-history-"));
	const projectDir = join(sessionsRoot, encodeCwdSlug(PROJECT_CWD));
	const s1dir = join(projectDir, SESSION_1);
	const s2dir = join(projectDir, SESSION_2);
	mkdirSync(s1dir, { recursive: true });
	mkdirSync(s2dir, { recursive: true });

	// Top-level parent session transcripts (the workers' parentSession target).
	writeFileSync(
		join(projectDir, `${SESSION_1}.jsonl`),
		`${sessionHeaderLines(SESSION_1).join("\n")}\n`,
	);
	writeFileSync(
		join(projectDir, `${SESSION_2}.jsonl`),
		`${sessionHeaderLines(SESSION_2).join("\n")}\n`,
	);

	const workers = [
		addWorker(s1dir, "w1", join(projectDir, `${SESSION_1}.jsonl`), {
			mtimeMs: 1700000001000,
		}),
		addWorker(s2dir, "w2", join(projectDir, `${SESSION_2}.jsonl`), {
			mtimeMs: 1700000002000,
		}),
		addWorker(s2dir, "w3", join(projectDir, `${SESSION_2}.jsonl`), {
			mtimeMs: 1700000003000,
			torn: true,
		}),
	];

	// Excluded: parentSession points at another worker JSONL (depth>=2 linkage).
	const badParent = addWorker(s1dir, "wbad", join(s1dir, "w1.jsonl"));

	// Excluded: nested worker inside a subdirectory of the session dir.
	const subDir = join(s2dir, "sub");
	mkdirSync(subDir);
	const nested = addWorker(subDir, "wnested", join(s2dir, "w2.jsonl"));

	// Noise entries the enumerator must skip.
	writeFileSync(join(s1dir, "notes.md"), "# notes\n");
	writeFileSync(join(s1dir, "w1.jsonl.lock.os"), "");
	writeFileSync(join(s1dir, ".hidden.jsonl"), "garbage\n");
	mkdirSync(join(s1dir, "stray.jsonl")); // dir named like a transcript (exercises isDirectory guard)

	// Foreign cwd tree — scanning PROJECT_CWD must never enumerate it.
	const foreignDir = join(sessionsRoot, encodeCwdSlug("/proj/b"), SESSION_1);
	mkdirSync(foreignDir, { recursive: true });
	writeFileSync(
		join(sessionsRoot, encodeCwdSlug("/proj/b"), `${SESSION_1}.jsonl`),
		`${sessionHeaderLines(SESSION_1).join("\n")}\n`,
	);
	const foreign = addWorker(
		foreignDir,
		"wforeign",
		join(sessionsRoot, encodeCwdSlug("/proj/b"), `${SESSION_1}.jsonl`),
	);

	return {
		sessionsRoot,
		projectDir,
		sessionDirs: [s1dir, s2dir],
		workers,
		nestedFile: nested.sessionFile,
		badParentFile: badParent.sessionFile,
		foreignFile: foreign.sessionFile,
	};
}
