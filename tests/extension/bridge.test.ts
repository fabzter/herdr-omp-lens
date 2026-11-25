import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Socket } from "bun";
import { type BridgeHandle, startBridge } from "../../src/extension/bridge";
import type {
	SubagentLifecycle,
	SubagentProgress,
	SubagentSpawn,
} from "../../src/extension/observe/schemas";
import { Roster } from "../../src/extension/roster";
import { decodeMessage } from "../../src/protocol/codec";
import type { Message } from "../../src/protocol/types";

/**
 * Real unix-socket bridge tests: every client is a Bun.connect({unix}) peer
 * speaking the NDJSON handshake + message stream.
 *
 * Timing discipline: state changes are driven synchronously through the real
 * Roster; the only real-time waits are socket-delivery waits bounded by
 * waitFor's timeout (messages normally arrive on the next macrotask) and
 * documented short sleeps where the spec's 150 ms coalescing window must be
 * crossed (marked REALTIME). No sleeps are used to order events that the
 * protocol itself sequences.
 */

const COALESCE_MS = 40; // shrunk window; semantics identical to the 150 ms default

function spawn(spawnKey: string): SubagentSpawn {
	return { type: "before_subagent_spawn", agent: "scout", spawnKey };
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
	tokens: number,
	extra: Partial<SubagentProgress> = {},
): SubagentProgress {
	return { progress: { id, status: "running", tokens }, ...extra };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** NDJSON test client over a real unix socket. */
class Client {
	readonly messages: Message[] = [];
	private readonly waiters: Array<{
		pred: (m: Message) => boolean;
		resolve: (m: Message) => void;
		reject: (e: Error) => void;
		timer: NodeJS.Timeout;
	}> = [];
	readonly closed: Promise<void>;
	private resolveClosed!: () => void;

	private constructor(private readonly socket: Socket) {
		this.closed = new Promise<void>((resolve) => {
			this.resolveClosed = resolve;
		});
	}

	static async connect(socketPath: string): Promise<Client> {
		let client!: Client;
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		const socket = await Bun.connect({
			unix: socketPath,
			socket: {
				data(_socket: Socket, data: Buffer) {
					buffer += decoder.write(data);
					let nl = buffer.indexOf("\n");
					while (nl >= 0) {
						const line = buffer.slice(0, nl);
						buffer = buffer.slice(nl + 1);
						if (line.trim() !== "") client.onLine(line);
						nl = buffer.indexOf("\n");
					}
				},
				close() {
					client.resolveClosed();
				},
				connectError(_socket: Socket, error: unknown) {
					client.resolveClosed();
					throw error;
				},
			},
		});
		client = new Client(socket);
		return client;
	}

	private onLine(line: string): void {
		const decoded = decodeMessage(line);
		if (!decoded.ok) return;
		const m = decoded.message;
		this.messages.push(m);
		for (let i = this.waiters.length - 1; i >= 0; i--) {
			const w = this.waiters[i];
			if (w?.pred(m) === true) {
				this.waiters.splice(i, 1);
				clearTimeout(w.timer);
				w.resolve(m);
			}
		}
	}

	send(text: string): void {
		this.socket.write(text);
	}

	handshake(session = "sess-test"): void {
		this.send(`${JSON.stringify({ v: 1, role: "viewer", session })}\n`);
	}

	/** Resolves with the first already-or-soon-received message matching pred. */
	waitFor(pred: (m: Message) => boolean, timeoutMs = 2000): Promise<Message> {
		const existing = this.messages.find(pred);
		if (existing !== undefined) return Promise.resolve(existing);
		const { promise, resolve, reject } = Promise.withResolvers<Message>();
		const timer = setTimeout(() => {
			const i = this.waiters.findIndex((w) => w.resolve === resolve);
			if (i >= 0) this.waiters.splice(i, 1);
			reject(new Error(`timed out waiting for message; got ${JSON.stringify(this.messages)}`));
		}, timeoutMs);
		this.waiters.push({ pred, resolve, reject, timer });
		return promise;
	}

	ofType<T extends Message["type"]>(type: T): Extract<Message, { type: T }>[] {
		return this.messages.filter((m): m is Extract<Message, { type: T }> => m.type === type);
	}

	close(): void {
		this.socket.close();
	}

	/** Stop consuming inbound data (models a stalled viewer). */
	pause(): void {
		this.socket.pause();
	}

	/** Resume after pause(); delivers events queued while paused. */
	resume(): void {
		this.socket.resume();
	}
}

let tmp: string;
let bridge: BridgeHandle | null = null;
const clients: Client[] = [];
const socketPaths: string[] = [];

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "lens-bridge-test-"));
});

