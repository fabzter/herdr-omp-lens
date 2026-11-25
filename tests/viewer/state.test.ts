import { describe, expect, test } from "bun:test";
import type { Message, WorkerSnapshot } from "../../src/protocol/types";
import { applyMessage, initialViewerState, isFinishedStatus } from "../../src/viewer/state";

function snap(id: string, over: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
	return { id, agent: "task", status: "running", updatedAt: 1_000, ...over };
}

function live(id: string, over: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
	return snap(id, over);
}

function historical(id: string, over: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
	return snap(id, { status: "completed", historical: true, ...over });
}

describe("initialViewerState", () => {
	test("defaults: finished collapsed, thinking hidden, not live, not degraded", () => {
		const s = initialViewerState();
		expect(s.finishedCollapsed).toBe(true);
		expect(s.thinkingVisible).toBe(false);
		expect(s.live).toBe(false);
		expect(s.degraded).toBe(false);
		expect(s.workers.size).toBe(0);
		expect(s.notices).toEqual([]);
	});
});

describe("applyMessage — hello", () => {
	test("sets session, live roster, and flips live", () => {
		const s = applyMessage(initialViewerState(), {
			v: 1,
			type: "hello",
			session: "sess-1",
			workers: [live("w1"), live("w2")],
		});
		expect(s.session).toBe("sess-1");
		expect(s.live).toBe(true);
		expect([...s.workers.keys()].sort()).toEqual(["w1", "w2"]);
		expect(s.degraded).toBe(false);
	});

	test("history entries are carried and flagged not-live", () => {
		const s = applyMessage(initialViewerState(), {
			v: 1,
			type: "hello",
			session: "sess-1",
			workers: [live("w1")],
			history: [snap("h1", { status: "completed" })],
		});
		const h = s.workers.get("h1");
		expect(h).toBeDefined();
		expect(h?.historical).toBe(true);
		expect(s.workers.get("w1")?.historical).toBeUndefined();
	});

	test("history-only hello renders degraded (D1)", () => {
		const s = applyMessage(initialViewerState(), {
			v: 1,
			type: "hello",
			session: "sess-1",
			workers: [],
			history: [historical("h1")],
		});
		expect(s.degraded).toBe(true);
		expect(s.live).toBe(true);
	});

	test("a second hello replaces state, never merges (P3-R8)", () => {
		let s = applyMessage(initialViewerState(), {
			v: 1,
			type: "hello",
			session: "sess-1",
			workers: [live("w1"), live("w2")],
		});
		s = applyMessage(s, {
			v: 1,
			type: "hello",
			session: "sess-2",
			workers: [live("w3")],
		});
		expect(s.session).toBe("sess-2");
		expect([...s.workers.keys()]).toEqual(["w3"]);
	});
});

describe("applyMessage — worker.upsert / worker.removed", () => {
	test("upsert inserts and later updates the same id", () => {
		let s = applyMessage(initialViewerState(), {
			v: 1,
			type: "hello",
			session: "s",
			workers: [],
		});
		s = applyMessage(s, { v: 1, type: "worker.upsert", worker: live("w1") });
		s = applyMessage(s, {
			v: 1,
			type: "worker.upsert",
			worker: live("w1", { status: "idle", updatedAt: 2_000 }),
		});
		expect(s.workers.size).toBe(1);
		expect(s.workers.get("w1")?.status).toBe("idle");
		expect(s.workers.get("w1")?.updatedAt).toBe(2_000);
	});

	test("live upsert wins over a historical entry for the same id (RC-3)", () => {
		let s = applyMessage(initialViewerState(), {
			v: 1,
			type: "hello",
			session: "s",
			workers: [],
			history: [historical("w1")],
		});
		expect(s.workers.get("w1")?.historical).toBe(true);
		s = applyMessage(s, { v: 1, type: "worker.upsert", worker: live("w1") });
		const w = s.workers.get("w1");
		expect(w?.status).toBe("running");
		expect(w?.historical).toBeUndefined();
	});

	test("historical upsert keeps the not-live flag", () => {
		const s = applyMessage(initialViewerState(), {
			v: 1,
			type: "worker.upsert",
			worker: historical("h9"),
		});
		expect(s.workers.get("h9")?.historical).toBe(true);
	});

	test("removed deletes a known id; unknown ids are a no-op (P3-R8)", () => {
		let s = applyMessage(initialViewerState(), {
			v: 1,
			type: "hello",
			session: "s",
			workers: [live("w1")],
		});
		s = applyMessage(s, { v: 1, type: "worker.removed", id: "w1" });
		expect(s.workers.size).toBe(0);
		s = applyMessage(s, { v: 1, type: "worker.removed", id: "ghost" });
		expect(s.workers.size).toBe(0);
	});

	test("removed clears selectedId and the transcript ref for that id (F3)", () => {
		let s = applyMessage(
			{ ...initialViewerState(), selectedId: "w1" },
			{
				v: 1,
				type: "hello",
				session: "s",
				workers: [live("w1"), live("w2")],
			},
		);
		s = applyMessage(s, {
			v: 1,
			type: "transcript.ref",
			id: "w1",
			sessionFile: "/tmp/w1.jsonl",
		});
		s = applyMessage(s, { v: 1, type: "worker.removed", id: "w1" });
		expect(s.workers.has("w1")).toBe(false);
		expect(s.selectedId).toBeUndefined();
		expect(s.transcriptRefs.has("w1")).toBe(false);
		expect(s.workers.has("w2")).toBe(true);
	});

	test("hello live-wins: same id in workers and history stays live (F1)", () => {
		const s = applyMessage(initialViewerState(), {
			v: 1,
			type: "hello",
			session: "sess-1",
			workers: [live("w1")],
			history: [snap("w1", { status: "completed" })],
		});
		const w = s.workers.get("w1");
		expect(w?.status).toBe("running");
		expect(w?.historical).toBeUndefined();
		expect(s.workers.size).toBe(1);
	});
});

