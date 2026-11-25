import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket, SocketListener } from "bun";
import { decodeClientMessage, encodeMessage } from "../../src/protocol/codec";
import type { ClientMessage, Message, WorkerSnapshot } from "../../src/protocol/types";
import { type BridgeClient, connectBridge } from "../../src/viewer/client";

/**
 * Real unix-socket client tests: the fake bridge is a Bun.listen({unix}) peer
 * that validates the handshake with decodeClientMessage, then streams a hello
 * plus scripted deltas. Waits are bounded condition polls — REALTIME: real
 * sockets deliver on real I/O turns, so fake timers cannot drive delivery;
 * the poll only bounds the wait, it never orders events the protocol sequences.
 */

function snap(id: string, over: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
	return { id, agent: "task", status: "running", updatedAt: 1_000, ...over };
}

async function waitFor(cond: () => boolean, ms = 2_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
		await Bun.sleep(1);
	}
}

interface Connection {
	socket: Socket<Connection>;
	lines: string[];
}

/** Fake bridge: sends hellos[handshakeIndex-1] after each valid handshake. */
class FakeBridge {
	readonly socketPath: string;
	readonly dir: string;
	readonly handshakes: ClientMessage[] = [];
	readonly connections: Connection[] = [];
	private readonly hellos: Message[];
	private readonly listener: SocketListener<Connection>;
	private stopped = false;

	constructor(hellos: Message[]) {
		this.hellos = hellos;
		this.dir = mkdtempSync(join(tmpdir(), "lens-viewer-test-"));
		this.socketPath = join(this.dir, "bridge.sock");
		this.listener = Bun.listen<Connection>({
			unix: this.socketPath,
			socket: {
				open: (socket) => {
					const conn: Connection = { socket, lines: [] };
					socket.data = conn;
					this.connections.push(conn);
				},
				data: (socket, data) => {
					for (const line of data.toString("utf8").split("\n")) {
						if (line.trim() === "") continue;
						socket.data.lines.push(line);
						const decoded = decodeClientMessage(line);
						if (decoded.ok) {
							this.handshakes.push(decoded.message);
							const hello =
								this.hellos[Math.min(this.handshakes.length - 1, this.hellos.length - 1)];
							if (hello) socket.write(encodeMessage(hello));
						}
					}
				},
				close: () => {},
				error: () => {},
			},
		});
	}

	/** Raw outbound lines received from the viewer (tamper audit). */
	allLines(): string[] {
		return this.connections.flatMap((c) => c.lines);
	}

	send(m: Message): void {
		const conn = this.connections.at(-1);
		if (!conn) throw new Error("no client connected");
		conn.socket.write(encodeMessage(m));
	}

	sendRaw(text: string): void {
		const conn = this.connections.at(-1);
		if (!conn) throw new Error("no client connected");
		conn.socket.write(text);
	}

	/** Simulate the bridge dropping the current client mid-stream. */
	dropClient(): void {
		this.connections.at(-1)?.socket.close();
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.listener.stop(true);
		for (const c of this.connections) {
			try {
				c.socket.close();
			} catch {
				// already gone
			}
		}
		await Promise.resolve();
		rmSync(this.dir, { recursive: true, force: true });
	}
}

function hello(session: string, workers: WorkerSnapshot[], history?: WorkerSnapshot[]): Message {
	return history === undefined
		? { v: 1, type: "hello", session, workers }
		: { v: 1, type: "hello", session, workers, history };
}

const bridges: FakeBridge[] = [];
const clients: BridgeClient[] = [];

function bridge(...hellos: Message[]): FakeBridge {
	const b = new FakeBridge(hellos);
	bridges.push(b);
	return b;
}

async function connect(
	b: FakeBridge,
	opts: { maxReconnectAttempts?: number } = {},
): Promise<BridgeClient> {
	const c = await connectBridge({
		socketPath: b.socketPath,
		session: "sess-1",
		reconnectDelayMs: 0,
		...opts,
	});
	clients.push(c);
	return c;
}

afterEach(async () => {
	for (const c of clients.splice(0)) await c.close();
	for (const b of bridges.splice(0)) await b.stop();
});

