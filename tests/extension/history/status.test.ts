import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	boundedTailReadFile,
	mapTerminalStatus,
	mapTranscriptToSnapshot,
} from "../../../src/extension/history";

/**
 * Fixture shape mirrors a real worker JSONL (verified 2026-11-24):
 * terminal marker is the last line
 * `{type:"custom",customType:"session_exit",data:{reason,kind,recordedAt}}`.
 */
const PROJECT_DIR = "/proj/a";
const PARENT = `${PROJECT_DIR}/2026-11-24T09-00-00.000Z_parent.jsonl`;

const header = (id: string) =>
	JSON.stringify({
		type: "session",
		version: 3,
		id,
		cwd: "/proj/a",
		parentSession: PARENT,
	});
const modelChange = (id: string) =>
	JSON.stringify({
		type: "model_change",
		model: "devin/swe-2",
		role: `subagent:${id}`,
	});
const msg = JSON.stringify({ type: "message", role: "assistant" });
const sessionExit = (kind: string, reason = "dispose") =>
	JSON.stringify({
		type: "custom",
		customType: "session_exit",
		data: { reason, kind, recordedAt: 1700000001000 },
	});

describe("mapTerminalStatus (P5-R4)", () => {
	test('kind "normal" -> completed', () => {
		expect(mapTerminalStatus([msg, sessionExit("normal")])).toBe("completed");
	});
	test('kind "signal" -> aborted', () => {
		expect(mapTerminalStatus([msg, sessionExit("signal", "sigterm")])).toBe("aborted");
	});
	test('kind "error" -> failed', () => {
		expect(mapTerminalStatus([msg, sessionExit("error")])).toBe("failed");
	});
	test("no terminal marker -> aborted", () => {
		expect(mapTerminalStatus([msg, '{"type":"mess'])).toBe("aborted");
	});
	test("empty transcript -> aborted", () => {
		expect(mapTerminalStatus([])).toBe("aborted");
	});
	test("last terminal marker wins over an earlier one", () => {
		expect(mapTerminalStatus([sessionExit("signal", "sigterm"), sessionExit("normal")])).toBe(
			"completed",
		);
	});
});

describe("mapTranscriptToSnapshot status mapping (P5-R4)", () => {
	test("completed transcript maps completed, counters absent, historical", () => {
		const w = mapTranscriptToSnapshot(
			"w1",
			"/s/w1.jsonl",
			[header("w1"), modelChange("w1"), msg, sessionExit("normal")],
			1,
			PROJECT_DIR,
		);
		expect(w?.status).toBe("completed");
		expect(w?.counters).toBeUndefined();
		expect(w?.historical).toBe(true);
	});
	test("signal-terminated transcript maps aborted", () => {
		const w = mapTranscriptToSnapshot(
			"w2",
			"/s/w2.jsonl",
			[header("w2"), modelChange("w2"), msg, sessionExit("signal", "sigterm")],
			1,
			PROJECT_DIR,
		);
		expect(w?.status).toBe("aborted");
	});
	test("error-terminated transcript maps failed", () => {
		const w = mapTranscriptToSnapshot(
			"w3",
			"/s/w3.jsonl",
			[header("w3"), modelChange("w3"), msg, sessionExit("error")],
			1,
			PROJECT_DIR,
		);
		expect(w?.status).toBe("failed");
	});
	test("truncated transcript maps aborted", () => {
		const w = mapTranscriptToSnapshot(
			"w4",
			"/s/w4.jsonl",
			[header("w4"), modelChange("w4"), '{"type":"mess'],
			1,
			PROJECT_DIR,
		);
		expect(w?.status).toBe("aborted");
	});
});
describe("statusLines tail window (P5-R4, review round 1)", () => {
	test("status derives from tail lines when provided, not the head", () => {
		// Head window: header + torn tail, marker truncated away. Tail
		// window: carries the session_exit marker.
		const head = [header("wb"), modelChange("wb"), '{"type":"mess'];
		const tail = ["", sessionExit("normal")];
		const w = mapTranscriptToSnapshot("wb", "/s/wb.jsonl", head, 1, PROJECT_DIR, tail);
		expect(w?.status).toBe("completed");
		expect(w?.model).toBe("devin/swe-2"); // head still drives model
	});

	test("boundedTailReadFile returns only the last maxBytes bytes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-lens-tail-"));
		const p = join(dir, "t.jsonl");
		writeFileSync(p, `${"a".repeat(50)}\n${sessionExit("normal")}\n`);
		const tail = await boundedTailReadFile(p, "utf8", 90);
		expect(tail.length).toBe(90);
		expect(tail).toContain("session_exit");
		expect(tail.endsWith("\n")).toBe(true);
	});
});
