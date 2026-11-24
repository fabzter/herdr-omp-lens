import { describe, expect, test } from "bun:test";
import { decodeClientMessage, decodeMessage, encodeMessage } from "../../src/protocol/codec";
import type { ClientMessage, Message, WorkerSnapshot } from "../../src/protocol/types";
import { PROTOCOL_VERSION } from "../../src/protocol/types";

const NOW = 1_763_900_000_000;

/** Every optional field populated (spec WorkerSnapshot shape verbatim). */
const fullWorker: WorkerSnapshot = {
	id: "w1",
	name: "impl-task-2",
	agent: "task",
	status: "running",
	model: "devin/swe-2",
	activity: "editing src/protocol/codec.ts",
	sessionFile: "/Users/x/.omp/agent/sessions/repo/ts_id.jsonl",
	counters: {
		tokens: 12345,
		cost: 0.42,
		requests: 7,
		toolCount: 19,
		durationMs: 61_000,
	},
	parentToolCallId: "call_abc123",
	index: 1,
	modelRole: "reviewer",
	thinkingLevel: "high",
	assignment: "protocol codec",
	historical: false,
	updatedAt: NOW,
};

const bareWorker: WorkerSnapshot = {
	id: "w2",
	agent: "main",
	status: "idle",
	updatedAt: NOW - 5_000,
};

const hello: Message = {
	v: PROTOCOL_VERSION,
	type: "hello",
	session: "sess-1",
	workers: [fullWorker],
	history: [bareWorker],
};

describe("encodeMessage", () => {
	test("emits JSON.stringify(m) + trailing newline", () => {
		expect(encodeMessage(hello)).toBe(`${JSON.stringify(hello)}\n`);
	});
});

describe("decodeMessage round-trips", () => {
	test("hello with fully-populated worker and history", () => {
		const result = decodeMessage(encodeMessage(hello));
		expect(result).toEqual({ ok: true, message: hello });
	});

	test.each<Message>([
		{ v: 1, type: "worker.upsert", worker: fullWorker },
		{ v: 1, type: "worker.removed", id: "w1" },
		{
			v: 1,
			type: "transcript.ref",
			id: "w1",
			sessionFile: "/tmp/sess.jsonl",
			artifactDir: "/tmp/art",
		},
		{ v: 1, type: "transcript.ref", id: "w2", sessionFile: "/tmp/s2.jsonl" },
		{
			v: 1,
			type: "topology",
			tabId: "w1:t1",
			paneIds: ["w1:p1", "w1:p2"],
			state: "open",
		},
		{ v: 1, type: "topology", paneIds: [], state: "closed" },
		{ v: 1, type: "notice", level: "warn", message: "bridge degraded" },
	])("$type round-trips", (m) => {
		expect(decodeMessage(encodeMessage(m))).toEqual({ ok: true, message: m });
	});
});

describe("decodeMessage rejections (never throws)", () => {
	test("malformed JSON -> {ok:false}", () => {
		const result = decodeMessage("{not json");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(typeof result.error).toBe("string");
	});

	test.each(["42", "null", '"str"', "[]", "true"])("non-object JSON %s -> {ok:false}", (line) => {
		expect(decodeMessage(line).ok).toBe(false);
	});

	test("wrong protocol version -> {ok:false}", () => {
		const result = decodeMessage(JSON.stringify({ v: 2, type: "hello" }));
		expect(result.ok).toBe(false);
	});

	test("unknown type -> {ok:false}", () => {
		const result = decodeMessage(JSON.stringify({ v: 1, type: "control.steer", session: "s" }));
		expect(result.ok).toBe(false);
	});

	test("worker.upsert with bad status -> {ok:false}", () => {
		const result = decodeMessage(
			JSON.stringify({
				v: 1,
				type: "worker.upsert",
				worker: { id: "w", agent: "a", status: "sleeping", updatedAt: 1 },
			}),
		);
		expect(result.ok).toBe(false);
	});
});

describe("decodeClientMessage", () => {
	const viewer: ClientMessage = { v: 1, role: "viewer", session: "s1" };

	test("valid handshake -> {ok:true}", () => {
		expect(decodeClientMessage(JSON.stringify(viewer))).toEqual({
			ok: true,
			message: viewer,
		});
	});

	test("extra control.* field -> {ok:false} (strict boundary)", () => {
		const result = decodeClientMessage(
			JSON.stringify({
				v: 1,
				role: "viewer",
				session: "s",
				type: "control.steer",
			}),
		);
		expect(result.ok).toBe(false);
	});

	test("wrong role -> {ok:false}", () => {
		const result = decodeClientMessage(JSON.stringify({ v: 1, role: "admin", session: "s1" }));
		expect(result.ok).toBe(false);
	});

	test("missing session -> {ok:false}", () => {
		const result = decodeClientMessage(JSON.stringify({ v: 1, role: "viewer" }));
		expect(result.ok).toBe(false);
	});
});

describe("fixture: task:subagent:progress-derived worker.upsert", () => {
	test("nested progress counters map into WorkerSnapshot and round-trip", () => {
		// Observed Phase 0 envelope shape (F-02): counters live under
		// task:subagent:progress.progress.{tokens,cost,requests,toolCount,durationMs}.
		const progressFrame = {
			event: "task:subagent:progress",
			index: 0,
			agent: "task",
			parentToolCallId: "call_p9q8",
			assignment: "scan docs",
			progress: {
				status: "running",
				tokens: 5120,
				cost: 0.013,
				requests: 3,
				toolCount: 8,
				durationMs: 12_400,
			},
		};

		const worker: WorkerSnapshot = {
			id: `w${progressFrame.index}`,
			agent: progressFrame.agent,
			status: "running",
			parentToolCallId: progressFrame.parentToolCallId,
			index: progressFrame.index,
			assignment: progressFrame.assignment,
			counters: {
				tokens: progressFrame.progress.tokens,
				cost: progressFrame.progress.cost,
				requests: progressFrame.progress.requests,
				toolCount: progressFrame.progress.toolCount,
				durationMs: progressFrame.progress.durationMs,
			},
			updatedAt: NOW,
		};

		const upsert: Message = { v: 1, type: "worker.upsert", worker };
		expect(decodeMessage(encodeMessage(upsert))).toEqual({
			ok: true,
			message: upsert,
		});
	});
});
