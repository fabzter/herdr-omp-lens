import { describe, expect, test } from "bun:test";
import {
	type ParseResult,
	parseSubagentEvent,
	parseSubagentLifecycle,
	parseSubagentProgress,
	parseSubagentSpawn,
} from "../../../src/extension/observe/schemas";

// Verbatim frame lines from probes/out/frames.jsonl (LensProbe run, persisted-session follow-up).
const SPAWN_FRAME = String.raw`{"channel":"hook:before_subagent_spawn","t":1795150241278,"payload":{"type":"before_subagent_spawn","agent":"scout","invocationKind":"task","modelRole":"smol","patterns":["devin/swe-2:max"],"spawnKey":"LensProbe"}}`;
const LIFECYCLE_STARTED_FRAME = String.raw`{"channel":"task:subagent:lifecycle","t":1795150241351,"payload":{"id":"LensProbe","agent":"scout","parentToolCallId":"call_44d397eead744f6c9aac5cff","detached":true,"agentSource":"bundled","status":"started","sessionFile":"/var/folders/vm/tn_yl921169f6wxhx0h119th0000gn/T/omp-task-15d5200b7f8a9636/LensProbe.jsonl","index":0}}`;
const LIFECYCLE_COMPLETED_FRAME = String.raw`{"channel":"task:subagent:lifecycle","t":1795150248856,"payload":{"id":"LensProbe","agent":"scout","parentToolCallId":"call_44d397eead744f6c9aac5cff","detached":true,"agentSource":"bundled","status":"completed","sessionFile":"/var/folders/vm/tn_yl921169f6wxhx0h119th0000gn/T/omp-task-15d5200b7f8a9636/LensProbe.jsonl","index":0}}`;
const EVENT_AGENT_START_FRAME = `{"channel":"task:subagent:event","t":1795150241364,"payload":{"id":"LensProbe","event":{"type":"agent_start"}}}`;
const EVENT_MESSAGE_END_FRAME = String.raw`{"channel":"task:subagent:event","t":1795150241366,"payload":{"id":"LensProbe","event":{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"Complete assignment thoroughly:\n\nReply with the single word ok"}],"attribution":"agent","timestamp":1795150241352}}}}`;
const PROGRESS_COMPLETED_FRAME = String.raw`{"channel":"task:subagent:progress","t":1795150248856,"payload":{"index":0,"agent":"scout","agentSource":"bundled","task":"Complete assignment thoroughly:\n\nReply with the single word ok","parentToolCallId":"call_44d397eead744f6c9aac5cff","detached":true,"assignment":"Reply with the single word ok","progress":{"index":0,"id":"LensProbe","agent":"scout","agentSource":"bundled","status":"completed","task":"Complete assignment thoroughly:\n\nReply with the single word ok","assignment":"Reply with the single word ok","recentTools":[{"tool":"yield","args":"","isError":false,"endMs":1795150248843}],"recentOutput":[],"toolCount":1,"requests":2,"tokens":14114,"cost":0.0085106,"durationMs":7576,"modelOverride":["devin/swe-2:max"],"modelRole":"smol","contextWindow":262000,"resolvedModelIdentity":"devin/swe-2","resolvedThinkingLevel":"medium","resolvedModel":"devin/swe-2:medium","contextTokens":13823,"extractedToolData":{"yield":[{"data":{"summary":"ok","files":[],"architecture":"Connectivity probe only; no repository or files involved."},"status":"success"}]}},"sessionFile":"/var/folders/vm/tn_yl921169f6wxhx0h119th0000gn/T/omp-task-15d5200b7f8a9636/LensProbe.jsonl"}}`;

function payloadOf(frame: string): unknown {
	const parsed: unknown = JSON.parse(frame);
	if (typeof parsed === "object" && parsed !== null && "payload" in parsed) {
		return parsed.payload;
	}
	throw new Error("fixture frame has no payload");
}

const NON_OBJECT_INPUTS: readonly unknown[] = [null, undefined, 42, "text", true, [], {}];

