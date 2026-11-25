import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import lensExtension, { type LensExtensionDeps, lensReady, stopLens } from "../../../src/extension";
import type {
	LensCommandDefinition,
	LensContext,
	LensExtensionApi,
	LensHookHandler,
} from "../../../src/extension/api";
import {
	type BridgeHandle,
	type BridgeOptions,
	startBridge as realStartBridge,
} from "../../../src/extension/bridge";
import {
	createHistorySource,
	type HistoryScan,
	type HistorySource,
} from "../../../src/extension/history";
import type { Roster } from "../../../src/extension/roster";
import type { TopologyDeps, TopologyManager } from "../../../src/extension/topology";
import type { CallerContext } from "../../../src/herdr/context";
import { decodeMessage } from "../../../src/protocol/codec";
import type { Message, WorkerSnapshot } from "../../../src/protocol/types";
import { makeFixtureTree, PROJECT_CWD } from "./fixtures";

/**
 * P5 Task 4 wiring tests: the activation gate's ONE HistorySource is the
 * real artifact-tree scan (fixture `sessionsRoot`), its merged output rides
 * `hello.history` on EVERY viewer connect/reconnect (F-08), live-wins on id
 * collision (P5-R3), late-scan deltas arrive as `worker.upsert` +
 * one `notice`, and degraded discovery (D1) surfaces the same workers with
 * no fabricated live fields.
 */

const HERDR_VARS = [
	"HERDR_ENV",
	"HERDR_WORKSPACE_ID",
	"HERDR_TAB_ID",
	"HERDR_PANE_ID",
	"HERDR_BIN_PATH",
	"HERDR_SOCKET_PATH",
] as const;

const FULL_ENV: Record<(typeof HERDR_VARS)[number], string> = {
	HERDR_ENV: "1",
	HERDR_WORKSPACE_ID: "w1",
	HERDR_TAB_ID: "w1:t1",
	HERDR_PANE_ID: "w1:p1",
	HERDR_BIN_PATH: "/bin/herdr",
	HERDR_SOCKET_PATH: "/sock",
};

const saved = new Map<string, string | undefined>();
function setEnv(vars: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(vars)) {
		if (!saved.has(key)) saved.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

const tmpDirs: string[] = [];
afterEach(async () => {
	await stopLens();
	for (const [key, original] of saved) {
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
	}
	saved.clear();
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

function tmpdirPath(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), "lens-hw-"));
	tmpDirs.push(dir);
	return join(dir, name);
}

// --- fake pi (bus + hooks) --------------------------------------------------

type BusHandler = (payload: unknown) => void;

class FakeBus {
	readonly channels = new Map<string, BusHandler[]>();
	on(channel: string, handler: BusHandler): void {
		const list = this.channels.get(channel) ?? [];
		list.push(handler);
		this.channels.set(channel, list);
	}
	off(channel: string, handler: BusHandler): void {
		const list = this.channels.get(channel);
		if (list === undefined) return;
		const i = list.indexOf(handler);
		if (i >= 0) list.splice(i, 1);
	}
	emit(channel: string, payload: unknown): void {
		for (const h of [...(this.channels.get(channel) ?? [])]) h(payload);
	}
}

interface FakePi {
	pi: LensExtensionApi;
	bus?: FakeBus;
	hooks: Map<string, LensHookHandler[]>;
	emitHook(event: string, payload: unknown, ctx?: LensContext): void;
}

function fakePi(withBus = true): FakePi {
	const bus = withBus ? new FakeBus() : undefined;
	const hooks = new Map<string, LensHookHandler[]>();
	const pi: LensExtensionApi = {
		registerCommand(_name: string, _definition: LensCommandDefinition) {},
		on(event, handler) {
			const list = hooks.get(event) ?? [];
			list.push(handler);
			hooks.set(event, list);
		},
		off(event, handler) {
			const list = hooks.get(event);
			if (list === undefined) return;
			const i = list.indexOf(handler);
			if (i >= 0) list.splice(i, 1);
		},
		events: bus,
	};
	return {
		pi,
		bus,
		hooks,
		emitHook(event, payload, ctx) {
			for (const h of [...(hooks.get(event) ?? [])]) h(payload, ctx);
		},
	};
}

