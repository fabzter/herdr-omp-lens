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

	test("stamp-only upserts single-flight renders and keep last good text (P3-R11 bound)", async () => {
		const bridge = new RecordingBridge(
			helloFrame("sess-e2e", [snap("a", { sessionFile: "/tmp/a.jsonl", updatedAt: 1_000 })]),
		);
		bridges.push(bridge);

		// Controllable render spy: counts invocations and peak concurrency.
		let calls = 0;
		let inFlight = 0;
		let maxInFlight = 0;
		const gates: (() => void)[] = [];
		const renderSpy = async (_file: string, _thinking: boolean): Promise<string> => {
			calls += 1;
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			const n = calls;
			const { promise, resolve } = Promise.withResolvers<void>();
			gates.push(resolve);
			await promise;
			inFlight -= 1;
			return `rendered-${n}`;
		};
		const { deps, paints, whenPainted } = runDeps(bridge.socketPath, {
			renderTranscript: renderSpy,
		});

		// Stamp churn like a 150ms progress cadence: only updatedAt changes.
		const upsert = (stamp: number): string =>
			JSON.stringify({
				v: 1,
				type: "worker.upsert",
				worker: snap("a", { sessionFile: "/tmp/a.jsonl", updatedAt: stamp }),
			});

		// Drive the session asynchronously: upsert during each in-flight render,
		// then release the gate; last paint we quit on is rendered-3.
		const drive = (async () => {
			await whenPainted("transcript loading");
			bridge.send(upsert(2_000));
			await whenPainted("updated: 2000"); // applied during render-1 → pending
			bridge.send(upsert(3_000));
			await whenPainted("updated: 3000"); // coalesced with the pending refresh
			gates[0]?.(); // settle render-1 → ONE trailing render-2 (stamp 3000)
			await waitFor(() => gates.length >= 2); // render-2 invoked (REALTIME)
			bridge.send(upsert(4_000));
			await whenPainted("updated: 4000"); // pending during render-2
			gates[1]?.(); // settle render-2 → trailing render-3 (stamp 4000)
			await waitFor(() => gates.length >= 3);
			gates[2]?.();
			await whenPainted("rendered-3");
		})();
		deps.keys = (async function* () {
			await drive;
			// REALTIME: the fixed build paints "rendered-3" promptly off the
			// trailing render; a broken single-flight build never does — the
			// bounded fallback lets the assertions below run instead of hanging.
			await Promise.race([whenPainted("rendered-3"), Bun.sleep(400)]);
			yield "q";
		})();
		const code = await runViewer(deps);
		await drive;
		expect(code).toBe(0);

		// Single-flight: at most one child render at a time despite the churn.
		expect(maxInFlight).toBe(1);
		expect(calls).toBe(3);

		// No flicker: every paint after render-1 landed still shows text
		// (never falls back to "(transcript loading…)" on stamp-only refresh).
		const afterFirst = paints.slice(paints.findIndex((p) => p.includes("rendered-1")));
		expect(afterFirst.length).toBeGreaterThan(1);
		for (const p of afterFirst) {
			expect(p).not.toContain("transcript loading");
		}
		expect(paints.join("")).toContain("rendered-3");
	});

	test("identity change resets render dedup: reselecting a worker re-renders (F1)", async () => {
		const bridge = new RecordingBridge(
			helloFrame("sess-e2e", [
				snap("a", { sessionFile: "/tmp/a.jsonl", updatedAt: 1_000 }),
				snap("b"), // no sessionFile — transcriptTarget() is null for b
			]),
		);
		bridges.push(bridge);

		let calls = 0;
		const gates: (() => void)[] = [];
		const { deps, whenPainted } = runDeps(bridge.socketPath, {
			renderTranscript: async () => {
				calls += 1;
				const { promise, resolve } = Promise.withResolvers<void>();
				gates.push(resolve);
				await promise;
				return `rendered-${calls}`;
			},
		});

		deps.keys = (async function* () {
			await whenPainted("transcript loading"); // render-1 (worker a) in flight
			gates[0]?.(); // settle → "rendered-1" paints
			await whenPainted("rendered-1");
			yield "j"; // select b: identity → undefined, no render possible
			await whenPainted("no transcript yet");
			yield "k"; // reselect a: same stamp, but identity changed →
			// launchedKey must have been reset, else pump dedupes K_A===K_A
			// and the pane is stuck on "(transcript loading…)" forever.
			await whenPainted("rendered-2");
			yield "q";
		})();

		// Release render-2's gate as soon as it is invoked (REALTIME: spy
		// counter is the only observable between launch and settle).
		const driver = (async () => {
			await waitFor(() => gates.length >= 2);
			gates[1]?.();
		})();

		const code = await runViewer(deps);
		await driver;
		expect(code).toBe(0);
		expect(calls).toBe(2);
	});

	test("quit mid-render: no repaint and no new render after quit (F2)", async () => {
		const bridge = new RecordingBridge(
			helloFrame("sess-e2e", [snap("a", { sessionFile: "/tmp/a.jsonl", updatedAt: 1_000 })]),
		);
		bridges.push(bridge);

		let calls = 0;
		const gates: (() => void)[] = [];
		const { deps, paints, whenPainted } = runDeps(bridge.socketPath, {
			renderTranscript: async () => {
				calls += 1;
				const { promise, resolve } = Promise.withResolvers<void>();
				gates.push(resolve);
				await promise;
				return "rendered-1";
			},
		});

		deps.keys = (async function* () {
			await whenPainted("transcript loading"); // render-1 in flight
			// stamp churn while in-flight → pending refresh queued
			bridge.send(
				JSON.stringify({
					v: 1,
					type: "worker.upsert",
					worker: snap("a", { sessionFile: "/tmp/a.jsonl", updatedAt: 2_000 }),
				}),
			);
			await whenPainted("updated: 2000");
			yield "q"; // quit while render-1 is STILL in flight
		})();

		const code = await runViewer(deps);
		expect(code).toBe(0);
		const paintsAtQuit = paints.length;
		const callsAtQuit = calls;
		gates[0]?.(); // settle render-1 AFTER the viewer already exited
		// REALTIME: flush the microtask chain (spy resolve → slot/paint →
		// finally → pump) so a post-quit paint or spawn would be observable.
		for (let i = 0; i < 12; i += 1) await Promise.resolve();
		expect(paints.length, "post-quit repaint clobbers the shell").toBe(paintsAtQuit);
		expect(calls, "post-quit pump spawned a render child").toBe(callsAtQuit);
	});
});
