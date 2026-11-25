import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	buildRenderArgv,
	filterThinkingLines,
	renderWorkerTranscript,
	tailSessionFile,
} from "../../src/viewer/transcript";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "lens-transcript-test-"));
let seq = 0;

function tmpPath(prefix: string): string {
	seq += 1;
	return join(TMP_ROOT, `${prefix}-${seq}.jsonl`);
}

function writeJsonl(path: string, rows: unknown[], trailingPartial?: string): void {
	const lines = rows.map((r) => JSON.stringify(r)).join("\n");
	const body = lines + (trailingPartial !== undefined ? `\n${trailingPartial}` : "\n");
	writeFileSync(path, body);
}

function sessionRows(): unknown[] {
	return [
		{
			type: "session",
			version: 3,
			id: "fixture-p32",
			timestamp: "2026-11-24T21:11:15.501Z",
			cwd: "/tmp/fixture",
		},
		{
			type: "message",
			id: "m1",
			parentId: "s0",
			timestamp: "2026-11-24T21:11:16.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "Say hi" }],
				attribution: "user",
				timestamp: 1,
			},
		},
		{
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: "2026-11-24T21:11:17.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "SECRET_THINKING_TOKEN" },
					{ type: "text", text: "VISIBLE_TEXT_TOKEN" },
				],
				attribution: "assistant",
				timestamp: 2,
			},
		},
	];
}

interface FakeProc {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill: () => void;
}

function streamOf(text: string): ReadableStream<Uint8Array> {
	return new Response(new TextEncoder().encode(text)).body as ReadableStream<Uint8Array>;
}

function fakeSpawn(stdout: string, exitCode: number, calls: { cmd: string[] }[]) {
	return (cmd: string[]): FakeProc => {
		calls.push({ cmd: [...cmd] });
		return {
			stdout: streamOf(stdout),
			stderr: streamOf(""),
			exited: Promise.resolve(exitCode),
			kill: () => {},
		};
	};
}

describe("buildRenderArgv (RC-15 host-less render)", () => {
	test("spawns `omp render <sessionFile> --plain` by default; never history://", () => {
		const argv = buildRenderArgv("omp", "/sessions/w.jsonl");
		expect(argv[0]).toBe("omp");
		expect(argv[1]).toBe("render");
		expect(argv).toContain("/sessions/w.jsonl");
		expect(argv).toContain("--plain");
		for (const arg of argv) {
			expect(arg).not.toContain("history://");
		}
		expect(argv).not.toContain("read");
	});

	test("plain:false omits --plain", () => {
		expect(buildRenderArgv("omp", "/s.jsonl", { plain: false })).not.toContain("--plain");
	});
});

describe("filterThinkingLines (D4 default hidden)", () => {
	test("drops thinking items inside assistant message content", () => {
		const out = filterThinkingLines(sessionRows().map((r) => JSON.stringify(r)));
		const assistant = JSON.parse(out[2] ?? "") as {
			message: { content: { type: string; text?: string }[] };
		};
		expect(assistant.message.content).toEqual([{ type: "text", text: "VISIBLE_TEXT_TOKEN" }]);
	});

	test("leaves non-message and unparseable lines verbatim", () => {
		const junk = "{not json at all";
		const out = filterThinkingLines([junk, JSON.stringify(sessionRows()[0])]);
		expect(out[0]).toBe(junk);
	});
});

describe("renderWorkerTranscript", () => {
	test("returns renderer stdout; argv is `render <file>`, never history://", async () => {
		const calls: { cmd: string[] }[] = [];
		const file = tmpPath("w");
		writeJsonl(file, sessionRows());
		const out = await renderWorkerTranscript(file, {
			thinking: true,
			spawn: fakeSpawn("LINE1\nLINE2\n", 0, calls),
		});
		expect(out).toContain("LINE1");
		expect(calls[0]?.cmd[1]).toBe("render");
		for (const arg of calls[0]?.cmd ?? []) {
			expect(arg).not.toContain("history://");
		}
	});

	test("thinking hidden by default: renderer gets a filtered copy without thinking content", async () => {
		const captured: { path: string; text: string }[] = [];
		const file = tmpPath("w");
		writeJsonl(file, sessionRows());
		await renderWorkerTranscript(file, {
			spawn: async (cmd: string[]) => {
				const pathArg = cmd[cmd.indexOf("render") + 1];
				const text = await Bun.file(pathArg ?? "").text();
				captured.push({ path: pathArg ?? "", text });
				return {
					stdout: streamOf(text),
					stderr: streamOf(""),
					exited: Promise.resolve(0),
					kill: () => {},
				};
			},
		});
		expect(captured).toHaveLength(1);
		const renderedPath = captured[0]?.path ?? "";
		const renderedText = captured[0]?.text ?? "";
		expect(renderedPath).not.toBe(file); // filtered copy, not the raw session file
		expect(renderedText).not.toContain("SECRET_THINKING_TOKEN");
		expect(renderedText).toContain("VISIBLE_TEXT_TOKEN");
	});

	test("thinking=true renders the original file unfiltered", async () => {
		const calls: { cmd: string[] }[] = [];
		const file = tmpPath("w");
		writeJsonl(file, sessionRows());
		await renderWorkerTranscript(file, { thinking: true, spawn: fakeSpawn("", 0, calls) });
		expect(calls[0]?.cmd).toContain(file);
	});

	test("maxBytes caps output and marks truncation", async () => {
		const calls: { cmd: string[] }[] = [];
		const big = `${"x".repeat(10_000)}\n${"y".repeat(10_000)}`;
		const file = tmpPath("w");
		writeJsonl(file, sessionRows());
		const out = await renderWorkerTranscript(file, {
			thinking: true,
			maxBytes: 2_000,
			spawn: fakeSpawn(big, 0, calls),
		});
		expect(Buffer.byteLength(out)).toBeLessThanOrEqual(2_000);
		expect(out.toLowerCase()).toContain("truncated");
	});

	test("non-zero exit throws with stderr tail", async () => {
		const file = tmpPath("w");
		writeJsonl(file, sessionRows());
		const spawn = (): FakeProc => ({
			stdout: streamOf(""),
			stderr: streamOf("fatal: bad session"),
			exited: Promise.resolve(2),
			kill: () => {},
		});
		await expect(renderWorkerTranscript(file, { thinking: true, spawn })).rejects.toThrow(
			/fatal: bad session|exit 2/i,
		);
	});

	test("real `omp render` on a synthetic fixture exits 0 and hides thinking by default", async () => {
		const omp = Bun.which("omp");
		if (!omp) {
			return; // skip where omp is not installed
		}
		const file = tmpPath("w");
		writeJsonl(file, sessionRows());
		const hidden = await renderWorkerTranscript(file, { ompBin: omp, maxBytes: 1_000_000 });
		expect(hidden).toContain("VISIBLE_TEXT_TOKEN");
		expect(hidden).not.toContain("SECRET_THINKING_TOKEN");
		const shown = await renderWorkerTranscript(file, {
			ompBin: omp,
			thinking: true,
			maxBytes: 1_000_000,
		});
		expect(shown).toContain("SECRET_THINKING_TOKEN");
	});
});