function lensCtx(sessionId: string): LensContext {
	return { sessionManager: { getSessionId: () => sessionId } };
}

// --- fake topology recorder -------------------------------------------------

interface FakeTopology {
	manager: TopologyManager;
	calls: string[];
}

function fakeTopology(): FakeTopology {
	const fake: FakeTopology = {
		calls: [],
		manager: {
			onWorkerSpawned: () => {
				fake.calls.push("onWorkerSpawned");
				return Promise.resolve();
			},
			onHistoryPresent: () => {
				fake.calls.push("onHistoryPresent");
				return Promise.resolve();
			},
			onWorkerFinished: (workerId: string) => {
				fake.calls.push(`onWorkerFinished:${workerId}`);
			},
			onRosterEmpty: () => {
				fake.calls.push("onRosterEmpty");
			},
			openOverview: () => {
				fake.calls.push("openOverview");
				return Promise.resolve();
			},
			openWorkerSplit: () => Promise.resolve({ paneId: "p-x" }),
			state: () => "closed",
			stop: () => Promise.resolve(),
		},
	};
	return fake;
}

// --- activation harness -----------------------------------------------------

interface Activated {
	fake: FakePi;
	topo: FakeTopology;
	created: { deps?: TopologyDeps }[];
}

/**
 * Drive the REAL activation path (real startObservation) against a real
 * unix-socket bridge at `socketPath`; only the bridge factory (for the
 * socket location) and the topology factory (recording) are seamed.
 */
function activate(opts: {
	socketPath: string;
	history?: HistorySource;
	withBus?: boolean;
	cwd?: string;
}): Activated {
	setEnv(FULL_ENV);
	const fake = fakePi(opts.withBus ?? true);
	const topo = fakeTopology();
	const created: { deps?: TopologyDeps }[] = [];
	const deps: LensExtensionDeps = {
		cwd: opts.cwd ?? PROJECT_CWD,
		startBridge: (roster: Roster, o: BridgeOptions) =>
			realStartBridge(roster, { ...o, socketPath: opts.socketPath, coalesceMs: 10 }),
		history: opts.history,
		createTopologyManager: (_ctx: CallerContext, _vc, _sock, _emit, tdeps) => {
			created.push({ deps: tdeps });
			return topo.manager;
		},
	};
	lensExtension(fake.pi, deps);
	return { fake, topo, created };
}

const SPAWN = { type: "before_subagent_spawn", agent: "scout", spawnKey: "w1" };
const LIFECYCLE = { id: "w1", agent: "scout", status: "started", index: 0 };

async function connectHandshake(socketPath: string, session: string): Promise<Client> {
	const c = await Client.connect(socketPath);
	c.handshake(session);
	return c;
}

type Hello = Extract<Message, { type: "hello" }>;

