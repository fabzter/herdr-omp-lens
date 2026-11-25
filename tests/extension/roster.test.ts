import { describe, expect, test } from "bun:test";
import type {
	SubagentEvent,
	SubagentLifecycle,
	SubagentProgress,
	SubagentSpawn,
} from "../../src/extension/observe/schemas";
import { Roster, type RosterSignal } from "../../src/extension/roster";
import type { WorkerSnapshot, WorkerStatus } from "../../src/protocol/types";

function spawn(spawnKey: string, extra: Partial<SubagentSpawn> = {}): SubagentSpawn {
	return { type: "before_subagent_spawn", agent: "scout", modelRole: "smol", spawnKey, ...extra };
}

function lifecycle(
	id: string,
	status: string,
	extra: Partial<SubagentLifecycle> = {},
): SubagentLifecycle {
	return { id, agent: "scout", status, ...extra };
}

function progress(
	id: string,
	status: string,
	extra: Partial<SubagentProgress> = {},
): SubagentProgress {
	return { progress: { id, status }, ...extra };
}

function event(id: string, type: string): SubagentEvent {
	return { id, event: { type } };
}

function collect(roster: Roster): {
	changes: WorkerSnapshot[];
	signals: RosterSignal[];
	notices: string[];
} {
	const changes: WorkerSnapshot[] = [];
	const signals: RosterSignal[] = [];
	const notices: string[] = [];
	roster.onChange((w) => changes.push(w));
	roster.onSignal((s) => signals.push(s));
	roster.onNotice((m) => notices.push(m));
	return { changes, signals, notices };
}

function onlyWorker(roster: Roster): WorkerSnapshot {
	const snap = roster.snapshot();
	expect(snap).toHaveLength(1);
	const w = snap[0];
	if (!w) throw new Error("snapshot returned no worker");
	return w;
}

describe("direct-id set (FR-10 / P2-R3)", () => {
	test("applySpawn alone does not add a roster entry or emit signals", () => {
		const r = new Roster();
		const { signals } = collect(r);
		r.applySpawn(spawn("w1"));
		expect(r.snapshot()).toHaveLength(0);
		expect(signals).toHaveLength(0);
	});

	test("frames for ids that were never spawned are excluded (nested/other-session filter)", () => {
		const r = new Roster();
		const { changes, signals } = collect(r);
		r.applyLifecycle(lifecycle("nested1", "started", { agent: "deep" }));
		r.applyProgress(progress("nested1", "running", { agent: "deep" }));
		r.applyEvent(event("nested1", "agent_start"));
		expect(r.snapshot()).toHaveLength(0);
		expect(changes).toHaveLength(0);
		expect(signals).toHaveLength(0);
	});

	test("a direct id joins the roster on its first lifecycle frame", () => {
		const r = new Roster();
		r.applySpawn(spawn("w1"));
		r.applyLifecycle(lifecycle("w1", "started"));
		expect(r.snapshot()).toHaveLength(1);
	});

	test("a direct id joins the roster on its first progress frame", () => {
		const r = new Roster();
		r.applySpawn(spawn("w1"));
		r.applyProgress(progress("w1", "running"));
		expect(r.snapshot()).toHaveLength(1);
	});
});

