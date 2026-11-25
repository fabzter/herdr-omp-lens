/**
 * Host-less transcript rendering (P3-R4 / P3-R5, RC-15, D4).
 *
 * The viewer renders a worker transcript through OMP's own production
 * pipeline: `omp render <sessionFile>` — verified host-less (exit 0) in the
 * Phase 0 probe report; `omp read <id>` over the session registry needs the
 * owning live session and is NEVER used here (RC-15).
 *
 * `omp render` has no thinking flag (omp 19.1.1): thinking blocks are only
 * visually distinct via ANSI colour, which `--plain` strips to
 * indistinguishable text. D4 default-hidden is therefore implemented as a
 * pre-filter: the session JSONL is copied to a temp file with every
 * `{"type":"thinking"}` content item removed, and the filtered copy is what
 * gets rendered. `opts.thinking=true` renders the original file untouched.
 *
 * Output is bounded (`maxBytes`): the child is killed once the cap is
 * reached and the result is cut at a line boundary with a truncation
 * marker. `tailSessionFile` reads only the last `maxBytes` of the JSONL and
 * is torn-line tolerant (U-OMP-7): a truncated trailing line is dropped,
 * a valid JSON final line without \n is kept.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Minimal child-process shape needed by the renderer (Bun.spawn seam for tests). */
export interface RenderProcess {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill: () => void;
}

export type RenderSpawn = (cmd: string[]) => RenderProcess | Promise<RenderProcess>;

export interface RenderTranscriptOptions {
	/** Show thinking blocks. Default FALSE — thinking is hidden (D4). */
	thinking?: boolean;
	/** omp binary to invoke. Default "omp" (resolved via PATH). */
	ompBin?: string;
	/** Hard cap on returned stdout bytes. Default 1 MiB. */
	maxBytes?: number;
	/** Strip ANSI styling from render output. Default true. */
	plain?: boolean;
	/** Injectable spawn (tests). Default Bun.spawn. */
	spawn?: RenderSpawn;
}

export interface TailResult {
	/** Complete JSONL lines, oldest→newest, bounded by maxBytes/maxLines. */
	lines: string[];
	/** True when earlier bytes/lines were dropped to satisfy the bounds. */
	truncated: boolean;
}

export interface TailOptions {
	/** Read window from EOF. Default 256 KiB. */
	maxBytes?: number;
	/** Max returned lines. Default 500. */
	maxLines?: number;
}

const DEFAULT_RENDER_MAX_BYTES = 1024 * 1024;
const DEFAULT_TAIL_MAX_BYTES = 256 * 1024;
const DEFAULT_TAIL_MAX_LINES = 500;
const TRUNCATION_MARKER = "\n… [output truncated]";
const STDERR_MAX_BYTES = 64 * 1024;
/**
 * `omp render` argv. Host-less: a session FILE path, never a registry URI
 * (those are only reachable from the owning live session, RC-15).
 */
export function buildRenderArgv(
	ompBin: string,
	sessionFile: string,
	opts?: { plain?: boolean },
): string[] {
	const argv = [ompBin, "render", sessionFile];
	if (opts?.plain !== false) {
		argv.push("--plain");
	}
	return argv;
}

/**
 * Remove `{type:"thinking"}` items from `message` entries' `message.content`
 * arrays. Lines that fail to parse, or contain no thinking marker at all,
 * pass through verbatim (torn-line and future-format tolerant). Session
 * JSONL has no schema module; fields are checked structurally.
 */
export function filterThinkingLines(lines: string[]): string[] {
	return lines.map((line) => {
		if (!line.includes('"thinking"')) {
			return line;
		}
		let obj: unknown;
		try {
			obj = JSON.parse(line);
		} catch {
			return line;
		}
		if (typeof obj !== "object" || obj === null || !("type" in obj) || obj.type !== "message") {
			return line;
		}
		if (!("message" in obj)) {
			return line;
		}
		const msg = obj.message;
		if (typeof msg !== "object" || msg === null || !("content" in msg)) {
			return line;
		}
		const content = msg.content;
		if (!Array.isArray(content)) {
			return line;
		}
		const filtered = content.filter(
			(c) => !(typeof c === "object" && c !== null && "type" in c && c.type === "thinking"),
		);
		if (filtered.length === content.length) {
			return line;
		}
		return JSON.stringify({ ...obj, message: { ...msg, content: filtered } });
	});
}