afterEach(async () => {
	for (const c of clients.splice(0)) c.close();
	if (bridge !== null) {
		await bridge.close();
		bridge = null;
	}
	rmSync(tmp, { recursive: true, force: true });
	for (const p of socketPaths.splice(0)) {
		// belt-and-suspenders cleanup for default-path bridges
		if (existsSync(p)) rmSync(dirname(p), { recursive: true, force: true });
	}
});

async function open(opts: Parameters<typeof startBridge>[1] = {}): Promise<BridgeHandle> {
	bridge = await startBridge(new Roster(), { socketPath: join(tmp, "b.sock"), ...opts });
	return bridge;
}

async function openWithRoster(
	roster: Roster,
	opts: Parameters<typeof startBridge>[1] = {},
): Promise<BridgeHandle> {
	bridge = await startBridge(roster, { socketPath: join(tmp, "b.sock"), ...opts });
	return bridge;
}

async function connect(b: BridgeHandle): Promise<Client> {
	const c = await Client.connect(b.socketPath);
	clients.push(c);
	return c;
}

function liveWorker(roster: Roster, id = "w1"): void {
	roster.applySpawn(spawn(id));
	roster.applyLifecycle(lifecycle(id, "started"));
}

describe("handshake + hello (P2-R6, RC-12)", () => {
	test("valid ClientMessage handshake gets hello{session,workers,history}", async () => {
		const roster = new Roster();
		liveWorker(roster);
		const hist = [
			{ id: "old1", agent: "scout", status: "completed" as const, historical: true, updatedAt: 1 },
		];
		let historyCalls = 0;
		const b = await openWithRoster(roster, {
			coalesceMs: COALESCE_MS,
			history: () => {
				historyCalls++;
				return hist;
			},
		});
		const c = await connect(b);
		c.handshake("sess-42");
		const hello = (await c.waitFor((m) => m.type === "hello")) as Extract<
			Message,
			{ type: "hello" }
		>;
		expect(hello.v).toBe(1);
		expect(hello.session).toBe("sess-42");
		expect(hello.workers.map((w) => w.id)).toEqual(["w1"]);
		expect(hello.workers[0]?.status).toBe("running");
		expect(hello.history).toEqual(hist);
		expect(historyCalls).toBe(1);
	});

	test("history callback is invoked per viewer connect and defaults to []", async () => {
		let calls = 0;
		const b = await open({
			coalesceMs: COALESCE_MS,
			history: () => {
				calls++;
				return [];
			},
		});
		const c1 = await connect(b);
		c1.handshake();
		const h1 = (await c1.waitFor((m) => m.type === "hello")) as Extract<Message, { type: "hello" }>;
		expect(h1.history).toEqual([]);
		const c2 = await connect(b);
		c2.handshake();
		await c2.waitFor((m) => m.type === "hello");
		expect(calls).toBe(2);
	});

	test("no history option produces hello.history []", async () => {
		const b = await open({ coalesceMs: COALESCE_MS });
		const c = await connect(b);
		c.handshake();
		const hello = (await c.waitFor((m) => m.type === "hello")) as Extract<
			Message,
			{ type: "hello" }
		>;
		expect(hello.history).toEqual([]);
	});

	test.each([
		["control.* extra key", { v: 1, role: "viewer", session: "s", type: "control.steer" }],
		["wrong role", { v: 1, role: "driver", session: "s" }],
		["missing session", { v: 1, role: "viewer" }],
		["wrong version", { v: 2, role: "viewer", session: "s" }],
		["not JSON", "this is not json"],
	])("rejected handshake closes the client without hello: %s", async (_name, payload) => {
		const b = await open({ coalesceMs: COALESCE_MS });
		const c = await connect(b);
		c.send(`${typeof payload === "string" ? payload : JSON.stringify(payload)}\n`);
		await c.closed; // server must close the rejected client
		// REALTIME: give the socket one short window to deliver anything else
		await sleep(30);
		expect(c.messages).toHaveLength(0);
	});

	test("handshake split across two socket chunks still validates", async () => {
		const b = await open({ coalesceMs: COALESCE_MS });
		const c = await connect(b);
		const line = JSON.stringify({ v: 1, role: "viewer", session: "split-s" });
		c.send(line.slice(0, 10));
		c.send(`${line.slice(10)}\n`);
		const hello = (await c.waitFor((m) => m.type === "hello")) as Extract<
			Message,
			{ type: "hello" }
		>;
		expect(hello.session).toBe("split-s");
	});
});

