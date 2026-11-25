import { describe, expect, test } from "bun:test";
import { createHistorySource, encodeCwdSlug } from "../../../src/extension/history";
import { addWorker, makeFixtureTree, PROJECT_CWD, SESSION_1 } from "./fixtures";

describe("encodeCwdSlug", () => {
	test("replaces every / with - (verified layout)", () => {
		expect(encodeCwdSlug("/Users/fabzter/src/omp-fabz-improvements")).toBe(
			"-Users-fabzter-src-omp-fabz-improvements",
		);
		expect(encodeCwdSlug("/proj/a")).toBe("-proj-a");
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
});
