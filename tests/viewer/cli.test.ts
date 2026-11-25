import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Socket, SocketListener } from "bun";
import { resolveViewerCommand } from "../../src/extension/resolve";
import type { WorkerSnapshot } from "../../src/protocol/types";
import {
	handleKey,
	keyFor,
	READONLY_ACTIONS,
	type RunViewerDeps,
	resolveViewerConfig,
	runViewer,
	viewerEnv,
} from "../../src/viewer/cli";
import { initialViewerState } from "../../src/viewer/state";

const VIEWER_SRC = fileURLToPath(new URL("../../src/viewer", import.meta.url));

function snap(id: string, over: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
	return { id, agent: "task", status: "running", updatedAt: 1_000, ...over };
}

describe("viewerEnv (F-01 handoff, spec env.ts)", () => {
	test("reads LENS_SOCKET_PATH + LENS_SESSION; workerId optional", () => {
		expect(
			viewerEnv({
				LENS_SOCKET_PATH: "/tmp/bridge.sock",
				LENS_SESSION: "sess-1",
			}),
		).toEqual({ socketPath: "/tmp/bridge.sock", session: "sess-1" });
		expect(
			viewerEnv({
				LENS_SOCKET_PATH: "/tmp/bridge.sock",
				LENS_SESSION: "sess-1",
				LENS_WORKER_ID: "w-1",
			}),
		).toEqual({ socketPath: "/tmp/bridge.sock", session: "sess-1", workerId: "w-1" });
	});

	test("missing socket or session returns null (P4 owns the launch)", () => {
		expect(viewerEnv({})).toBeNull();
		expect(viewerEnv({ LENS_SESSION: "s" })).toBeNull();
		expect(viewerEnv({ LENS_SOCKET_PATH: "/x" })).toBeNull();
	});
});

describe("resolveViewerConfig — argv/env worker scope (D3)", () => {
	const env = {
		LENS_SOCKET_PATH: "/tmp/bridge.sock",
		LENS_SESSION: "sess-1",
	};

	test("LENS_WORKER_ID scopes the viewer", () => {
		const cfg = resolveViewerConfig({ ...env, LENS_WORKER_ID: "w-9" }, []);
		expect(cfg).toEqual({
			socketPath: "/tmp/bridge.sock",
			session: "sess-1",
			workerId: "w-9",
		});
	});

	test("--worker <id> wins over LENS_WORKER_ID", () => {
		const cfg = resolveViewerConfig({ ...env, LENS_WORKER_ID: "env-w" }, ["--worker", "arg-w"]);
		expect(cfg.workerId).toBe("arg-w");
	});

	test("--worker=<id> form is accepted", () => {
		const cfg = resolveViewerConfig(env, ["--worker=eq-w"]);
		expect(cfg.workerId).toBe("eq-w");
	});

	test("unknown args, missing value, and missing env are rejected", () => {
		expect(() => resolveViewerConfig(env, ["--bogus"])).toThrow();
		expect(() => resolveViewerConfig(env, ["--worker"])).toThrow();
		expect(() => resolveViewerConfig(env, ["extra"])).toThrow();
		expect(() => resolveViewerConfig({}, [])).toThrow();
	});
});

describe("entry wiring (F-16)", () => {
	test("resolveViewerCommand resolves to the real cli.ts", () => {
		expect(existsSync(resolveViewerCommand())).toBe(true);
		expect(resolveViewerCommand().endsWith("cli.ts")).toBe(true);
	});
});

describe("read-only keyboard map (P3-R7 accept: keyboard-map audit)", () => {
	test("keyFor maps every bound key to a declared read-only action", () => {
		for (const key of ["j", "k", "\x1b[A", "\x1b[B", "\r", " ", "e", "t", "r", "q", "\x03"]) {
			expect(READONLY_ACTIONS[keyFor(key)]).toBe(true);
		}
	});

	test("unmapped keys are none; there is no send/steer/stop binding", () => {
		for (const key of ["s", "x", "c", "S", "!", "K", "\x1b[C", "\x1b[D"]) {
			expect(keyFor(key)).toBe("none");
		}
	});

	test("handleKey is pure: j/k move selection, e toggles collapse, t toggles thinking", () => {
		let s = initialViewerState({
			live: true,
			workers: new Map([
				["a", snap("a")],
				["b", snap("b")],
			]),
		});
		s = handleKey(s, "selectNext");
		expect(s.selectedId).toBe("a");
		s = handleKey(s, "selectNext");
		expect(s.selectedId).toBe("b");
		s = handleKey(s, "selectPrev");
		expect(s.selectedId).toBe("a");
		s = handleKey(s, "toggleFinished");
		expect(s.finishedCollapsed).toBe(false);
		s = handleKey(s, "toggleThinking");
		expect(s.thinkingVisible).toBe(true);
	});

	test("navigation skips finished workers while collapsed; expansion reveals them", () => {
		let s = initialViewerState({
			live: true,
			workers: new Map([
				["live-1", snap("live-1")],
				["done-1", snap("done-1", { status: "completed" })],
			]),
		});
		s = handleKey(s, "selectNext");
		expect(s.selectedId).toBe("live-1");
		s = handleKey(s, "selectNext");
		expect(s.selectedId).toBe("live-1"); // no wrap into collapsed section
		s = handleKey(s, "toggleFinished");
		s = handleKey(s, "selectNext");
		expect(s.selectedId).toBe("done-1");
	});

	test("quit is not a state mutation", () => {
		const s = initialViewerState({ selectedId: "a" });
		expect(handleKey(s, "quit")).toBe(s);
		expect(handleKey(s, "none")).toBe(s);
	});
});