describe("roster deltas (P2-R6)", () => {
	test("spawn/change signals produce worker.upsert broadcasts", async () => {
		const roster = new Roster();
		const b = await openWithRoster(roster, { coalesceMs: COALESCE_MS });
		const c = await connect(b);
		c.handshake();
		await c.waitFor((m) => m.type === "hello");
		liveWorker(roster);
		const up = (await c.waitFor(
			(m) => m.type === "worker.upsert" && m.worker.id === "w1",
		)) as Extract<Message, { type: "worker.upsert" }>;
		expect(up.worker.status).toBe("running");
		expect(up.worker.agent).toBe("scout");
	});

	test("finished worker → terminal upsert, then transcript.ref, then worker.removed", async () => {
		const roster = new Roster();
		const sessionFile = join(tmp, "sess-dir", "w1.jsonl");
		const b = await openWithRoster(roster, { coalesceMs: COALESCE_MS });
		const c = await connect(b);
		c.handshake();
		await c.waitFor((m) => m.type === "hello");
		liveWorker(roster);
		await c.waitFor((m) => m.type === "worker.upsert" && m.worker.id === "w1");
		roster.applyLifecycle(lifecycle("w1", "completed", { sessionFile }));
		await c.waitFor((m) => m.type === "worker.removed" && m.id === "w1");
		// REALTIME: coalesced upserts can still be in flight; drain the window
		await sleep(COALESCE_MS * 3 + 50);
		const types = c.messages.map((m) => m.type).filter((t) => t !== "hello");
		const upserts = c.ofType("worker.upsert");
		const refs = c.ofType("transcript.ref");
		const removed = c.ofType("worker.removed");
		// exactly one terminal upsert, exactly one ref, exactly one removal, ordered
		expect(upserts[upserts.length - 1]?.worker.status).toBe("completed");
		expect(refs).toHaveLength(1);
		expect(refs[0]?.id).toBe("w1");
		expect(refs[0]?.sessionFile).toBe(sessionFile);
		expect(refs[0]?.artifactDir).toBe(dirname(sessionFile));
		expect(removed).toEqual([{ v: 1, type: "worker.removed", id: "w1" }]);
		const lastUpIdx = types.lastIndexOf("worker.upsert");
		expect(types.indexOf("transcript.ref")).toBeGreaterThan(lastUpIdx);
		expect(types.indexOf("worker.removed")).toBeGreaterThan(types.indexOf("transcript.ref"));
	});

	test("transcript.ref fires once when sessionFile first becomes known", async () => {
		const roster = new Roster();
		const sessionFile = join(tmp, "sd", "w1.jsonl");
		const b = await openWithRoster(roster, { coalesceMs: COALESCE_MS });
		const c = await connect(b);
		c.handshake();
		await c.waitFor((m) => m.type === "hello");
		roster.applySpawn(spawn("w1"));
		roster.applyLifecycle(lifecycle("w1", "started", { sessionFile }));
		await c.waitFor((m) => m.type === "transcript.ref" && m.id === "w1");
		// more live frames carrying the same sessionFile must not re-emit
		roster.applyProgress(progress("w1", 10, { sessionFile }));
		roster.applyProgress(progress("w1", 20));
		// REALTIME: outlast the coalescing window to prove no duplicate ref
		await sleep(COALESCE_MS * 3 + 50);
		expect(c.ofType("transcript.ref")).toHaveLength(1);
	});

	test("rapid progress changes coalesce into a single upsert carrying the latest state", async () => {
		const roster = new Roster();
		const b = await openWithRoster(roster, { coalesceMs: COALESCE_MS });
		const c = await connect(b);
		c.handshake();
		await c.waitFor((m) => m.type === "hello");
		liveWorker(roster);
		await c.waitFor((m) => m.type === "worker.upsert" && m.worker.id === "w1");
		const baseline = c.ofType("worker.upsert").length;
		// three changes in the same tick must collapse to one broadcast
		roster.applyProgress(progress("w1", 100));
		roster.applyProgress(progress("w1", 200));
		roster.applyProgress(progress("w1", 300));
		await c.waitFor((m) => m.type === "worker.upsert" && m.worker.counters?.tokens === 300);
		// REALTIME: outlast the window to prove nothing else was sent
		await sleep(COALESCE_MS * 3 + 50);
		expect(c.ofType("worker.upsert")).toHaveLength(baseline + 1);
		// a change after the window produces a fresh upsert
		roster.applyProgress(progress("w1", 400));
		await c.waitFor((m) => m.type === "worker.upsert" && m.worker.counters?.tokens === 400);
	});

	test("broadcast(m) reaches all connected authed clients", async () => {
		const b = await open({ coalesceMs: COALESCE_MS });
		const c1 = await connect(b);
		const c2 = await connect(b);
		c1.handshake();
		c2.handshake();
		await c1.waitFor((m) => m.type === "hello");
		await c2.waitFor((m) => m.type === "hello");
		b.broadcast({ v: 1, type: "notice", level: "warn", message: "degraded bus" });
		const n1 = await c1.waitFor((m) => m.type === "notice");
		const n2 = await c2.waitFor((m) => m.type === "notice");
		expect(n1).toEqual({ v: 1, type: "notice", level: "warn", message: "degraded bus" });
		expect(n2).toEqual(n1);
	});
});

