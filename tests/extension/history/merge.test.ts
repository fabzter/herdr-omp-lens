import { describe, expect, test } from "bun:test";
import { mergeLiveAndHistorical, transcriptRefFor } from "../../../src/extension/history";
import type { WorkerSnapshot } from "../../../src/protocol/types";

const snap = (
	id: string,
	status: WorkerSnapshot["status"],
	extra: Partial<WorkerSnapshot> = {},
): WorkerSnapshot => ({ id, agent: "task", status, updatedAt: 1, ...extra });

describe("mergeLiveAndHistorical (P5-R3)", () => {
	test("live wins on collision; no duplicate", () => {
		const live = [snap("X", "running", { updatedAt: 2 })];
		const hist = [snap("X", "completed", { historical: true, sessionFile: "/s/X.jsonl" })];
		const merged = mergeLiveAndHistorical(live, hist);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.status).toBe("running");
		expect(merged[0]?.historical).toBeUndefined();
	});
	test("live order preserved, surviving hist appended in order", () => {
		const live = [snap("B", "running"), snap("A", "idle")];
		const hist = [
			snap("A", "completed", { historical: true }),
			snap("C", "completed", { historical: true }),
			snap("D", "aborted", { historical: true }),
		];
		const merged = mergeLiveAndHistorical(live, hist);
		expect(merged.map((w) => w.id)).toEqual(["B", "A", "C", "D"]);
		expect(merged[2]?.historical).toBe(true);
	});
	test("never mutates inputs", () => {
		const live = [snap("X", "running")];
		const hist = [snap("X", "completed", { historical: true })];
		const merged = mergeLiveAndHistorical(live, hist);
		expect(live).toHaveLength(1);
		expect(hist).toHaveLength(1);
		expect(merged).not.toBe(live);
		expect(merged[0]).toBe(live[0]);
	});
	test("both empty / one-sided inputs", () => {
		expect(mergeLiveAndHistorical([], [])).toEqual([]);
		const hist = [snap("H", "aborted", { historical: true })];
		expect(mergeLiveAndHistorical([], hist)).toHaveLength(1);
	});
});

describe("transcriptRefFor (P5-R5)", () => {
	test("builds ref with sessionFile + artifactDir", () => {
		expect(transcriptRefFor(snap("X", "completed", { sessionFile: "/s/X.jsonl" }))).toEqual({
			v: 1,
			type: "transcript.ref",
			id: "X",
			sessionFile: "/s/X.jsonl",
			artifactDir: "/s",
		});
	});
	test("null without sessionFile", () => {
		expect(transcriptRefFor(snap("Y", "running"))).toBeNull();
	});
});