describe("parseSubagentSpawn", () => {
	test("parses before_subagent_spawn with spawnKey and no parentToolCallId", () => {
		const result = parseSubagentSpawn(payloadOf(SPAWN_FRAME));
		if (!result.ok) throw new Error("expected ok");
		expect(result.value.type).toBe("before_subagent_spawn");
		expect(result.value.spawnKey).toBe("LensProbe");
		expect(result.value.agent).toBe("scout");
		expect(result.value.modelRole).toBe("smol");
		expect(result.value.patterns).toEqual(["devin/swe-2:max"]);
		expect(result.value).not.toHaveProperty("parentToolCallId");
	});

	test("rejects a frame without spawnKey", () => {
		const { spawnKey: _omit, ...rest } = payloadOf(SPAWN_FRAME) as Record<string, unknown>;
		expect(parseSubagentSpawn(rest).ok).toBe(false);
	});
});

describe("parseSubagentLifecycle", () => {
	test("parses started frame", () => {
		const result = parseSubagentLifecycle(payloadOf(LIFECYCLE_STARTED_FRAME));
		if (!result.ok) throw new Error("expected ok");
		expect(result.value.id).toBe("LensProbe");
		expect(result.value.status).toBe("started");
		expect(result.value.parentToolCallId).toBe("call_44d397eead744f6c9aac5cff");
		expect(result.value.sessionFile).toEndWith("LensProbe.jsonl");
		expect(result.value.index).toBe(0);
		expect(result.value.detached).toBe(true);
	});

	test("parses completed frame", () => {
		const result = parseSubagentLifecycle(payloadOf(LIFECYCLE_COMPLETED_FRAME));
		if (!result.ok) throw new Error("expected ok");
		expect(result.value.status).toBe("completed");
	});

	test("rejects a frame without status", () => {
		const { status: _omit, ...rest } = payloadOf(LIFECYCLE_STARTED_FRAME) as Record<
			string,
			unknown
		>;
		expect(parseSubagentLifecycle(rest).ok).toBe(false);
	});
});

describe("parseSubagentProgress", () => {
	test("reads counters from nested .progress envelope", () => {
		const result = parseSubagentProgress(payloadOf(PROGRESS_COMPLETED_FRAME));
		if (!result.ok) throw new Error("expected ok");
		expect(result.value.parentToolCallId).toBe("call_44d397eead744f6c9aac5cff");
		expect(result.value.detached).toBe(true);
		expect(result.value.progress.id).toBe("LensProbe");
		expect(result.value.progress.status).toBe("completed");
		expect(result.value.progress.tokens).toBe(14114);
		expect(result.value.progress.cost).toBe(0.0085106);
		expect(result.value.progress.requests).toBe(2);
		expect(result.value.progress.toolCount).toBe(1);
		expect(result.value.progress.durationMs).toBe(7576);
		expect(result.value.progress.recentTools?.[0]?.tool).toBe("yield");
		expect(result.value.progress.modelRole).toBe("smol");
	});

	test("rejects counters placed at top level instead of nested progress", () => {
		const flat = {
			index: 0,
			id: "LensProbe",
			status: "running",
			tokens: 5,
		};
		expect(parseSubagentProgress(flat).ok).toBe(false);
	});
});

describe("parseSubagentEvent", () => {
	test("parses agent_start event", () => {
		const result = parseSubagentEvent(payloadOf(EVENT_AGENT_START_FRAME));
		if (!result.ok) throw new Error("expected ok");
		expect(result.value.id).toBe("LensProbe");
		expect(result.value.event.type).toBe("agent_start");
	});

	test("tolerates extra event keys (message_end carries a message)", () => {
		const result = parseSubagentEvent(payloadOf(EVENT_MESSAGE_END_FRAME));
		if (!result.ok) throw new Error("expected ok");
		expect(result.value.event.type).toBe("message_end");
		expect(result.value.event).toHaveProperty("message");
	});

	test("rejects an event without a type", () => {
		expect(parseSubagentEvent({ id: "LensProbe", event: {} }).ok).toBe(false);
	});
});

describe("parse helpers never throw", () => {
	test("non-object and wrong-shape inputs return ok:false", () => {
		const parsers = [
			parseSubagentSpawn,
			parseSubagentLifecycle,
			parseSubagentProgress,
			parseSubagentEvent,
		];
		for (const parse of parsers) {
			for (const input of NON_OBJECT_INPUTS) {
				let result: ParseResult<unknown> | undefined;
				expect(() => {
					result = parse(input);
				}).not.toThrow();
				expect(result?.ok).toBe(false);
			}
		}
	});

	test("failure carries a ZodError", () => {
		const result = parseSubagentSpawn({ type: "before_subagent_spawn" });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.error).toBeInstanceOf(Error);
	});
});