/** Viewer sources — tamper guard scans the real files on disk. */
function viewerSources(): Map<string, string> {
	const sources = new Map<string, string>();
	for (const f of readdirSync(VIEWER_SRC)) {
		if (f.endsWith(".ts")) sources.set(f, readFileSync(join(VIEWER_SRC, f), "utf8"));
	}
	return sources;
}

describe("tamper guard — the viewer is an ordinary pane process (P3-R12, RC-7, NFR-04)", () => {
	test("no viewer file calls any forbidden pane/agent API or imports the pane adapter", () => {
		const forbidden = [
			/report_?metadata/i,
			/report_?agent/i,
			/agent\.start/,
			/agent\.focus/,
			/agent\.view\.set/,
			/layout\.apply/,
			/pane\.split/,
			/pane\.focus/,
			/pane\.send_?input/i,
			/tab\.create/,
			/workspace\.focus/,
			/\bfocus\s*:\s*true\b/, // focusing flag (RC-7)
			/runInPane/,
			/from\s+["'][^"']*herdr/, // viewer must not import the pane adapter
		];
		for (const [file, src] of viewerSources()) {
			for (const pattern of forbidden) {
				expect(pattern.test(src), `${file} matched ${pattern}`).toBe(false);
			}
		}
	});

	test("the only outbound frame is the handshake: no other socket write exists", () => {
		for (const [file, src] of viewerSources()) {
			// every s.write(/socket.write( must be the handshake line; stdout writes
			// go through the writer abstraction (paint), never a raw socket.
			const writes = src.match(/[^\w](?:s|socket)\.write\(([^)]*)\)/g) ?? [];
			for (const w of writes) {
				expect(w, `${file} writes ${w}`).toContain("handshakeLine");
			}
			expect(src).not.toMatch(/\.send\s*\(/);
		}
	});

	test("no viewer source contains a steering frame type", () => {
		for (const [, src] of viewerSources()) {
			expect(src).not.toMatch(/"control/);
			expect(src).not.toMatch(/type\s*:\s*["'](?:steer|revive|cancel|input)/);
		}
	});
});

/**
 * Scripted-session audit (P3-R7): a real fake bridge on a real unix socket
 * records every inbound byte across a full viewer run; the assertion is on
 * the wire, not on code shape. The only payload ever received is the
 * ClientMessage handshake.
 */
class RecordingBridge {
	readonly socketPath: string;
	readonly dir: string;
	readonly received: string[] = [];
	private readonly server: SocketListener;
	private readonly closed: Promise<void>;
	private readonly resolveClosed: () => void;
	private client: Socket | null = null;

	constructor(hello: string) {
		this.dir = mkdtempSync(join(tmpdir(), "lens-cli-test-"));
		this.socketPath = join(this.dir, "bridge.sock");
		const received = this.received;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.closed = promise;
		this.resolveClosed = resolve;
		const self = this;
		const resolveClosed = this.resolveClosed;
		this.server = Bun.listen({
			unix: this.socketPath,
			socket: {
				open(s: Socket) {
					self.client = s;
					s.write(`${hello}\n`);
				},
				data(_s: Socket, data: Buffer) {
					received.push(data.toString("utf8"));
				},
				close() {
					resolveClosed();
				},
			},
		});
	}

	/** Push a server→client frame mid-session (upserts, notices, …). */
	send(line: string): void {
		const s = this.client;
		if (s === null) throw new Error("no client connected");
		s.write(`${line}\n`);
	}

	async close(): Promise<void> {
		this.server.stop(true);
		try {
			await this.closed;
		} catch {
			// peer already gone
		}
		rmSync(this.dir, { recursive: true, force: true });
	}
}

const bridges: RecordingBridge[] = [];

afterEach(async () => {
	while (bridges.length > 0) {
		await bridges.pop()?.close();
	}
});

function helloFrame(session: string, workers: WorkerSnapshot[]): string {
	return JSON.stringify({ v: 1, type: "hello", session, workers });
}

/**
 * REALTIME: real sockets deliver on real I/O turns — fake timers cannot
 * drive delivery (same pattern as client.test.ts). The poll only bounds the
 * wait, it never orders events the protocol sequences.
 */
async function waitFor(cond: () => boolean, ms = 2_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 10));
	}
}

/**
 * Paint capture: `out.write` records every repaint; `whenPainted(needle)`
 * resolves off the paint event itself — real sockets drive real repaints, so
 * waits are event-driven, never wall-clock polls.
 */
interface RunFixture {
	deps: RunViewerDeps;
	paints: string[];
	whenPainted: (needle: string) => Promise<void>;
}

function runDeps(socketPath: string, over: Partial<RunViewerDeps> = {}): RunFixture {
	const paints: string[] = [];
	const waiters: { needle: string; resolve: () => void }[] = [];
	const flush = (): void => {
		const haystack = paints.join("");
		for (let i = waiters.length - 1; i >= 0; i -= 1) {
			const w = waiters[i];
			if (w !== undefined && haystack.includes(w.needle)) {
				w.resolve();
				waiters.splice(i, 1);
			}
		}
	};
	const whenPainted = (needle: string): Promise<void> => {
		if (paints.join("").includes(needle)) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		waiters.push({ needle, resolve });
		return promise;
	};
	const deps: RunViewerDeps = {
		env: { LENS_SOCKET_PATH: socketPath, LENS_SESSION: "sess-e2e" },
		argv: [],
		out: { write: (s: string) => paints.push(s) },
		err: { write: () => {} },
		renderTranscript: async () => "",
		onPaint: flush,
		...over,
	};
	return { deps, paints, whenPainted };
}

/** Yields keys once a paint containing `needle` has landed. */
async function* keysWhen(done: Promise<void>, keys: string): AsyncIterable<string> {
	await done;
	yield keys;
}

describe("runViewer — scripted session", () => {
	test("connects, handshakes, paints the roster; quit exits 0; only outbound bytes are the handshake (P3-R7)", async () => {
		const bridge = new RecordingBridge(
			helloFrame("sess-e2e", [snap("a", { name: "alpha" }), snap("b")]),
		);
		bridges.push(bridge);
		const { deps, paints, whenPainted } = runDeps(bridge.socketPath);
		deps.keys = keysWhen(whenPainted("alpha"), "q");
		const code = await runViewer(deps);
		expect(code).toBe(0);
		expect(paints.length).toBeGreaterThan(0);
		const screen = paints.join("");
		expect(screen).toContain("sess-e2e");
		expect(screen).toContain("alpha");
		// wire audit: everything the bridge ever received is one handshake line
		await waitFor(() => bridge.received.length > 0);
		const inbound = bridge.received.join("");
		expect(inbound.trim().split("\n")).toHaveLength(1);
		const handshake = JSON.parse(inbound.trim());
		expect(handshake).toEqual({ v: 1, role: "viewer", session: "sess-e2e" });
	});

	test("worker-scoped launch filters the screen to the scoped id only", async () => {
		const bridge = new RecordingBridge(
			helloFrame("sess-e2e", [snap("in-scope", { name: "scoped" }), snap("out-of-scope")]),
		);
		bridges.push(bridge);
		const { deps, paints, whenPainted } = runDeps(bridge.socketPath, {
			env: {
				LENS_SOCKET_PATH: bridge.socketPath,
				LENS_SESSION: "sess-e2e",
				LENS_WORKER_ID: "in-scope",
			},
		});
		deps.keys = keysWhen(whenPainted("scoped"), "q");
		const code = await runViewer(deps);
		expect(code).toBe(0);
		const screen = paints.join("");
		expect(screen).toContain("scoped");
		expect(screen).not.toContain("out-of-scope");
	});

	test("transcript render failures surface as an error, not a crash (FR-12)", async () => {
		const bridge = new RecordingBridge(
			helloFrame("sess-e2e", [snap("a", { sessionFile: "/tmp/missing.jsonl" })]),
		);
		bridges.push(bridge);
		const { deps, paints, whenPainted } = runDeps(bridge.socketPath, {
			renderTranscript: async () => {
				throw new Error("omp render exited 1: no such file");
			},
		});
		deps.keys = keysWhen(whenPainted("no such file"), "q");
		const code = await runViewer(deps);
		expect(code).toBe(0);
		expect(paints.join("")).toContain("no such file");
	});

	test("missing env exits non-zero with a usage hint, without connecting", async () => {
		let connected = false;
		const errors: string[] = [];
		const code = await runViewer({
			env: {},
			argv: [],
			connect: async () => {
				connected = true;
				throw new Error("must not connect");
			},
			out: { write: () => {} },
			err: { write: (s: string) => errors.push(s) },
		});
		expect(code).not.toBe(0);
		expect(connected).toBe(false);
		expect(errors.join("")).toContain("LENS_SOCKET_PATH");
	});
});