describe("history source wired into activation (F-08 / D2)", () => {
	test("hello.history carries scanned workers on connect AND reconnect", async () => {
		const tree = makeFixtureTree();
		tmpDirs.push(tree.sessionsRoot);
		const socketPath = tmpdirPath("bridge.sock");
		const a = activate({
			socketPath,
			history: createHistorySource({ sessionsRoot: tree.sessionsRoot }),
		});
		a.fake.emitHook("session_start", {}, lensCtx("sess-1"));
		await lensReady();

		const assertHello = (hello: Hello): void => {
			expect(hello.workers).toEqual([]);
			const hist = hello.history ?? [];
			expect(hist.map((w) => w.id).sort()).toEqual(["w1", "w2", "w3"]);
			for (const w of hist) {
				expect(w.historical).toBe(true);
				expect(w.counters).toBeUndefined();
				expect(w.sessionFile).toBeDefined();
			}
		};

		const c1 = await connectHandshake(socketPath, "sess-1");
		try {
			assertHello((await c1.waitFor((m) => m.type === "hello")) as Hello);
		} finally {
			c1.close();
		}

		// A second viewer connect ("reconnect") gets the same merged history.
		const c2 = await connectHandshake(socketPath, "sess-1");
		try {
			assertHello((await c2.waitFor((m) => m.type === "hello")) as Hello);
		} finally {
			c2.close();
		}
	});

	test("live wins on id collision: one w1 entry, the LIVE snapshot (P5-R3)", async () => {
		const tree = makeFixtureTree();
		tmpDirs.push(tree.sessionsRoot);
		const socketPath = tmpdirPath("bridge.sock");
		const a = activate({
			socketPath,
			history: createHistorySource({ sessionsRoot: tree.sessionsRoot }),
		});
		a.fake.emitHook("session_start", {}, lensCtx("sess-1"));
		await lensReady();

		// Spawn a LIVE worker colliding with scanned id "w1".
		a.fake.emitHook("before_subagent_spawn", SPAWN);
		a.fake.bus?.emit("task:subagent:lifecycle", LIFECYCLE);

		const c = await connectHandshake(socketPath, "sess-1");
		try {
			const hello = (await c.waitFor((m) => m.type === "hello")) as Hello;
			expect(hello.workers.map((w) => w.id)).toEqual(["w1"]);
			const hist = hello.history ?? [];
			const w1 = hist.filter((w) => w.id === "w1");
			expect(w1).toHaveLength(1); // no duplicate
			expect(w1[0]?.historical).not.toBe(true); // the live copy won
			expect(w1[0]?.status).toBe("running");
			expect(
				hist
					.filter((w) => w.historical === true)
					.map((w) => w.id)
					.sort(),
			).toEqual(["w2", "w3"]);
		} finally {
			c.close();
		}
	});

	test("non-empty scan fires onHistoryPresent for the auto-open (D2)", async () => {
		const tree = makeFixtureTree();
		tmpDirs.push(tree.sessionsRoot);
		const socketPath = tmpdirPath("bridge.sock");
		const a = activate({
			socketPath,
			history: createHistorySource({ sessionsRoot: tree.sessionsRoot }),
		});
		a.fake.emitHook("session_start", {}, lensCtx("sess-1"));
		await lensReady();
		expect(a.topo.calls).toContain("onHistoryPresent");
	});

	test("late-scan deltas: worker.upsert{historical} per worker + ONE notice for warnings", async () => {
		const socketPath = tmpdirPath("bridge.sock");
		setEnv(FULL_ENV);
		const fake = fakePi();
		const gate = Promise.withResolvers<HistoryScan>();
		const history: HistorySource = { scan: () => gate.promise };
		const broadcasts: Message[] = [];
		const factoryCalls: BridgeOptions[] = [];
		const topo = fakeTopology();
		lensExtension(fake.pi, {
			cwd: "/proj/nowhere",
			startBridge: (_roster: Roster, o: BridgeOptions) => {
				factoryCalls.push(o);
				const handle: BridgeHandle = {
					socketPath,
					broadcast: (m: Message) => broadcasts.push(m),
					viewerCount: () => 1,
					close: () => Promise.resolve(),
				};
				return Promise.resolve(handle);
			},
			history,
			createTopologyManager: () => topo.manager,
		});
		fake.emitHook("session_start", {}, lensCtx("sess-1"));

		// Wait until the bridge factory ran (scan still pending).
		for (let i = 0; i < 50 && factoryCalls.length === 0; i++) {
			await Promise.resolve();
		}
		expect(factoryCalls).toHaveLength(1);
		// Scan unresolved → merged callback is empty so far.
		expect(factoryCalls[0]?.history?.()).toEqual([]);

		const workers: WorkerSnapshot[] = [
			{ id: "h1", agent: "task", status: "completed", historical: true, updatedAt: 1 },
			{ id: "h2", agent: "task", status: "aborted", historical: true, updatedAt: 2 },
		];
		gate.resolve({ workers, warnings: ["warn-a", "warn-b"], scannedAt: 1 });
		await lensReady();

		const upserts = broadcasts.filter((m) => m.type === "worker.upsert");
		expect(upserts.map((m) => (m.type === "worker.upsert" ? m.worker.id : "")).sort()).toEqual([
			"h1",
			"h2",
		]);
		for (const u of upserts) {
			if (u.type === "worker.upsert") expect(u.worker.historical).toBe(true);
		}
		const notices = broadcasts.filter((m) => m.type === "notice");
		expect(notices).toHaveLength(1); // warnings deduped to ONE notice
		if (notices[0]?.type === "notice") {
			expect(notices[0].message).toContain("warn-a");
			expect(notices[0].message).toContain("warn-b");
		}
		// Post-scan the merged seam exposes the workers.
		expect(
			factoryCalls[0]
				?.history?.()
				.map((w) => w.id)
				.sort(),
		).toEqual(["h1", "h2"]);
	});

	test("degraded discovery (D1): no pi.events — scan still rides hello.history, no fabricated counters", async () => {
		const tree = makeFixtureTree();
		tmpDirs.push(tree.sessionsRoot);
		const socketPath = tmpdirPath("bridge.sock");
		const a = activate({
			socketPath,
			withBus: false,
			history: createHistorySource({ sessionsRoot: tree.sessionsRoot }),
		});
		a.fake.emitHook("session_start", {}, lensCtx("sess-1"));
		await lensReady();

		const c = await connectHandshake(socketPath, "sess-1");
		try {
			const hello = (await c.waitFor((m) => m.type === "hello")) as Hello;
			expect(hello.workers).toEqual([]); // no live observation without the bus
			const hist = hello.history ?? [];
			expect(hist.map((w) => w.id).sort()).toEqual(["w1", "w2", "w3"]);
			for (const w of hist) {
				expect(w.historical).toBe(true);
				expect(w.counters).toBeUndefined(); // nothing fabricated
				expect(w.activity).toBeUndefined();
			}
		} finally {
			c.close();
		}
	});
});