describe("renderWorkerTranscript — resource bounds", () => {
	test("cleans up the temp filtered-copy dir when the filtered write throws", async () => {
		const file = tmpPath("w");
		writeJsonl(file, sessionRows()); // contains "thinking" → filtered-copy path
		const dirsBefore = readdirSync(tmpdir()).filter((d) => d.startsWith("lens-render-"));
		const realWrite = Bun.write;
		Bun.write = () => Promise.reject(new Error("disk full"));
		try {
			await expect(renderWorkerTranscript(file, { spawn: fakeSpawn("", 0, []) })).rejects.toThrow(
				"disk full",
			);
		} finally {
			Bun.write = realWrite;
		}
		const dirsAfter = readdirSync(tmpdir()).filter((d) => d.startsWith("lens-render-"));
		expect(dirsAfter).toEqual(dirsBefore);
	});

	test("stderr is capped: only a bounded tail reaches the error", async () => {
		const file = tmpPath("w");
		writeJsonl(file, sessionRows());
		let killed = false;
		const huge = "e".repeat(256 * 1024);
		const spawn = (): FakeProc => ({
			stdout: streamOf(""),
			stderr: streamOf(huge),
			exited: Promise.resolve(3),
			kill: () => {
				killed = true;
			},
		});
		const err = await renderWorkerTranscript(file, { thinking: true, spawn }).catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(Error);
		const msg = (err as Error).message;
		// entire 256KiB stderr must NOT be buffered into the message
		expect(msg.length).toBeLessThan(64 * 1024);
		expect(msg).toContain("e".repeat(100)); // bounded tail still attached
		expect(killed).toBe(false); // stderr cap drains instead of killing the render
	});
});

describe("tailSessionFile", () => {
	test("returns recent lines; drops torn trailing line", async () => {
		const file = tmpPath("w");
		const rows = sessionRows();
		writeJsonl(file, rows, '{"type":"message","incomplete-');
		const res = await tailSessionFile(file, { maxBytes: 10_000 });
		expect(res.truncated).toBe(false);
		expect(res.lines[res.lines.length - 1]).not.toContain("incomplete-");
		expect(res.lines.length).toBe(3);
	});

	test("mid-file byte offset drops the leading partial line and reports truncated", async () => {
		const file = tmpPath("w");
		const rows = sessionRows();
		writeJsonl(file, rows);
		const full = rows.map((r) => JSON.stringify(r));
		// 400 bytes covers the full last line (~267B) plus a slice of m1
		const res = await tailSessionFile(file, { maxBytes: 400 });
		expect(res.truncated).toBe(true);
		expect(res.lines.length).toBeGreaterThanOrEqual(1);
		for (const line of res.lines) {
			expect(full).toContain(line);
		}
	});
	test("maxLines bounds the returned lines", async () => {
		const file = tmpPath("w");
		const rows = sessionRows();
		writeJsonl(file, rows);
		const res = await tailSessionFile(file, { maxBytes: 1_000_000, maxLines: 2 });
		expect(res.lines.length).toBe(2);
		expect(res.lines[res.lines.length - 1]).toBe(JSON.stringify(rows[2]));
	});

	test("handles a file shorter than maxBytes with no trailing newline", async () => {
		const file = tmpPath("w");
		writeFileSync(file, '{"a":1}\n{"b":2}');
		const res = await tailSessionFile(file, { maxBytes: 10_000 });
		expect(res.lines).toEqual(['{"a":1}', '{"b":2}']);
		expect(res.truncated).toBe(false);
	});
});

describe("tamper guard (RC-15)", () => {
	test("src/viewer/transcript.ts never constructs a host-less history read", async () => {
		const src = await Bun.file(
			resolve(import.meta.dirname, "../../src/viewer/transcript.ts"),
		).text();
		expect(src).not.toMatch(/history:\/\//);
		expect(src).not.toContain('"read"');
		const argv = buildRenderArgv("omp", "x.jsonl");
		expect(argv.slice(0, 2)).toEqual(["omp", "render"]);
	});
});
