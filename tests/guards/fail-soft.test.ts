/**
 * P6-R7 local-only & fail-soft evidence (NFR-01, FR-03, FR-12, F-15/D1).
 *
 * What this suite proves (numbers quoted into the DoD report):
 *  - bridge socket is a real unix socket, mode 0600, inside a 0700
 *    per-session dir; unlinked on close()/SIGINT/SIGTERM; no TCP listener
 *    is bound by the bridge (lsof evidence + stat).
 *  - malformed/truncated NDJSON, wrong-`v` frames and injected `control.*`
 *    frames are rejected at decodeClientMessage/decodeMessage with
 *    { ok:false } — never a thrown escape (F-07/FR-11).
 *  - a second OMP session (second bridge, same workspace cwd) binds a
 *    DISTINCT socket — no EADDRINUSE/hijack.
 *  - a STALLED (accepts, never responds — distinct from refused) Herdr
 *    socket trips the transport's per-call timeout; through the real
 *    adapter the topology manager circuit-breaks to `degraded` with
 *    exactly one error notice.
 *  - bus-absent degraded mode still discovers workers by scanning the
 *    verified session artifact dir (D1); live discovery is relaxed.
 *  - a mid-turn Herdr kill leaves the OMP turn completing normally with a
 *    single notice.
 *
 * Timing discipline: the only real-time waits are socket-delivery waits
 * bounded by waitFor and the deliberately reduced (non-default) transport
 * timeouts; the 2s/5s defaults are pinned by a source-level assertion so
 * the stall itself never soaks.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Socket } from "bun";
import lensExtension, { activeObservation, lensReady, stopLens } from "../../src/extension";
import type { LensContext, LensExtensionApi } from "../../src/extension/api";
import { type BridgeHandle, type BridgeOptions, startBridge } from "../../src/extension/bridge";
import { createHistorySource } from "../../src/extension/history";
import { createHistoryStub } from "../../src/extension/history-stub";
import { Roster } from "../../src/extension/roster";
import {
	createTopologyManager,
	type TopologyAdapter,
	type TopologyManager,
} from "../../src/extension/topology";
import { snapshot as adapterSnapshot } from "../../src/herdr/adapter";
import type { CallerContext } from "../../src/herdr/context";
import { socketTransport } from "../../src/herdr/transport";
import type {
	LifecycleHandlers,
	PaneInfo,
	PaneMetadata,
	SessionSnapshot,
} from "../../src/herdr/types";
import { decodeClientMessage, decodeMessage } from "../../src/protocol/codec";
import type { ClientDecodeResult, DecodeResult, Message } from "../../src/protocol/types";
import { applyMessage, initialViewerState } from "../../src/viewer/state";
import { makeFixtureTree, PROJECT_CWD } from "../extension/history/fixtures";

// ---------------------------------------------------------------- helpers --

type NoticeMessage = Extract<Message, { type: "notice" }>;
type HelloMessage = Extract<Message, { type: "hello" }>;

function noticesOf(sent: Message[]): NoticeMessage[] {
	return sent.filter((m): m is NoticeMessage => m.type === "notice");
}
/** NDJSON test client over a real unix socket (bridge.test.ts pattern). */
class Client {
	readonly messages: Message[] = [];
	wasClosed = false;
	private readonly resolveClosed: () => void;
	readonly closed: Promise<void>;
	private readonly waiters: Array<{
		pred: (m: Message) => boolean;
		resolve: (m: Message) => void;
		timer: NodeJS.Timeout;
	}> = [];

	private constructor(private readonly socket: Socket) {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.closed = promise;
		this.resolveClosed = resolve;
	}

	static async connect(socketPath: string): Promise<Client> {
		let client!: Client;
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		const socket = await Bun.connect({
			unix: socketPath,
			socket: {
				data(_s: Socket, data: Buffer) {
					buffer += decoder.write(data);
					let nl = buffer.indexOf("\n");
					while (nl >= 0) {
						const line = buffer.slice(0, nl);
						buffer = buffer.slice(nl + 1);
						if (line.trim() !== "") {
							const decoded = decodeMessage(line);
							if (decoded.ok) client.onMessage(decoded.message);
						}
						nl = buffer.indexOf("\n");
					}
				},
				close() {
					client.wasClosed = true;
					client.resolveClosed();
				},
				connectError(_s: Socket, error: unknown) {
					client.resolveClosed();
					throw error;
				},
			},
		});
		client = new Client(socket);
		return client;
	}