describe("applyMessage — transcript.ref / topology", () => {
	test("transcript.ref records the ref and creates no phantom row", () => {
		const s = applyMessage(initialViewerState(), {
			v: 1,
			type: "transcript.ref",
			id: "w9",
			sessionFile: "/tmp/w9.jsonl",
			artifactDir: "/tmp",
		});
		expect(s.workers.has("w9")).toBe(false);
		expect(s.transcriptRefs.get("w9")).toEqual({
			sessionFile: "/tmp/w9.jsonl",
			artifactDir: "/tmp",
		});
	});

	test("topology is recorded", () => {
		const s = applyMessage(initialViewerState(), {
			v: 1,
			type: "topology",
			tabId: "t1",
			paneIds: ["p1", "p2"],
			state: "open",
		});
		expect(s.topology).toEqual({ tabId: "t1", paneIds: ["p1", "p2"], state: "open" });
	});
});

describe("applyMessage — notice / degraded", () => {
	test("notices append in order and are capped", () => {
		let s = initialViewerState();
		for (let i = 0; i < 150; i++) {
			s = applyMessage(s, { v: 1, type: "notice", level: "info", message: `n${i}` });
		}
		expect(s.notices.length).toBeLessThanOrEqual(100);
		expect(s.notices.at(-1)?.message).toBe("n149");
	});

	test("warn/error notices set degraded; info does not (D1)", () => {
		let s = applyMessage(initialViewerState(), {
			v: 1,
			type: "notice",
			level: "info",
			message: "fyi",
		});
		expect(s.degraded).toBe(false);
		s = applyMessage(s, { v: 1, type: "notice", level: "warn", message: "bus degraded" });
		expect(s.degraded).toBe(true);
	});
});

describe("applyMessage — robustness", () => {
	test("malformed input returns state unchanged and never throws (NFR-02)", () => {
		const s = initialViewerState();
		const junk = [
			JSON.parse("{}"),
			JSON.parse('{"v":1,"type":"wat"}'),
			JSON.parse("null"),
			JSON.parse("42"),
			undefined,
		];
		for (const m of junk) {
			expect(() => applyMessage(s, m as Message)).not.toThrow();
			expect(applyMessage(s, m as Message)).toBe(s);
		}
	});

	test("structurally-bad known-type frames never throw and are no-ops (F2)", () => {
		const s = applyMessage(initialViewerState(), {
			v: 1,
			type: "hello",
			session: "s",
			workers: [live("w1")],
		});
		const bad = [
			JSON.parse('{"v":1,"type":"hello","session":"x"}'),
			JSON.parse('{"v":1,"type":"hello","session":"x","workers":42}'),
			JSON.parse('{"v":1,"type":"worker.upsert"}'),
			JSON.parse('{"v":1,"type":"worker.upsert","worker":{"status":"running"}}'),
			JSON.parse('{"v":1,"type":"topology","state":"open"}'),
			JSON.parse('{"v":1,"type":"transcript.ref"}'),
			JSON.parse('{"v":1,"type":"notice"}'),
		];
		for (const m of bad) {
			expect(() => applyMessage(s, m as Message)).not.toThrow();
			expect(applyMessage(s, m as Message)).toBe(s);
		}
	});

	test("does not mutate the input state", () => {
		const s = applyMessage(initialViewerState(), {
			v: 1,
			type: "hello",
			session: "s",
			workers: [live("w1")],
		});
		const before = s.workers;
		applyMessage(s, { v: 1, type: "worker.upsert", worker: live("w2") });
		expect(s.workers).toBe(before);
		expect(s.workers.has("w2")).toBe(false);
	});
});

describe("isFinishedStatus", () => {
	test("completed/failed/aborted are finished; others are not", () => {
		expect(isFinishedStatus("completed")).toBe(true);
		expect(isFinishedStatus("failed")).toBe(true);
		expect(isFinishedStatus("aborted")).toBe(true);
		expect(isFinishedStatus("running")).toBe(false);
		expect(isFinishedStatus("queued")).toBe(false);
		expect(isFinishedStatus("idle")).toBe(false);
		expect(isFinishedStatus("parked")).toBe(false);
	});
});