describe("status mapping (P2-R4)", () => {
	test("lifecycle started maps to running", () => {
		const r = new Roster();
		r.applySpawn(spawn("w1"));
		r.applyLifecycle(lifecycle("w1", "started"));
		expect(onlyWorker(r).status).toBe("running");
	});

	test("progress.status is authoritative while live", () => {
		const r = new Roster();
		r.applySpawn(spawn("w1"));
		r.applyLifecycle(lifecycle("w1", "started"));
		r.applyProgress(progress("w1", "running"));
		expect(onlyWorker(r).status).toBe("running");
		r.applyProgress(progress("w1", "idle"));
		expect(onlyWorker(r).status).toBe("idle");
		r.applyProgress(progress("w1", "parked"));
		expect(onlyWorker(r).status).toBe("parked");
	});

	test("idle/parked map verbatim from lifecycle too", () => {
		const r = new Roster();
		r.applySpawn(spawn("w1"));
		r.applyLifecycle(lifecycle("w1", "idle"));
		expect(onlyWorker(r).status).toBe("idle");
		r.applyLifecycle(lifecycle("w1", "parked"));
		expect(onlyWorker(r).status).toBe("parked");
	});

	test("terminal lifecycle wins over a later non-terminal progress frame", () => {
		const r = new Roster();
		const { signals } = collect(r);
		r.applySpawn(spawn("w1"));
		r.applyLifecycle(lifecycle("w1", "started"));
		r.applyLifecycle(lifecycle("w1", "completed"));
		r.applyProgress(progress("w1", "running"));
		expect(r.snapshot()).toHaveLength(0);
		expect(signals.filter((s) => s.type === "worker.finished")).toHaveLength(1);
	});

	test("failed and aborted are terminal statuses", () => {
		for (const terminal of ["failed", "aborted"] satisfies readonly WorkerStatus[]) {
			const r = new Roster();
			const { signals } = collect(r);
			r.applySpawn(spawn("w1"));
			r.applyLifecycle(lifecycle("w1", "started"));
			r.applyLifecycle(lifecycle("w1", terminal));
			expect(r.snapshot()).toHaveLength(0);
			const finished = signals.find((s) => s.type === "worker.finished");
			if (finished?.type !== "worker.finished") {
				throw new Error(`expected worker.finished for ${terminal}`);
			}
			expect(finished.worker.status).toBe(terminal);
		}
	});

	test("a first frame carrying a terminal status still emits spawned then finished", () => {
		const r = new Roster();
		const { signals } = collect(r);
		r.applySpawn(spawn("w1"));
		r.applyProgress(progress("w1", "completed"));
		expect(signals.map((s) => s.type)).toEqual([
			"worker.spawned",
			"worker.finished",
			"roster.empty",
		]);
	});

	test("unknown status keeps the last known status and emits a notice", () => {
		const r = new Roster();
		const { notices } = collect(r);
		r.applySpawn(spawn("w1"));
		r.applyLifecycle(lifecycle("w1", "started"));
		r.applyProgress(progress("w1", "mystifying"));
		expect(onlyWorker(r).status).toBe("running");
		expect(notices.length).toBeGreaterThanOrEqual(1);
		expect(r.notices().length).toBeGreaterThanOrEqual(1);
	});
});

describe("field mapping (P2-R4, RC-11)", () => {
	test("lifecycle fields map to snapshot", () => {
		const r = new Roster();
		r.applySpawn(spawn("w1"));
		r.applyLifecycle(
			lifecycle("w1", "started", {
				agent: "scout",
				parentToolCallId: "call_abc",
				index: 2,
				sessionFile: "/tmp/w1.jsonl",
			}),
		);
		const w = onlyWorker(r);
		expect(w.id).toBe("w1");
		expect(w.agent).toBe("scout");
		expect(w.parentToolCallId).toBe("call_abc");
		expect(w.index).toBe(2);
		expect(w.sessionFile).toBe("/tmp/w1.jsonl");
		expect(typeof w.updatedAt).toBe("number");
	});

	test("counters come from the nested .progress object, not the envelope", () => {
		const r = new Roster();
		r.applySpawn(spawn("w1"));
		r.applyProgress(
			progress("w1", "running", {
				index: 0,
				assignment: "do the thing",
				sessionFile: "/tmp/w1.jsonl",
				progress: {
					id: "w1",
					status: "running",
					toolCount: 3,
					requests: 2,
					tokens: 14114,
					cost: 0.0085,
					durationMs: 7576,
					modelRole: "smol",
					resolvedModelIdentity: "devin/swe-2",
					resolvedThinkingLevel: "medium",
					contextWindow: 262000,
				},
			}),
		);
		const w = onlyWorker(r);
		expect(w.counters).toEqual({
			toolCount: 3,
			requests: 2,
			tokens: 14114,
			cost: 0.0085,
			durationMs: 7576,
		});
		expect(w.model).toBe("devin/swe-2");
		expect(w.modelRole).toBe("smol");
		expect(w.thinkingLevel).toBe("medium");
		expect(w.assignment).toBe("do the thing");
		expect(w.sessionFile).toBe("/tmp/w1.jsonl");
		expect(w.index).toBe(0);
	});

	test("activity comes from recentOutput, else recentTools", () => {
		const r = new Roster();
		r.applySpawn(spawn("w1"));
		r.applyProgress(
			progress("w1", "running", {
				progress: {
					id: "w1",
					status: "running",
					recentTools: [{ tool: "read", isError: false }],
					recentOutput: ["halfway there"],
				},
			}),
		);
		expect(onlyWorker(r).activity).toBe("halfway there");
		r.applyProgress(
			progress("w1", "running", {
				progress: {
					id: "w1",
					status: "running",
					recentTools: [{ tool: "write" }],
				},
			}),
		);
		expect(onlyWorker(r).activity).toBe("write");
	});
});