async function collectStream(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
	onCap: () => void,
): Promise<{ bytes: Uint8Array; capped: boolean }> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let capped = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (total + value.byteLength > maxBytes) {
				const keep = Math.max(0, maxBytes - total);
				if (keep > 0) {
					chunks.push(value.subarray(0, keep));
				}
				total += keep;
				capped = true;
				onCap();
				break;
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		bytes.set(c, off);
		off += c.byteLength;
	}
	return { bytes, capped };
}

function lastCompleteLines(text: string): string {
	const cut = text.lastIndexOf("\n");
	return cut <= 0 ? "" : text.slice(0, cut);
}

/**
 * Render one worker session file through `omp render <file>` (host-less,
 * RC-15). Resolves to the bounded renderer output; throws on non-zero exit
 * with the stderr tail attached.
 */
export async function renderWorkerTranscript(
	sessionFile: string,
	opts: RenderTranscriptOptions = {},
): Promise<string> {
	const thinking = opts.thinking ?? false;
	const maxBytes = opts.maxBytes ?? DEFAULT_RENDER_MAX_BYTES;
	const spawn: RenderSpawn =
		opts.spawn ??
		((cmd: string[]) => Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" }) as RenderProcess);

	// D4: thinking hidden by default → render a filtered temp copy so the
	// renderer never sees thinking content (it has no --thinking flag).
	// The temp dir lives inside the same try/finally as the spawn: any throw
	// between mkdtempSync and the write (OOM on the filtered join, a failing
	// Bun.write) must still remove it instead of leaking it in $TMPDIR.
	let renderPath = sessionFile;
	let tmpDir: string | null = null;
	try {
		if (!thinking) {
			const source = await Bun.file(sessionFile).text();
			if (source.includes('"thinking"')) {
				tmpDir = mkdtempSync(join(tmpdir(), "lens-render-"));
				renderPath = join(tmpDir, "filtered.jsonl");
				const filtered = filterThinkingLines(source.split("\n")).join("\n");
				await Bun.write(renderPath, filtered.endsWith("\n") ? filtered : `${filtered}\n`);
			}
		}

		const proc = await spawn(
			buildRenderArgv(opts.ompBin ?? "omp", renderPath, { plain: opts.plain }),
		);
		const [out, err] = await Promise.all([
			collectStream(proc.stdout, maxBytes, () => proc.kill()),
			// stderr is only a 500B tail on the error path — bound the buffer so
			// a chatty renderer can't pin unbounded memory (drain, don't kill).
			collectStream(proc.stderr, STDERR_MAX_BYTES, () => {}),
		]);
		const code = await proc.exited;
		const text = new TextDecoder().decode(out.bytes);
		const errText = new TextDecoder().decode(err.bytes);
		if (out.capped) {
			return `${lastCompleteLines(text)}${TRUNCATION_MARKER}`;
		}
		if (code !== 0) {
			throw new Error(`omp render exited ${code}: ${errText.trim().slice(-500)}`);
		}
		return text;
	} finally {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}
}

/**
 * Bounded tail of a session JSONL for live-tail display (P3-R5, U-OMP-7).
 * Reads only the last `maxBytes`; a sliced leading partial line is dropped,
 * and a final line is kept only if it ends with \n or parses as JSON
 * (a mid-write torn line fails JSON.parse and is dropped).
 */
export async function tailSessionFile(
	sessionFile: string,
	opts: TailOptions = {},
): Promise<TailResult> {
	const maxBytes = opts.maxBytes ?? DEFAULT_TAIL_MAX_BYTES;
	const maxLines = opts.maxLines ?? DEFAULT_TAIL_MAX_LINES;

	const file = Bun.file(sessionFile);
	const size = await file.size;
	if (size === 0) {
		return { lines: [], truncated: false };
	}
	const start = Math.max(0, size - maxBytes);
	const text = await file.slice(start, size).text();

	let parts = text.split("\n");
	if (parts[parts.length - 1] === "") {
		parts = parts.slice(0, -1);
	} else {
		const last = parts[parts.length - 1] ?? "";
		try {
			JSON.parse(last); // unterminated but complete → keep
		} catch {
			parts = parts.slice(0, -1); // torn mid-write line → drop
		}
	}
	if (start > 0 && parts.length > 0) {
		parts = parts.slice(1); // drop the sliced leading partial line
	}
	const truncated = start > 0 || parts.length > maxLines;
	if (parts.length > maxLines) {
		parts = parts.slice(parts.length - maxLines);
	}
	return { lines: parts.filter((l) => l.length > 0), truncated };
}