describe("socket lifecycle (RC-14, FR-03)", () => {
	test("default socketPath lives under a unique 0700 dir and the socket is 0600", async () => {
		bridge = await startBridge(new Roster(), { cwd: tmp, coalesceMs: COALESCE_MS });
		socketPaths.push(bridge.socketPath);
		expect(dirname(bridge.socketPath)).toMatch(/herdr-omp-lens-/);
		expect(statSync(dirname(bridge.socketPath)).mode & 0o777).toBe(0o700);
		const st = statSync(bridge.socketPath);
		expect(st.mode & 0o777).toBe(0o600);
		expect(st.isSocket()).toBe(true);
	});

	test("two bridges in the same session get unique socket paths", async () => {
		const b1 = await startBridge(new Roster(), { cwd: tmp, coalesceMs: COALESCE_MS });
		socketPaths.push(b1.socketPath);
		const b2 = await startBridge(new Roster(), { cwd: tmp, coalesceMs: COALESCE_MS });
		socketPaths.push(b2.socketPath);
		try {
			expect(b1.socketPath).not.toBe(b2.socketPath);
			expect(existsSync(b1.socketPath)).toBe(true);
			expect(existsSync(b2.socketPath)).toBe(true);
		} finally {
			await b1.close();
			await b2.close();
		}
	});
	test("close() stops listening and unlinks the socket file", async () => {
		const b = await open({ coalesceMs: COALESCE_MS });
		const p = b.socketPath;
		expect(existsSync(p)).toBe(true);
		const sigintBefore = process.listenerCount("SIGINT");
		const sigtermBefore = process.listenerCount("SIGTERM");
		const exitBefore = process.listenerCount("exit");
		await b.close();
		bridge = null;
		expect(existsSync(p)).toBe(false);
		expect(process.listenerCount("SIGINT")).toBe(sigintBefore - 1);
		expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore - 1);
		expect(process.listenerCount("exit")).toBe(exitBefore - 1);
		// reconnect after close must fail
		await expect(Client.connect(p)).rejects.toThrow();
	});

	test("SIGTERM unlinks the socket (real signal, child process)", async () => {
		const child = Bun.spawn(
			["bun", resolve(import.meta.dirname, "fixtures/bridge-child.ts"), "SIGTERM"],
			{ stdout: "pipe", stderr: "inherit" },
		);
		const out = await new Response(child.stdout).text();
		const sockPath = out.trim().split("\n")[0] ?? "";
		expect(sockPath).toContain("bridge.sock");
		expect(existsSync(sockPath)).toBe(false);
	});

	test("SIGINT unlinks the socket (real signal, child process)", async () => {
		const child = Bun.spawn(
			["bun", resolve(import.meta.dirname, "fixtures/bridge-child.ts"), "SIGINT"],
			{ stdout: "pipe", stderr: "inherit" },
		);
		const out = await new Response(child.stdout).text();
		const sockPath = out.trim().split("\n")[0] ?? "";
		expect(sockPath).toContain("bridge.sock");
		expect(existsSync(sockPath)).toBe(false);
	});
});

describe("bounded buffers / slow consumers (NFR-03, FR-12)", () => {
	test("a non-reading client is dropped with a notice and never stalls broadcast", async () => {
		const roster = new Roster();
		const b = await openWithRoster(roster, {
			coalesceMs: COALESCE_MS,
			maxClientBufferedBytes: 16 * 1024, // small cap to hit backpressure deterministically
		});
		const slow = await connect(b);
		slow.handshake();
		await slow.waitFor((m) => m.type === "hello");
		const fast = await connect(b);
		fast.handshake();
		await fast.waitFor((m) => m.type === "hello");
		// Model a stalled viewer: stop reading so its ~8KB kernel buffer
		// fills; the bridge sees short writes and counts them as pending.
		slow.pause();
		// Messages stay under the kernel-buffer size so a live reader never
		// produces short writes; each write is separated by a macrotask so the
		// reading client drains between writes while the paused one
		// accumulates pending bytes until it crosses the cap and is dropped.
		const big = "x".repeat(4096);
		for (let i = 0; i < 64; i++) {
			b.broadcast({ v: 1, type: "notice", level: "info", message: big });
			const { promise, resolve } = Promise.withResolvers<void>();
			setImmediate(resolve);
			await promise;
		}
		// the slow client must have been dropped (server-side close); the
		// close event queued behind pause() is delivered on resume()
		slow.resume();
		await slow.closed;
		// and the fast client still receives new broadcasts
		b.broadcast({ v: 1, type: "notice", level: "warn", message: "still-here" });
		const n = await fast.waitFor((m) => m.type === "notice" && m.message === "still-here");
		expect(n.type).toBe("notice");
	});
});