/** Minimal NDJSON bridge client (same shape as observe-wiring's). */
class Client {
	readonly messages: Message[] = [];
	private readonly waiters: {
		pred: (m: Message) => boolean;
		resolve: (m: Message) => void;
		reject: (e: Error) => void;
		timer: NodeJS.Timeout;
	}[] = [];
	private constructor(private readonly socket: Socket) {}

	static connect(socketPath: string): Promise<Client> {
		let client!: Client;
		const decoder = new TextDecoder();
		let buffer = "";
		return Bun.connect({
			unix: socketPath,
			socket: {
				data(_socket: Socket, data: Buffer) {
					buffer += decoder.decode(data);
					let nl = buffer.indexOf("\n");
					while (nl >= 0) {
						const line = buffer.slice(0, nl);
						buffer = buffer.slice(nl + 1);
						if (line.trim() !== "") client.onLine(line);
						nl = buffer.indexOf("\n");
					}
				},
			},
		}).then((socket) => {
			client = new Client(socket);
			return client;
		});
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

	handshake(session: string): void {
		this.socket.write(`${JSON.stringify({ v: 1, role: "viewer", session })}\n`);
	}

	waitFor(pred: (m: Message) => boolean, timeoutMs = 2000): Promise<Message> {
		const existing = this.messages.find(pred);
		if (existing !== undefined) return Promise.resolve(existing);
		const { promise, resolve, reject } = Promise.withResolvers<Message>();
		const timer = setTimeout(() => {
			const i = this.waiters.findIndex((w) => w.resolve === resolve);
			if (i >= 0) this.waiters.splice(i, 1);
			reject(new Error(`timed out; got ${JSON.stringify(this.messages)}`));
		}, timeoutMs);
		this.waiters.push({ pred, resolve, reject, timer });
		return promise;
	}

	close(): void {
		this.socket.end();
	}
}
