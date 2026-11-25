import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHistorySource, encodeCwdSlug } from "../../../src/extension/history";
import { addWorker, PROJECT_CWD } from "./fixtures";

/** <ts>_<uuid> session-dir name; equal-width prefix so lexicographic == chronological. */
function sessionName(i: number): string {
	const d = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 1000);
	const p = (n: number) => String(n).padStart(2, "0");
	const ts = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}-${p(d.getUTCMinutes())}-${p(d.getUTCSeconds())}.000Z`;
	// Hex-only uuid suffix satisfying SESSION_DIR_RE's [0-9a-f-] tail.
	return `${ts}_00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
}

/**
 * N session dirs (oldest first), one direct worker `w{i}` each. Parent
 * session transcript files are not written — isDirectWorker checks the
 * parentSession path shape, not existence.
 */
function makeLargeTree(n: number): { sessionsRoot: string; projectDir: string; names: string[] } {
	const sessionsRoot = mkdtempSync(join(tmpdir(), "omp-lens-bounds-"));
	const projectDir = join(sessionsRoot, encodeCwdSlug(PROJECT_CWD));
	const names: string[] = [];
	for (let i = 0; i < n; i++) {
		const name = sessionName(i);
		mkdirSync(join(projectDir, name), { recursive: true });
		addWorker(join(projectDir, name), `w${i}`, join(projectDir, `${name}.jsonl`), {
			mtimeMs: 1700000000000 + i,
		});
		names.push(name);
	}
	return { sessionsRoot, projectDir, names };
}

describe("bounded scan (P5-R8 / NFR-03)", () => {
	test("200-session tree scans only the newest maxSessions dirs", async () => {
		const tree = makeLargeTree(200);
		const stattedDirs = new Set<string>();
		const src = createHistorySource({
			sessionsRoot: tree.sessionsRoot,
			stat: async (p) => {
				stattedDirs.add(p);
				return stat(p);
			},
		});
		const scan = await src.scan(PROJECT_CWD, { maxSessions: 20, maxWorkers: 100 });
		expect(scan.workers).toHaveLength(20);
		// The newest 20 dirs are i=180..199 — exactly those workers surface.
		const expected = Array.from({ length: 20 }, (_, k) => `w${180 + k}`).sort();
		expect(scan.workers.map((w) => w.id).sort()).toEqual(expected);
		// The oldest dir was never even probed.
		expect(stattedDirs.has(join(tree.projectDir, tree.names[0] as string))).toBe(false);
	});

	test("maxWorkers stops collection mid-scan", async () => {
		const tree = makeLargeTree(5);
		const src = createHistorySource({ sessionsRoot: tree.sessionsRoot });
		const scan = await src.scan(PROJECT_CWD, { maxSessions: 20, maxWorkers: 2 });
		expect(scan.workers).toHaveLength(2);
		// Newest-first order holds: w4, w3.
		expect(scan.workers.map((w) => w.id)).toEqual(["w4", "w3"]);
	});

	test("unchanged mtimes do not reparse (mtime-keyed cache)", async () => {
		const tree = makeLargeTree(3);
		let reads = 0;
		const src = createHistorySource({
			sessionsRoot: tree.sessionsRoot,
			readFile: (p) => {
				reads++;
				return readFile(p, "utf8");
			},
		});
		await src.scan(PROJECT_CWD);
		const first = reads;
		expect(first).toBeGreaterThan(0);
		const second = await src.scan(PROJECT_CWD);
		expect(reads).toBe(first); // second scan reparses nothing
		expect(second.workers).toHaveLength(3); // cached snapshots still surface
	});

	test("changed mtime reparses that file only", async () => {
		const tree = makeLargeTree(3);
		const reads = new Map<string, number>();
		const src = createHistorySource({
			sessionsRoot: tree.sessionsRoot,
			readFile: (p) => {
				reads.set(p, (reads.get(p) ?? 0) + 1);
				return readFile(p, "utf8");
			},
		});
		const first = await src.scan(PROJECT_CWD);
		const w2file = first.workers.find((w) => w.id === "w2")?.sessionFile;
		if (w2file === undefined) throw new Error("w2 must be scanned");
		const t = new Date(1700000060000);
		utimesSync(w2file, t, t);
		const second = await src.scan(PROJECT_CWD);
		expect(second.workers).toHaveLength(3);
		expect(reads.get(w2file)).toBe(2); // reparsed once more
		for (const [file, n] of reads) {
			if (file !== w2file) expect(n).toBe(1); // untouched files stayed cached
		}
	});
});

