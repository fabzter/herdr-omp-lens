import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	boundedReadFile,
	createHistorySource,
	encodeCwdSlug,
} from "../../../src/extension/history";
import { addWorker, makeFixtureTree, PROJECT_CWD, SESSION_1 } from "./fixtures";

describe("encodeCwdSlug", () => {
	test("replaces every / with - (verified layout)", () => {
		expect(encodeCwdSlug("/Users/fabzter/src/omp-fabz-improvements")).toBe(
			"-Users-fabzter-src-omp-fabz-improvements",
		);
		expect(encodeCwdSlug("/proj/a")).toBe("-proj-a");
	});
});

describe("boundedReadFile", () => {
	test("returns at most maxBytes of the file as utf8", async () => {
		const tree = makeFixtureTree();
		const file = tree.workers[0]?.sessionFile;
		if (file === undefined) throw new Error("fixture must have workers");
		const full = await readFile(file, "utf8");
		expect(full.length).toBeGreaterThan(40);
		const head = await boundedReadFile(file, "utf8", 40);
		expect(head.length).toBeLessThanOrEqual(40);
		expect(full.startsWith(head)).toBe(true);
		// maxBytes <= 0 reads nothing.
		expect(await boundedReadFile(file, "utf8", 0)).toBe("");
	});
});

describe("createHistorySource.scan", () => {
	test("maps direct workers, excludes nested and foreign", async () => {
		const tree = makeFixtureTree();
		const src = createHistorySource({
			sessionsRoot: tree.sessionsRoot,
			now: () => 1700000000000,
		});
		const scan = await src.scan(PROJECT_CWD);

		expect(scan.workers.map((w) => w.id).sort()).toEqual(["w1", "w2", "w3"]);
		expect(scan.scannedAt).toBe(1700000000000);
		for (const w of scan.workers) {
			expect(w.historical).toBe(true);
			expect(w.agent).toBe("task");
			expect(w.status).toBe("aborted");
			expect(w.counters).toBeUndefined();
			expect(w.sessionFile?.endsWith(`${w.id}.jsonl`)).toBe(true);
			const fx = tree.workers.find((f) => f.id === w.id);
			expect(fx).toBeDefined();
			if (fx === undefined) return;
			expect(w.updatedAt).toBe(fx.mtimeMs);
			expect(w.sessionFile).toBe(fx.sessionFile);
			expect(w.model).toBe("devin/swe-2");
			expect(w.modelRole).toBe(`subagent:${w.id}`);
		}
		// Excluded entries never surface.
		const sessionFiles = scan.workers.map((w) => w.sessionFile);
		expect(sessionFiles).not.toContain(tree.nestedFile);
		expect(sessionFiles).not.toContain(tree.badParentFile);
		expect(sessionFiles).not.toContain(tree.foreignFile);
	});

	test("missing/unreadable cwd artifact dir yields empty scan + warning, never throws", async () => {
		const tree = makeFixtureTree();
		const src = createHistorySource({
			sessionsRoot: tree.sessionsRoot,
			now: () => 1,
		});
		const scan = await src.scan("/no/such/cwd");
		expect(scan.workers).toEqual([]);
		expect(scan.warnings.length).toBeGreaterThan(0);
		expect(scan.scannedAt).toBe(1);
	});

	test("agent falls back to task when model_change is absent", async () => {
		const tree = makeFixtureTree();
		const s1 = tree.sessionDirs[0];
		if (s1 === undefined) throw new Error("fixture must have session dirs");
		addWorker(s1, "wnorole", `${tree.projectDir}/${SESSION_1}.jsonl`, {
			omitModelChange: true,
		});
		const src = createHistorySource({ sessionsRoot: tree.sessionsRoot });
		const scan = await src.scan(PROJECT_CWD);
		const w = scan.workers.find((x) => x.id === "wnorole");
		expect(w).toBeDefined();
		expect(w?.agent).toBe("task");
		expect(w?.historical).toBe(true);
	});

	test("maxSessions plumbed: newest session dirs only", async () => {
		const tree = makeFixtureTree();
		const src = createHistorySource({ sessionsRoot: tree.sessionsRoot });
		const scan = await src.scan(PROJECT_CWD, { maxSessions: 1 });
		// SESSION_2 sorts newest; it holds w2 + w3.
		expect(scan.workers.map((w) => w.id).sort()).toEqual(["w2", "w3"]);
	});

	test("every emitted snapshot is historical (P5-R2 guard)", async () => {
		const tree = makeFixtureTree();
		const src = createHistorySource({ sessionsRoot: tree.sessionsRoot });
		const scan = await src.scan(PROJECT_CWD);
		expect(scan.workers.length).toBeGreaterThan(0);
		expect(scan.workers.every((w) => w.historical === true)).toBe(true);
	});

	test("readFile seam receives the byte budget (bounded I/O, P5-R8/NFR-03)", async () => {
		const tree = makeFixtureTree();
		const budgets: Array<number | undefined> = [];
		const src = createHistorySource({
			sessionsRoot: tree.sessionsRoot,
			readFile: (path, encoding, maxBytes) => {
				budgets.push(maxBytes);
				return readFile(path, encoding);
			},
		});
		const scan = await src.scan(PROJECT_CWD, { maxFileBytes: 1024 });
		expect(scan.workers.length).toBeGreaterThan(0);
		// Every candidate transcript was read with the configured cap.
		expect(budgets.length).toBeGreaterThan(0);
		for (const b of budgets) expect(b).toBe(1024);
	});

	test("default bounded read stops at maxFileBytes bytes, not chars", async () => {
		const tree = makeFixtureTree();
		const s1 = tree.sessionDirs[0];
		if (s1 === undefined) throw new Error("fixture must have session dirs");
		// The model_change marker sits INSIDE a 1024-char window but OUTSIDE a
		// 1024-byte window (é = 2 bytes): only a byte-bounded read excludes it.
		const lines = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "wlate",
				cwd: PROJECT_CWD,
				parentSession: `${tree.projectDir}/${SESSION_1}.jsonl`,
			}),
			"é".repeat(700), // 1400 bytes / 700 chars — pushes marker past the byte cap
			JSON.stringify({
				type: "model_change",
				model: "beyond-cap",
				role: "subagent:wlate",
			}),
		];
		writeFileSync(join(s1, "wlate.jsonl"), `${lines.join("\n")}\n`);
		const src = createHistorySource({ sessionsRoot: tree.sessionsRoot });
		const scan = await src.scan(PROJECT_CWD, { maxFileBytes: 1024 });
		const w = scan.workers.find((x) => x.id === "wlate");
		expect(w).toBeDefined();
		expect(w?.model).toBeUndefined(); // marker lay beyond the byte budget
	});

	test("stat seam probes the stray.jsonl directory (isDirectory guard exercised)", async () => {
		const tree = makeFixtureTree();
		const statted: string[] = [];
		const src = createHistorySource({
			sessionsRoot: tree.sessionsRoot,
			stat: async (path) => {
				statted.push(path);
				return stat(path);
			},
		});
		const scan = await src.scan(PROJECT_CWD);
		expect(statted.some((p) => p.endsWith("stray.jsonl"))).toBe(true);
		expect(scan.workers.some((w) => w.id === "stray")).toBe(false);
	});
});