describe("connectBridge", () => {
	test("sends the viewer handshake, then applies hello + deltas", async () => {
		const b = bridge(hello("sess-1", [snap("w1")]));
		const c = await connect(b);
		await waitFor(() => c.state.workers.size === 1);
		expect(b.handshakes).toEqual([{ v: 1, role: "viewer", session: "sess-1" }]);
		expect(c.state.session).toBe("sess-1");
		expect(c.state.live).toBe(true);

		b.send({ v: 1, type: "worker.upsert", worker: snap("w2") });
		b.send({ v: 1, type: "transcript.ref", id: "w1", sessionFile: "/tmp/w1.jsonl" });
		b.send({ v: 1, type: "notice", level: "info", message: "hi" });
		await waitFor(() => c.state.notices.length === 1);
		expect(c.state.workers.has("w2")).toBe(true);
		expect(c.state.transcriptRefs.get("w1")?.sessionFile).toBe("/tmp/w1.jsonl");
		expect(c.state.notices[0]?.message).toBe("hi");
	});

	test("subscribers see every applied message", async () => {
		const b = bridge(hello("sess-1", []));
		const c = await connect(b);
		const seen: number[] = [];
		c.subscribe((s) => seen.push(s.workers.size));
		b.send({ v: 1, type: "worker.upsert", worker: snap("w1") });
		b.send({ v: 1, type: "worker.upsert", worker: snap("w2") });
		await waitFor(() => seen.length === 2);
		expect(seen).toEqual([1, 2]);
	});

	test("malformed lines are dropped without crashing (NFR-02)", async () => {
		const b = bridge(hello("sess-1", []));
		const c = await connect(b);
		await waitFor(() => c.state.live);
		b.sendRaw("this is not json\n");
		b.sendRaw('{"v":2,"type":"hello","session":"x","workers":[]}\n');
		b.send({ v: 1, type: "worker.upsert", worker: snap("w1") });
		await waitFor(() => c.state.workers.size === 1);
		expect(c.state.workers.get("w1")?.status).toBe("running");
	});

	test("never emits any outbound frame besides the handshake (P3-R7)", async () => {
		const b = bridge(hello("sess-1", [snap("w1")]));
		const c = await connect(b);
		await waitFor(() => c.state.workers.size === 1);
		b.send({ v: 1, type: "worker.upsert", worker: snap("w2") });
		b.send({ v: 1, type: "notice", level: "error", message: "boom" });
		await waitFor(() => c.state.workers.size === 2);
		const lines = b.allLines();
		expect(lines).toHaveLength(1);
		expect(decodeClientMessage(lines[0] ?? "").ok).toBe(true);
		for (const line of lines) {
			expect(line).not.toMatch(/control|steer|revive|cancel/i);
		}
	});

	test("disconnect triggers bounded reconnect; fresh hello resyncs state (P3-R10)", async () => {
		const b = bridge(
			hello("sess-1", [snap("old")]),
			hello("sess-1", [snap("new-a"), snap("new-b")]),
		);
		const c = await connect(b, { maxReconnectAttempts: 3 });
		await waitFor(() => c.state.workers.has("old"));

		b.dropClient();
		await waitFor(() => b.connections.length === 2);
		await waitFor(() => c.state.workers.has("new-b"));
		expect(b.handshakes).toHaveLength(2);
		expect(c.state.workers.has("old")).toBe(false);
		expect(c.state.workers.size).toBe(2);
		expect(c.state.live).toBe(true);
		expect(c.state.notices.some((n) => n.level === "warn")).toBe(true);
	});

	test("reconnect is bounded: attempts exhaust into a non-live, closed state", async () => {
		const b = bridge(hello("sess-1", [snap("w1")]));
		const c = await connect(b, { maxReconnectAttempts: 1 });
		await waitFor(() => c.state.workers.size === 1);
		await b.stop();
		// One bounded retry fires against a dead socket — no server-side conn.
		await waitFor(() => !c.state.live && c.status() === "closed");
		expect(b.handshakes).toHaveLength(1);
		expect(c.state.notices.some((n) => n.level === "error")).toBe(true);
	});

	test("close() stops the socket and suppresses further reconnects", async () => {
		const b = bridge(hello("sess-1", [snap("w1")]));
		const c = await connect(b, { maxReconnectAttempts: 5 });
		await waitFor(() => c.state.live);
		await c.close();
		expect(c.status()).toBe("closed");
		b.dropClient();
		// REALTIME: asserting the absence of a reconnect needs a settling window.
		await Bun.sleep(25);
		expect(b.connections.length).toBe(1);
	});

	test("warn notice surfaces the degraded banner state (D1)", async () => {
		const b = bridge(hello("sess-1", [snap("w1")]));
		const c = await connect(b);
		await waitFor(() => c.state.live);
		b.send({ v: 1, type: "notice", level: "warn", message: "bus degraded" });
		await waitFor(() => c.state.degraded);
		expect(c.state.degraded).toBe(true);
	});
});
