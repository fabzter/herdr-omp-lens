import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import lensExtension from "../../src/extension";
import type {
	LensCommandDefinition,
	LensExtensionApi,
	LensHookHandler,
} from "../../src/extension/api";
import {
	type BridgeHandle,
	type BridgeOptions,
	startBridge as realStartBridge,
} from "../../src/extension/bridge";
import {
	type Observation,
	type ObservationDeps,
	type StartObservation,
	startObservation,
} from "../../src/extension/observe";
import { Roster } from "../../src/extension/roster";
import type { CallerContext } from "../../src/herdr/context";
import { decodeMessage } from "../../src/protocol/codec";
import type { Message } from "../../src/protocol/types";

/**
 * P2-4 wiring tests: a FAKE pi (emitter + spies) plus a fake bridge factory.
 * Determinism: roster reduction is synchronous; the only real-time wait is the
 * optional real-socket end-to-end check, bounded by waitFor's timeout.
 */

const CTX: CallerContext = {
	workspaceId: "w1",
	tabId: "w1:t1",
	paneId: "w1:p1",
	binPath: "/bin/herdr",
	socketPath: "/sock",
};

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
afterEach(() => {
	for (const [key, original] of saved) {
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
	}
	saved.clear();
});

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
	listeners(channel: string): number {
		return this.channels.get(channel)?.length ?? 0;
	}
}

interface FakePi {
	pi: LensExtensionApi;
	bus: FakeBus;
	commands: { name: string; definition: LensCommandDefinition }[];
	hookHandlers: Map<string, LensHookHandler[]>;
	fireHook(event: string, payload: unknown): void;
}

function fakePi(withBusOff = true, withBus = true): FakePi {
	const bus = new FakeBus();
	const commands: { name: string; definition: LensCommandDefinition }[] = [];
	const hookHandlers = new Map<string, LensHookHandler[]>();
	const pi: LensExtensionApi = {
		registerCommand(name, definition) {
			commands.push({ name, definition });
		},
		on(event, handler) {
			const list = hookHandlers.get(event) ?? [];
			list.push(handler);
			hookHandlers.set(event, list);
		},
		off(event, handler) {
			const list = hookHandlers.get(event);
			if (list === undefined) return;
			const i = list.indexOf(handler);
			if (i >= 0) list.splice(i, 1);
		},
		events: !withBus ? undefined : withBusOff ? bus : { on: bus.on.bind(bus) },
	};
	return {
		pi,
		bus,
		commands,
		hookHandlers,
		fireHook(event, payload) {
			for (const h of [...(hookHandlers.get(event) ?? [])]) h(payload);
		},
	};
}

interface FakeBridge {
	handle: BridgeHandle;
	broadcasts: Message[];
	closed: boolean;
	factoryCalls: { opts: BridgeOptions }[];
	factory: (roster: Roster, opts: BridgeOptions) => Promise<BridgeHandle>;
}

/** Mimics the real bridge's seam: roster onChange -> worker.upsert broadcast. */
function fakeBridgeFactory(): FakeBridge {
	const broadcasts: Message[] = [];
	const factoryCalls: { opts: BridgeOptions }[] = [];
	const fake: FakeBridge = {
		broadcasts,
		closed: false,
		factoryCalls,
		handle: {
			socketPath: "/fake/bridge.sock",
			broadcast(m: Message) {
				broadcasts.push(m);
			},
			async close() {
				fake.closed = true;
			},
		},
		factory: async (roster: Roster, opts: BridgeOptions): Promise<BridgeHandle> => {
			factoryCalls.push({ opts });
			roster.onChange((worker) => {
				fake.handle.broadcast({ v: 1, type: "worker.upsert", worker });
			});
			await Promise.resolve();
			return fake.handle;
		},
	};
	return fake;
}

/** Minimal Observation for gate-level injection tests. */
function stubObservation(overrides: Partial<Observation> = {}): Observation {
	return {
		roster: new Roster(),
		bridge: {
			socketPath: "/stub/bridge.sock",
			broadcast() {},
			async close() {},
		},
		async stop() {},
		...overrides,
	};
}

const spawnPayload = {
	type: "before_subagent_spawn",
	agent: "scout",
	invocationKind: "task",
	spawnKey: "w1",
};

const lifecyclePayload = { id: "w1", agent: "scout", status: "started", index: 0 };

const progressPayload = {
	agent: "scout",
	progress: { id: "w1", status: "running", tokens: 12 },
};

const eventPayload = { id: "w1", event: { type: "tool_execution_end", tool: "read" } };