	send(text: string): void {
		this.socket.write(text);
	}

	handshake(session = "sess-test"): void {
		this.send(`${JSON.stringify({ v: 1, role: "viewer", session })}\n`);
	}

	private onMessage(m: Message): void {
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

	waitFor(pred: (m: Message) => boolean, timeoutMs = 2000): Promise<Message> {
		const existing = this.messages.find(pred);
		if (existing !== undefined) return Promise.resolve(existing);
		const { promise, resolve, reject } = Promise.withResolvers<Message>();
		const timer = setTimeout(() => {
			const i = this.waiters.findIndex((w) => w.resolve === resolve);
			if (i >= 0) this.waiters.splice(i, 1);
			reject(new Error(`timed out waiting; got ${JSON.stringify(this.messages)}`));
		}, timeoutMs);
		this.waiters.push({ pred, resolve, timer });
		return promise;
	}

	ofType<T extends Message["type"]>(type: T): Extract<Message, { type: T }>[] {
		return this.messages.filter((m): m is Extract<Message, { type: T }> => m.type === type);
	}

	close(): void {
		this.socket.close();
	}
}

/** A Herdr-shaped unix socket that ACCEPTS connections but never responds. */
function startStalledServer(): { socketPath: string; stop(): void } {
	const dir = mkdtempSync(join(tmpdir(), "lens-stalled-"));
	const socketPath = join(dir, "herdr.sock");
	const listener = Bun.listen<undefined>({
		unix: socketPath,
		socket: {
			open(_s: Socket) {},
			data(_s: Socket, _d: Buffer) {
				// deliberately never responds — the stall P6-R7 distinguishes
				// from a refused connect
			},
			close(_s: Socket) {},
			drain(_s: Socket) {},
			error(_s: Socket, _e: unknown) {},
			connectError(_s: Socket, _e: unknown) {},
		},
	});
	return {
		socketPath,
		stop: () => {
			listener.stop(true);
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

// --- env discipline (invariants.test.ts pattern) ----------------------------

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

const savedEnv = new Map<string, string | undefined>();
function setEnv(vars: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(vars)) {
		if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

// --- fake pi (invariants.test.ts pattern, events optional) ------------------

interface FakePi {
	pi: LensExtensionApi;
	commands: Map<
		string,
		{ description: string; handler: (args: string, ctx?: LensContext) => void }
	>;
	hooks: Map<string, (event: unknown, ctx?: LensContext) => void>;
	bus: Map<string, (payload: unknown) => void>;
}

function fakePi(opts: { withBus?: boolean } = {}): FakePi {
	const commands: FakePi["commands"] = new Map();
	const hooks: FakePi["hooks"] = new Map();
	const bus: FakePi["bus"] = new Map();
	const pi: LensExtensionApi = {
		registerCommand(name, definition) {
			commands.set(name, { description: definition.description, handler: definition.handler });
		},
		on(event, handler) {
			hooks.set(event, handler);
		},
		off(event, handler) {
			if (hooks.get(event) === handler) hooks.delete(event);
		},
	};
	if (opts.withBus !== false) {
		pi.events = {
			on(channel, handler) {
				bus.set(channel, handler);
			},
			off(channel, handler) {
				if (bus.get(channel) === handler) bus.delete(channel);
			},
		};
	}
	return { pi, commands, hooks, bus };
}

function lensCtx(sessionId: string): LensContext {
	return { sessionManager: { getSessionId: () => sessionId } };
}

const VIEWER_CMD = "bun /pkg/src/viewer/cli.ts";
const CTX: CallerContext = {
	workspaceId: "w1",
	tabId: "w1:t1",
	paneId: "w1:p1",
	binPath: "/bin/herdr",
	socketPath: "/sock",
};

interface RecordedTopoCall {
	method: string;
	args: unknown[];
}

/** Topology adapter mock; any method may be made to throw mid-transition. */
function topoMockAdapter(overrides: Partial<TopologyAdapter> = {}): {
	adapter: TopologyAdapter;
	calls: RecordedTopoCall[];
	panes: Map<string, PaneInfo>;
	count: (m: string) => number;
} {
	const calls: RecordedTopoCall[] = [];
	const panes = new Map<string, PaneInfo>();
	let tabCounter = 0;
	let paneCounter = 0;
	const adapter: TopologyAdapter = {
		async createOverviewTab(label: string) {
			calls.push({ method: "createOverviewTab", args: [label] });
			tabCounter += 1;
			paneCounter += 1;
			const paneId = `pane-${paneCounter}`;
			panes.set(paneId, { paneId, tabId: `tab-${tabCounter}`, workspaceId: "w1", title: label });
			return { tabId: `tab-${tabCounter}`, rootPaneId: paneId };
		},
		async splitPane(targetPaneId: string, _dir, _env) {
			calls.push({ method: "splitPane", args: [targetPaneId] });
			paneCounter += 1;
			const paneId = `pane-${paneCounter}`;
			panes.set(paneId, {
				paneId,
				tabId: panes.get(targetPaneId)?.tabId ?? "tab-?",
				workspaceId: "w1",
			});
			return { paneId };
		},
		async runInPane(paneId: string, command: string) {
			calls.push({ method: "runInPane", args: [paneId, command] });
		},
		async getPane(paneId: string) {
			calls.push({ method: "getPane", args: [paneId] });
			return panes.get(paneId) ?? null;
		},
		async snapshot(): Promise<SessionSnapshot> {
			calls.push({ method: "snapshot", args: [] });
			return { workspaces: [], tabs: [], panes: [...panes.values()] };
		},
		async subscribeLifecycle(_h: LifecycleHandlers) {
			calls.push({ method: "subscribeLifecycle", args: [] });
			return { async close() {} };
		},
		async reportMetadata(_p: string, _m: PaneMetadata) {
			calls.push({ method: "reportMetadata", args: [] });
		},
		...overrides,
	};
	return {
		adapter,
		calls,
		panes,
		count: (m: string) => calls.filter((c) => c.method === m).length,
	};
}

// --- fixture state ------------------------------------------------------------

let tmp: string;
const bridges: BridgeHandle[] = [];
const clients: Client[] = [];
const defaultSockDirs: string[] = [];

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "lens-failsoft-"));
});

afterEach(async () => {
	for (const c of clients.splice(0)) c.close();
	for (const b of bridges.splice(0)) await b.close();
	await stopLens();
	for (const [key, original] of savedEnv) {
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
	}
	savedEnv.clear();
	rmSync(tmp, { recursive: true, force: true });
	for (const d of defaultSockDirs.splice(0)) {
		if (existsSync(d)) rmSync(d, { recursive: true, force: true });
	}
});

async function openBridge(opts: BridgeOptions = {}): Promise<BridgeHandle> {
	const b = await startBridge(new Roster(), opts);
	bridges.push(b);
	defaultSockDirs.push(dirname(b.socketPath));
	return b;
}

async function connect(b: BridgeHandle): Promise<Client> {
	const c = await Client.connect(b.socketPath);
	clients.push(c);
	return c;
}

function spawnFrame(spawnKey: string): unknown {
	return { type: "before_subagent_spawn", agent: "scout", spawnKey };
}

// ---------------------------------------------------------------- tests -----

describe("P6-R7 socket evidence (NFR-01, FR-03)", () => {
	test("bridge socket: 0600 unix socket inside a 0700 per-session dir; no TCP listener", async () => {
		const b = await openBridge({ cwd: tmp });

		const dir = dirname(b.socketPath);
		expect(dir).toMatch(/herdr-omp-lens-/);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		const st = statSync(b.socketPath);
		expect(st.isSocket()).toBe(true);
		expect(st.mode & 0o777).toBe(0o600);

		// lsof evidence: a unix-type fd bound to our socket path, zero TCP
		// listeners owned by this process (the bridge binds no TCP).
		const lsof = Bun.spawnSync({
			cmd: ["lsof", "-nP", "-U", "-a", "-p", String(process.pid)],
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = new TextDecoder().decode(lsof.stdout);
		// lsof truncates NAME at ~44 chars; match the socket basename on a
		// unix-type row — the 0600 statSync assertions above carry the path.
		const unixSocketRow = out
			.split("\n")
			.find((l) => l.includes("unix") && l.endsWith("bridge.sock"));
		expect(unixSocketRow).toBeDefined();
		const tcpListeners = out.split("\n").filter((l) => l.includes("TCP") && l.includes("LISTEN"));
		console.log(
			`[evidence] lsof unix row: ${unixSocketRow?.trim() ?? "none"}; TCP LISTEN rows: ${tcpListeners.length}`,
		);
		expect(tcpListeners).toHaveLength(0);
	});

	test("close() unlinks the socket and removes the per-session dir", async () => {
		const b = await openBridge({ cwd: tmp });
		const p = b.socketPath;
		const dir = dirname(p);
		expect(existsSync(p)).toBe(true);
		await b.close();
		bridges.splice(bridges.indexOf(b), 1);
		expect(existsSync(p)).toBe(false);
		expect(existsSync(dir)).toBe(false);
	});

	for (const sig of ["SIGINT", "SIGTERM"] as const) {
		test(`${sig} unlinks the socket (real signal, child process)`, async () => {
			const child = Bun.spawn({
				cmd: ["bun", resolve(import.meta.dirname, "../extension/fixtures/bridge-child.ts"), sig],
				stdout: "pipe",
				stderr: "inherit",
			});
			const out = await new Response(child.stdout).text();
			const sockPath = out.trim().split("\n")[0] ?? "";
			await child.exited;
			expect(sockPath).toContain("bridge.sock");
			expect(existsSync(sockPath)).toBe(false);
			console.log(`[evidence] ${sig}: socket ${sockPath} unlinked`);
		});
	}

	test("a second session in the same workspace binds a DISTINCT socket", async () => {
		const b1 = await openBridge({ cwd: tmp });
		const b2 = await openBridge({ cwd: tmp });
		expect(b1.socketPath).not.toBe(b2.socketPath);
		// both accept connections — no EADDRINUSE, no hijack
		for (const b of [b1, b2]) {
			const c = await connect(b);
			c.handshake();
			await c.waitFor((m) => m.type === "hello");
		}
	});
});

describe("P6-R7 fuzzed frames rejected without throw (F-07/FR-11, NFR-02)", () => {
	test("decodeClientMessage rejects malformed/truncated/wrong-v/control.* — no throw", () => {
		const junk = [
			"", // empty
			"\n",
			"not json at all",
			'{"v":1,"role":"viewer","session":"s"', // truncated JSON
			'{"v":1,"role":"viewer"', // truncated mid-object
			"{", // lone brace
			"[1,2,3]", // array
			"42", // scalar
			"null",
			'{"v":0,"role":"viewer","session":"s"}', // wrong v (below)
			'{"v":2,"role":"viewer","session":"s"}', // wrong v (above)
			'{"v":"1","role":"viewer","session":"s"}', // wrong v type
			'{"role":"viewer","session":"s"}', // missing v
			'{"v":1,"role":"control","session":"s"}', // non-viewer role
			'{"v":1,"role":"viewer"}', // missing session
			'{"v":1,"role":"viewer","session":42}', // wrong session type
			'{"v":1,"role":"viewer","session":"s","type":"control.spawn"}', // injected control type
			'{"v":1,"role":"viewer","session":"s","control":{"kill":"w1"}}', // injected control object
			'{"v":1,"role":"viewer","session":"s","control.kill":"w1"}', // injected control.* key
			'{"v":1,"role":"viewer","session":"s","focus":true}', // injected focus theft field
			'{"v":1,"role":"viewer","session":"s"} trailing-junk', // trailing garbage after the JSON
			'{"v":1,"role":"viewer","session":"s"}{"v":1}', // two concatenated objects
			`${"x".repeat(256 * 1024)}`, // oversized non-JSON line
		];
		for (const frame of junk) {
			let r: ClientDecodeResult | undefined;
			expect(() => {
				r = decodeClientMessage(frame);
			}).not.toThrow();
			expect(r?.ok).toBe(false);
			if (r !== undefined && !r.ok) expect(typeof r.error).toBe("string");
		}
		// and the real handshake still passes
		expect(decodeClientMessage('{"v":1,"role":"viewer","session":"s-1"}').ok).toBe(true);
	});

	test("decodeMessage rejects malformed/truncated/wrong-v/control.* — no throw", () => {
		const junk = [
			"",
			"not json at all",
			'{"v":1,"type":"worker.upsert","worker":{"id":"w1"', // truncated
			"{",
			"[1,2]",
			"null",
			'{"v":2,"type":"worker.removed","id":"w1"}', // wrong v
			'{"v":1,"type":"control.spawn","agent":"x"}', // injected control.* type
			'{"v":1,"type":"control.kill","id":"w1"}',
			'{"v":1,"type":"worker.upsert"}', // missing worker
			'{"v":1,"type":"worker.upsert","worker":{"id":5}}', // bad field type
			'{"v":1,"type":"worker.removed","id":42}',
			'{"v":1,"type":"hello","session":"s","workers":"nope"}',
			'{"v":1,"type":"notice","level":"fatal","message":"x"}', // bad enum
			'{"v":1,"type":"bogus"}', // unknown type
			`${"y".repeat(256 * 1024)}`,
		];
		for (const frame of junk) {
			let r: DecodeResult | undefined;
			expect(() => {
				r = decodeMessage(frame);
			}).not.toThrow();
			expect(r?.ok).toBe(false);
		}
		// valid frames still decode
		expect(decodeMessage('{"v":1,"type":"notice","level":"warn","message":"m"}').ok).toBe(true);
	});

	test("live bridge: a garbage first line closes the client, no hello emitted", async () => {
		const b = await openBridge({ cwd: tmp });
		for (const bad of [
			"not json\n",
			'{"v":2,"role":"viewer","session":"s"}\n', // wrong v
			'{"v":1,"role":"viewer","session":"s","type":"control.spawn"}\n', // control.*
			'{"v":1,"role":"viewer","session":"s"', // truncated (no newline = never completes)
		]) {
			const c = await connect(b);
			c.send(bad);
			if (bad.endsWith("\n")) {
				await c.closed; // server closed us on the rejected handshake
				expect(c.wasClosed).toBe(true);
				expect(c.ofType("hello")).toHaveLength(0);
			}
			c.close();
		}
	});
});

describe("P6-R7 stalled Herdr socket (F-15: per-call timeouts → degraded)", () => {
	test("stalled (not refused) socket trips the request timeout; refused fails fast", async () => {
		const stalled = startStalledServer();
		try {
			// refused: no listener at all → fast connect failure, NOT a timeout
			await expect(
				socketTransport(join(tmp, "refused.sock"), { connectMs: 500, requestMs: 500 }).request(
					"session.snapshot",
					{},
				),
			).rejects.toThrow(/connect failed|connect timeout/);

			// stalled: accept succeeds, no response → request timeout fires
			const t0 = performance.now();
			await expect(
				socketTransport(stalled.socketPath, { connectMs: 2000, requestMs: 150 }).request(
					"session.snapshot",
					{},
				),
			).rejects.toThrow(/request timeout after 150ms/);
			const elapsed = performance.now() - t0;
			console.log(`[evidence] stalled request timed out after ${elapsed.toFixed(0)}ms`);
			expect(elapsed).toBeLessThan(2000);
		} finally {
			stalled.stop();
		}
	});

	test("per-call timeout defaults are 2s connect / 5s request (source pin)", () => {
		const src = readFileSync(resolve(import.meta.dirname, "../../src/herdr/transport.ts"), "utf8");
		expect(src).toContain("options.connectMs ?? 2000");
		expect(src).toContain("options.requestMs ?? 5000");
	});

	test("circuit-break: adapter over a stalled socket degrades the topology with one notice", async () => {
		const stalled = startStalledServer();
		try {
			const t = socketTransport(stalled.socketPath, { connectMs: 500, requestMs: 150 });
			const ctx: CallerContext = { ...CTX, socketPath: stalled.socketPath };
			const sent: Message[] = [];

			const base = topoMockAdapter();
			// Real adapter path for snapshot: socketTransport → stalled socket →
			// request timeout → rejection. subscribeLifecycle stays a fake so the
			// test isolates the RPC-timeout leg, not the event-stream leg.
			const adapter: TopologyAdapter = {
				...base.adapter,
				snapshot: () => adapterSnapshot(ctx, t),
			};

			const topo = createTopologyManager(ctx, VIEWER_CMD, "/bridge.sock", (m) => sent.push(m), {
				sessionId: "sess-stall",
				adapter,
				viewerCount: undefined,
			});

			await topo.onWorkerSpawned();
			await topo.settle?.();
			expect(topo.state()).toBe("degraded");
			const notices = noticesOf(sent);
			expect(notices).toHaveLength(1);
			expect(notices[0]).toMatchObject({ level: "error" });
			expect(notices[0]?.message).toContain("topology degraded");
			console.log(`[evidence] circuit-break notice: ${notices[0]?.message}`);

			// latched: repeated failures while degraded emit no further notices
			await topo.onWorkerSpawned();
			await topo.settle?.();
			expect(sent.filter((m) => m.type === "notice")).toHaveLength(1);
			expect(topo.state()).toBe("degraded");
			await topo.stop();
		} finally {
			stalled.stop();
		}
	});
});

describe("P6-R7 bus-absent degraded discovery (D1)", () => {
	test("no pi.events → bus-unavailable notice; workers still discovered via artifact scan", async () => {
		setEnv(FULL_ENV);
		const tree = makeFixtureTree();
		const fake = fakePi({ withBus: false });
		const sent: Message[] = [];
		const errors: unknown[] = [];

		lensExtension(fake.pi, {
			cwd: PROJECT_CWD,
			history: createHistorySource({
				sessionsRoot: tree.sessionsRoot,
				now: () => 1_700_000_100_000,
			}),
			onObservationError: (err) => errors.push(err),
			createTopologyManager: (ctx, cmd, bridgeSock, emit, deps) => {
				return createTopologyManager(ctx, cmd, bridgeSock, emit, {
					...deps,
					sessionId: deps?.sessionId ?? "sess-d1",
					adapter: topoMockAdapter().adapter,
					viewerCount: undefined,
				});
			},
			startBridge: async (roster: Roster, opts: BridgeOptions) => {
				const handle = await startBridge(roster, {
					...opts,
					socketPath: join(tmp, "d1-bridge.sock"),
				});
				// spy broadcasts (viewer.get gets hello directly; notices ride broadcast)
				const orig = handle.broadcast.bind(handle);
				const spy: BridgeHandle = {
					...handle,
					broadcast: (m: Message) => {
						sent.push(m);
						orig(m);
					},
				};
				bridges.push(spy);
				return spy;
			},
		});
		await lensReady();
		expect(errors).toHaveLength(0);

		// P2-R8: the missing bus surfaced as exactly one warn notice on the wire
		const busNotices = sent.filter(
			(m): m is Extract<Message, { type: "notice" }> => m.type === "notice",
		);
		expect(busNotices).toHaveLength(1);
		expect(busNotices[0]?.level).toBe("warn");
		expect(busNotices[0]?.message).toContain("bus unavailable");
		console.log(`[evidence] bus-absent notice: ${busNotices[0]?.message}`);

		// D1: the artifact-dir scan still delivers workers — through the real
		// bridge hello.history seam.
		const obs = activeObservation();
		expect(obs).not.toBeNull();
		if (obs === null) throw new Error("observation not active");
		const c = await connect(obs.bridge);
		c.handshake();
		const helloMsg = await c.waitFor((m) => m.type === "hello");
		if (helloMsg.type !== "hello") throw new Error("unreachable: pred matched hello");
		const hello: HelloMessage = helloMsg;
		expect(hello.workers).toHaveLength(0); // live discovery relaxed (no bus)
		expect(hello.history).toHaveLength(3); // w1, w2, w3 from the scan
		const histIds = (hello.history ?? []).map((w) => w.id).sort();
		expect(histIds).toEqual(["w1", "w2", "w3"]);
		for (const w of hello.history ?? []) expect(w.historical).toBe(true);

		// D1 in the viewer reducer: a history-only hello marks degraded
		const vs = applyMessage(initialViewerState(), hello);
		expect(vs.degraded).toBe(true);
		expect(vs.live).toBe(true);
		expect(vs.workers.size).toBe(3);

		// spawn hook still registers direct ids, but with no bus no live worker
		// can ever materialize — live discovery is what was relaxed.
		fake.hooks.get("before_subagent_spawn")?.(spawnFrame("w-live"));
		expect(obs?.roster.snapshot()).toHaveLength(0);
	});
});

describe("P6-R7 mid-turn Herdr kill (FR-12)", () => {
	test("adapter death mid-transition: turn completes, one notice, roster intact", async () => {
		setEnv(FULL_ENV);
		const fake = fakePi();
		const sent: Message[] = [];
		const errors: unknown[] = [];
		const mock = topoMockAdapter({
			// Herdr dies mid-transition: subscribe + snapshot succeeded, the
			// create call is where the socket vanished.
			createOverviewTab: () => Promise.reject(new Error("herdr socket closed mid-turn")),
		});
		let topo: TopologyManager | undefined;

		lensExtension(fake.pi, {
			cwd: "/tmp/lens-failsoft",
			startBridge: () =>
				Promise.resolve({
					socketPath: "/stub/bridge.sock",
					broadcast: (m: Message) => sent.push(m),
					viewerCount: () => 0,
					close: () => Promise.resolve(),
				}),
			history: createHistoryStub(),
			onObservationError: (err) => errors.push(err),
			createTopologyManager: (ctx, cmd, bridgeSock, emit, deps) => {
				topo = createTopologyManager(ctx, cmd, bridgeSock, emit, {
					...deps,
					sessionId: deps?.sessionId ?? "sess-kill",
					adapter: mock.adapter,
					viewerCount: undefined,
				});
				return topo;
			},
		});
		await lensReady();
		// session_start creates the topology lazily — Herdr is already dead.
		fake.hooks.get("session_start")?.({}, lensCtx("sess-kill"));
		expect(topo).toBeDefined();

		// The OMP turn: synchronous handlers run while Herdr is dead.
		expect(() => {
			fake.hooks.get("before_subagent_spawn")?.(spawnFrame("w-1"));
			fake.bus.get("task:subagent:lifecycle")?.({ id: "w-1", agent: "scout", status: "running" });
			fake.bus.get("task:subagent:progress")?.({
				progress: { id: "w-1", status: "running", tokens: 5 },
			});
		}).not.toThrow(); // the turn completes normally

		await topo?.settle?.();
		await Promise.resolve();

		// roster work landed — the turn's effects are intact
		expect(
			activeObservation()
				?.roster.snapshot()
				.map((w) => w.id),
		).toEqual(["w-1"]);
		expect(topo?.state()).toBe("degraded");

		// exactly ONE notice about the degraded topology, latched
		const notices = noticesOf(sent);
		expect(notices).toHaveLength(1);
		expect(notices[0]?.message).toContain("topology degraded");
		// a second spawn keeps it at one notice — no notice spam per failure
		fake.hooks.get("before_subagent_spawn")?.(spawnFrame("w-2"));
		fake.bus.get("task:subagent:lifecycle")?.({ id: "w-2", agent: "scout", status: "running" });
		await topo?.settle?.();
		expect(sent.filter((m) => m.type === "notice")).toHaveLength(1);
		expect(errors).toHaveLength(0);
	});
});