describe("torn-read tolerance (P5-R7 / U-OMP-7)", () => {
	test("torn trailing line is skipped, entry surfaced, no throw", async () => {
		const { sessionsRoot, projectDir } = makeLargeTree(0);
		const dir = join(projectDir, sessionName(0));
		mkdirSync(dir, { recursive: true });
		addWorker(dir, "wtorn", join(projectDir, `${sessionName(0)}.jsonl`), { torn: true });
		const src = createHistorySource({ sessionsRoot });
		const scan = await src.scan(PROJECT_CWD);
		expect(scan.workers.map((w) => w.id)).toEqual(["wtorn"]);
		expect(scan.warnings.length).toBeLessThanOrEqual(1);
	});

	test("permanently unreadable file warns once, rest of scan intact", async () => {
		const { sessionsRoot, projectDir } = makeLargeTree(0);
		const dir = join(projectDir, sessionName(0));
		mkdirSync(dir, { recursive: true });
		const good = addWorker(dir, "wgood", join(projectDir, `${sessionName(0)}.jsonl`));
		const bad = addWorker(dir, "wbad2", join(projectDir, `${sessionName(0)}.jsonl`));
		const src = createHistorySource({
			sessionsRoot,
			readFile: async (p) => {
				if (p === bad.sessionFile) throw new Error("EACCES: permission denied");
				return readFile(p, "utf8");
			},
		});
		const scan = await src.scan(PROJECT_CWD);
		expect(scan.workers.map((w) => w.id)).toEqual([good.id]);
		expect(scan.warnings).toHaveLength(1);
		expect(scan.warnings[0]).toContain(bad.sessionFile);
	});

	test("file that grew between stat and read is re-read once (bounded retry)", async () => {
		const { sessionsRoot, projectDir } = makeLargeTree(0);
		const dir = join(projectDir, sessionName(0));
		mkdirSync(dir, { recursive: true });
		const w = addWorker(dir, "wgrow", join(projectDir, `${sessionName(0)}.jsonl`));
		const full = await readFile(w.sessionFile, "utf8");
		const exitLine = `${JSON.stringify({
			type: "custom",
			customType: "session_exit",
			data: { kind: "normal", reason: "dispose", recordedAt: 1 },
		})}\n`;
		const torn = `${full}{"type":"cust`; // mid-flush snapshot
		const complete = `${full}${exitLine}`;
		let stats = 0;
		let reads = 0;
		const src = createHistorySource({
			sessionsRoot,
			stat: async (p) => {
				const s = await stat(p);
				if (p === w.sessionFile) {
					stats++;
					// Second stat (post-torn-read) reports a grown file.
					return {
						mtimeMs: s.mtimeMs,
						size: s.size + (stats >= 2 ? exitLine.length : 0),
						isDirectory: () => false,
					};
				}
				return s;
			},
			readFile: async (p) => {
				if (p === w.sessionFile) {
					reads++;
					return reads >= 2 ? complete : torn;
				}
				return readFile(p, "utf8");
			},
		});
		const scan = await src.scan(PROJECT_CWD);
		expect(reads).toBe(2); // exactly one bounded re-read
		const snap = scan.workers.find((x) => x.id === "wgrow");
		expect(snap?.status).toBe("completed"); // re-read saw the flushed marker
	});

	test("still-growing file does not loop: bounded at one re-read", async () => {
		const { sessionsRoot, projectDir } = makeLargeTree(0);
		const dir = join(projectDir, sessionName(0));
		mkdirSync(dir, { recursive: true });
		const w = addWorker(dir, "wstorm", join(projectDir, `${sessionName(0)}.jsonl`));
		const full = await readFile(w.sessionFile, "utf8");
		const torn = `${full}{"type":"cust`;
		let stats = 0;
		let reads = 0;
		const src = createHistorySource({
			sessionsRoot,
			stat: async (p) => {
				const s = await stat(p);
				if (p === w.sessionFile) {
					stats++;
					// Every re-stat "grows" — the file is being appended to forever.
					return { mtimeMs: s.mtimeMs, size: s.size + stats * 64, isDirectory: () => false };
				}
				return s;
			},
			readFile: async (p) => {
				if (p === w.sessionFile) {
					reads++;
					return torn; // always mid-flush
				}
				return readFile(p, "utf8");
			},
		});
		const scan = await src.scan(PROJECT_CWD);
		expect(reads).toBe(2); // initial + exactly one retry, never a loop
		expect(scan.workers.map((x) => x.id)).toEqual(["wstorm"]); // still surfaced
	});
});