describe("signals (P2-R10)", () => {
	test("every spawn emits worker.spawned carrying the snapshot", () => {
		const r = new Roster();
		const { signals } = collect(r);
		r.applySpawn(spawn("w1"));
		r.applySpawn(spawn("w2"));
		r.applyLifecycle(lifecycle("w1", "started"));
		r.applyLifecycle(lifecycle("w2", "started"));
		const spawned = signals.filter((s) => s.type === "worker.spawned");
		expect(spawned).toHaveLength(2);
		const first = spawned[0];
		if (first?.type !== "worker.spawned") throw new Error("expected worker.spawned");
		expect(first.worker.id).toBe("w1");
		expect(first.worker.status).toBe("running");
	});

	test("onChange fires on each upsert", () => {
		const r = new Roster();
		const { changes } = collect(r);
		r.applySpawn(spawn("w1"));
		r.applyLifecycle(lifecycle("w1", "started"));
		r.applyProgress(progress("w1", "running"));
		expect(changes.length).toBeGreaterThanOrEqual(2);
		const last = changes.at(-1);
		expect(last?.id).toBe("w1");
		expect(last?.updatedAt).toBeTypeOf("number");
	});

	test("worker.finished carries id and final snapshot; last removal emits roster.empty", () => {
		const r = new Roster();
		const { signals } = collect(r);
		r.applySpawn(spawn("w1"));
		r.applyLifecycle(lifecycle("w1", "started"));
		r.applyLifecycle(lifecycle("w1", "completed", { sessionFile: "/tmp/w1.jsonl" }));
		expect(signals.map((s) => s.type)).toEqual([
			"worker.spawned",
			"worker.finished",
			"roster.empty",
		]);
		const finished = signals[1];
		if (finished?.type !== "worker.finished") throw new Error("expected worker.finished");
		expect(finished.id).toBe("w1");
		expect(finished.worker.status).toBe("completed");
		expect(finished.worker.sessionFile).toBe("/tmp/w1.jsonl");
		expect(r.snapshot()).toHaveLength(0);
	});

	test("roster.empty fires only when the LAST worker leaves", () => {
		const r = new Roster();
		const { signals } = collect(r);
		r.applySpawn(spawn("w1"));
		r.applySpawn(spawn("w2"));
		r.applyLifecycle(lifecycle("w1", "started"));
		r.applyLifecycle(lifecycle("w2", "started"));
		r.applyLifecycle(lifecycle("w1", "completed"));
		expect(signals.filter((s) => s.type === "roster.empty")).toHaveLength(0);
		expect(r.snapshot()).toHaveLength(1);
		r.applyLifecycle(lifecycle("w2", "completed"));
		expect(signals.filter((s) => s.type === "roster.empty")).toHaveLength(1);
	});
});

describe("events (P2-R4)", () => {
	test("applyEvent updates activity for a live direct worker", () => {
		const r = new Roster();
		r.applySpawn(spawn("w1"));
		r.applyEvent(event("w1", "agent_start"));
		const w = onlyWorker(r);
		expect(w.status).toBe("queued");
		expect(w.activity).toBe("agent_start");
	});
});

describe("prototype-key status strings (regression)", () => {
	test("Object.prototype member names are unrecognized: keep last status + notice", () => {
		const WORKER_STATUSES = new Set([
			"queued",
			"running",
			"idle",
			"parked",
			"completed",
			"failed",
			"aborted",
		]);
		for (const protoKey of ["toString", "constructor", "hasOwnProperty", "valueOf"]) {
			const r = new Roster();
			const { notices } = collect(r);
			r.applySpawn(spawn("w1"));
			r.applyLifecycle(lifecycle("w1", "started"));
			r.applyProgress(progress("w1", protoKey));
			const w = onlyWorker(r);
			expect(w.status).toBe("running");
			expect(WORKER_STATUSES.has(w.status)).toBe(true);
			expect(notices.length).toBeGreaterThanOrEqual(1);
		}
	});

	test("prototype-key status on a lifecycle frame also keeps last status + notice", () => {
		const r = new Roster();
		const { notices } = collect(r);
		r.applySpawn(spawn("w1"));
		r.applyLifecycle(lifecycle("w1", "started"));
		r.applyLifecycle(lifecycle("w1", "toString"));
		expect(onlyWorker(r).status).toBe("running");
		expect(notices.length).toBeGreaterThanOrEqual(1);
	});
});

describe("noticeLog bound (regression)", () => {
	test("notices() keeps only the last 100 entries; onNotice still delivers all", () => {
		const r = new Roster();
		const { notices } = collect(r);
		r.applySpawn(spawn("w1"));
		r.applyLifecycle(lifecycle("w1", "started"));
		for (let i = 0; i < 150; i++) {
			r.applyProgress(progress("w1", `bogus_${i}`));
		}
		expect(r.notices()).toHaveLength(100);
		expect(notices.length).toBe(150);
		const kept = r.notices();
		expect(kept[0]).toContain("bogus_50");
		expect(kept.at(-1)).toContain("bogus_149");
	});
});