describe("startObservation", () => {
	test("subscribes the three task:subagent:* channels and before_subagent_spawn", async () => {
		const { pi, bus, hookHandlers } = fakePi();
		const bridge = fakeBridgeFactory();

		const obs = await startObservation(pi, CTX, { startBridge: bridge.factory });

		expect(bus.listeners("task:subagent:event")).toBe(1);
		expect(bus.listeners("task:subagent:progress")).toBe(1);
		expect(bus.listeners("task:subagent:lifecycle")).toBe(1);
		expect(hookHandlers.get("before_subagent_spawn")).toHaveLength(1);
		expect(bridge.factoryCalls).toHaveLength(1);
		expect(obs.roster).toBeDefined();
		expect(obs.bridge).toBe(bridge.handle);
		await obs.stop();
	});

	test("spawn hook + frames feed the roster synchronously and broadcast (fire-and-forget)", async () => {
		const { pi, bus, fireHook } = fakePi();
		const bridge = fakeBridgeFactory();
		const obs = await startObservation(pi, CTX, { startBridge: bridge.factory });

		fireHook("before_subagent_spawn", spawnPayload);
		bus.emit("task:subagent:lifecycle", lifecyclePayload);

		// Synchronous reduce — no microtask awaited before this assertion (FR-12).
		expect(obs.roster.snapshot()).toHaveLength(1);
		expect(obs.roster.snapshot()[0]?.status).toBe("running");

		bus.emit("task:subagent:progress", progressPayload);
		expect(obs.roster.snapshot()[0]?.counters?.tokens).toBe(12);
		expect(
			bridge.broadcasts.filter((m) => m.type === "worker.upsert").length,
		).toBeGreaterThanOrEqual(2);

		bus.emit("task:subagent:event", eventPayload);
		expect(obs.roster.snapshot()[0]?.activity).toBe("tool_execution_end");
		await obs.stop();
	});

	test("malformed frames are dropped: no roster mutation, no throw", async () => {
		const { pi, bus, fireHook } = fakePi();
		const bridge = fakeBridgeFactory();
		const obs = await startObservation(pi, CTX, { startBridge: bridge.factory });

		fireHook("before_subagent_spawn", spawnPayload);
		expect(() => {
			bus.emit("task:subagent:lifecycle", { bogus: true });
			bus.emit("task:subagent:progress", { progress: { status: "running" } });
			bus.emit("task:subagent:event", { id: 42 });
			fireHook("before_subagent_spawn", { type: "before_subagent_spawn" });
		}).not.toThrow();
		expect(obs.roster.snapshot()).toHaveLength(0);
		expect(bridge.broadcasts).toHaveLength(0);
		await obs.stop();
	});

	test("frames for ids outside the direct-id set never enter the roster", async () => {
		const { pi, bus } = fakePi();
		const bridge = fakeBridgeFactory();
		const obs = await startObservation(pi, CTX, { startBridge: bridge.factory });

		// No spawn hook fired — nested/foreign worker frame must be excluded (FR-10).
		bus.emit("task:subagent:lifecycle", { id: "nested", agent: "scout", status: "started" });
		bus.emit("task:subagent:progress", {
			progress: { id: "nested", status: "running", tokens: 5 },
		});
		expect(obs.roster.snapshot()).toHaveLength(0);
		await obs.stop();
	});

	test("stop() unsubscribes every handler and closes the bridge", async () => {
		const { pi, bus, hookHandlers, fireHook } = fakePi();
		const bridge = fakeBridgeFactory();
		const obs = await startObservation(pi, CTX, { startBridge: bridge.factory });

		await obs.stop();

		expect(bus.listeners("task:subagent:event")).toBe(0);
		expect(bus.listeners("task:subagent:progress")).toBe(0);
		expect(bus.listeners("task:subagent:lifecycle")).toBe(0);
		expect(hookHandlers.get("before_subagent_spawn")).toHaveLength(0);
		expect(bridge.closed).toBe(true);

		// Late frames must not resurrect a worker.
		fireHook("before_subagent_spawn", spawnPayload);
		bus.emit("task:subagent:lifecycle", lifecyclePayload);
		expect(obs.roster.snapshot()).toHaveLength(0);
	});

	test("stop() still detaches when the bus has no off(): handlers go inert", async () => {
		const { pi, bus, hookHandlers, fireHook } = fakePi(false);
		const bridge = fakeBridgeFactory();
		const obs = await startObservation(pi, CTX, { startBridge: bridge.factory });

		await obs.stop();

		// Structural bus without off: channel subs stay registered but must be inert.
		expect(bus.listeners("task:subagent:progress")).toBe(1);
		expect(hookHandlers.get("before_subagent_spawn")).toHaveLength(0); // pi.off exists
		fireHook("before_subagent_spawn", spawnPayload);
		bus.emit("task:subagent:lifecycle", lifecyclePayload);
		expect(obs.roster.snapshot()).toHaveLength(0);
		expect(bridge.closed).toBe(true);
	});

	test("a bridge start failure unsubscribes handlers and rejects", async () => {
		const { pi, bus, hookHandlers } = fakePi();
		const failing = async (): Promise<BridgeHandle> => {
			await Promise.resolve();
			throw new Error("bind failed");
		};
		await expect(startObservation(pi, CTX, { startBridge: failing })).rejects.toThrow(
			"bind failed",
		);
		expect(bus.listeners("task:subagent:progress")).toBe(0);
		expect(hookHandlers.get("before_subagent_spawn")).toHaveLength(0);
	});

	test("roster notices are broadcast to the bridge as warn notice messages", async () => {
		const { pi, bus, fireHook } = fakePi();
		const bridge = fakeBridgeFactory();
		const obs = await startObservation(pi, CTX, { startBridge: bridge.factory });

		fireHook("before_subagent_spawn", spawnPayload);
		bus.emit("task:subagent:lifecycle", {
			id: "w1",
			agent: "scout",
			status: "mystery-status",
		});

		// Unrecognized status: reducer keeps last known status and emits a
		// notice — which must reach the viewer, not just the internal log.
		const notice = bridge.broadcasts.find((m) => m.type === "notice");
		expect(notice).toBeDefined();
		if (notice?.type === "notice") {
			expect(notice.level).toBe("warn");
			expect(notice.message).toContain("mystery-status");
		}
		expect(obs.roster.snapshot()[0]?.status).toBe("queued");
		await obs.stop();
	});

	test("absent pi.events degrades: one warn notice is broadcast after bridge start", async () => {
		const { pi, hookHandlers } = fakePi(true, false);
		const bridge = fakeBridgeFactory();
		const obs = await startObservation(pi, CTX, { startBridge: bridge.factory });

		// The spawn hook still subscribes; bus channels cannot.
		expect(hookHandlers.get("before_subagent_spawn")).toHaveLength(1);
		const notice = bridge.broadcasts.find((m) => m.type === "notice");
		expect(notice).toBeDefined();
		if (notice?.type === "notice") {
			expect(notice.level).toBe("warn");
			expect(notice.message.toLowerCase()).toContain("degraded");
		}
		expect(obs.roster.snapshot()).toHaveLength(0);
		await obs.stop();
	});
});

describe("lensExtension gate wiring", () => {
	test("outside Herdr the gate is a no-op: startObservation is never invoked", () => {
		setEnv(Object.fromEntries(HERDR_VARS.map((k) => [k, undefined])));
		const { pi, bus, hookHandlers, commands } = fakePi();
		let called = 0;
		const deps = {
			startObservation: (async () => {
				called++;
				return stubObservation();
			}) satisfies StartObservation,
		};

		lensExtension(pi, deps);

		expect(called).toBe(0);
		expect(commands).toHaveLength(0);
		expect(hookHandlers.size).toBe(0);
		expect(bus.channels.size).toBe(0);
	});

	test("inside Herdr the gate registers /lens then activates observation", async () => {
		setEnv(FULL_ENV);
		const { pi, commands } = fakePi();
		const seen: { pi: LensExtensionApi; ctx: CallerContext }[] = [];
		const deps = {
			startObservation: (async (p, ctx) => {
				seen.push({ pi: p, ctx });
				return stubObservation();
			}) satisfies StartObservation,
		};

		lensExtension(pi, deps);

		expect(commands.map((c) => c.name)).toEqual(["lens"]);
		await Promise.resolve();
		expect(seen).toHaveLength(1);
		expect(seen[0]?.ctx.paneId).toBe("w1:p1");
	});

	test("a rejected activation is routed to the error sink, never thrown", async () => {
		setEnv(FULL_ENV);
		const { pi } = fakePi();
		const errors: unknown[] = [];
		const deps = {
			startObservation: (async () => {
				await Promise.resolve();
				throw new Error("bridge bind failed");
			}) satisfies StartObservation,
			onObservationError(err: unknown) {
				errors.push(err);
			},
		};

		expect(() => lensExtension(pi, deps)).not.toThrow();
		// Drain microtasks: rejection must land in the sink, not the turn loop.
		await Promise.resolve();
		await Promise.resolve();
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(Error);
	});
});

describe("end-to-end (real bridge socket)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lens-wiring-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("a real viewer client receives hello with the live worker snapshot", async () => {
		const { pi, bus, fireHook } = fakePi();
		const socketPath = join(dir, "bridge.sock");
		const deps: ObservationDeps = {
			startBridge: (roster, opts) =>
				realStartBridge(roster, { ...opts, socketPath, coalesceMs: 10 }),
		};
		const obs = await startObservation(pi, CTX, deps);
		try {
			fireHook("before_subagent_spawn", spawnPayload);
			bus.emit("task:subagent:lifecycle", lifecyclePayload);
			bus.emit("task:subagent:progress", progressPayload);

			const client = await Client.connect(socketPath);
			try {
				client.handshake("sess-e2e");
				const hello = await client.waitFor((m) => m.type === "hello");
				if (hello.type !== "hello") throw new Error("unreachable");
				expect(hello.workers).toHaveLength(1);
				expect(hello.workers[0]?.id).toBe("w1");
				expect(hello.workers[0]?.counters?.tokens).toBe(12);
				expect(hello.history).toEqual([]);
			} finally {
				client.close();
			}
		} finally {
			await obs.stop();
		}
	});
});

/** Minimal NDJSON client for the real-bridge end-to-end check. */
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

	send(text: string): void {
		this.socket.write(text);
	}

	handshake(session: string): void {
		this.send(`${JSON.stringify({ v: 1, role: "viewer", session })}\n`);
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
