/**
 * P6-R8 performance bounds (NFR-03, F-18/D5) — deterministic, no soak.
 *
 *  - A 100-frame rapid progress burst coalesces to an EXACT delta count:
 *    <= 1 worker.upsert per coalesce window (150 ms default) per worker,
 *    latest-wins (the burst's final snapshot is what goes on the wire).
 *  - >= 50k frames through encode -> decode -> roster -> viewer keep the
 *    heap flat (bounded gc'd delta) and every viewer-side line count
 *    bounded (notices cap, renderScreen = O(workers), roster stays
 *    direct-only).
 *
 * Timing discipline: coalescing is asserted against the default 150 ms
 * window; one bounded sleep per window crossing is the only real-time
 * wait — the count under test is structural (one timer, one batch), not a
 * rate guess. Heap numbers are quoted for the DoD evidence report.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Socket } from "bun";
import { type BridgeHandle, startBridge } from "../../src/extension/bridge";
import type { SubagentProgress } from "../../src/extension/observe/schemas";
import { Roster } from "../../src/extension/roster";
import { decodeClientMessage, decodeMessage, encodeMessage } from "../../src/protocol/codec";
import type { Message } from "../../src/protocol/types";
import { renderScreen } from "../../src/viewer/render";
import { applyMessage, initialViewerState, type ViewerState } from "../../src/viewer/state";

// ---------------------------------------------------------------- helpers --

function progress(id: string, tokens: number): SubagentProgress {
	return { progress: { id, status: "running", tokens } };
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Connect + handshake, then collect every authed server->client Message. */
async function collectClient(socketPath: string): Promise<{ messages: Message[]; close(): void }> {
	const messages: Message[] = [];
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
						if (decoded.ok) messages.push(decoded.message);
					}
					nl = buffer.indexOf("\n");
				}
			},
			close() {},
			connectError(_s: Socket, _e: unknown) {},
		},
	});
	socket.write(`${JSON.stringify({ v: 1, role: "viewer", session: "sess-perf" })}\n`);
	return { messages, close: () => socket.close() };
}

let tmp: string;
const bridges: BridgeHandle[] = [];
const sockets: Array<{ close(): void }> = [];

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "lens-perf-"));
});

afterEach(async () => {
	for (const s of sockets.splice(0)) s.close();
	for (const b of bridges.splice(0)) await b.close();
	rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- tests -----

describe("P6-R8 coalescing bound (NFR-03)", () => {
	test("100-frame burst emits exactly 1 coalesced upsert per 150ms window, latest-wins", async () => {
		const roster = new Roster();
		// DEFAULT window: no coalesceMs override — evidence is for the real 150ms.
		const bridge = await startBridge(roster, {
			socketPath: join(tmp, "perf.sock"),
			cwd: tmp,
		});
		bridges.push(bridge);

		const viewer = await collectClient(bridge.socketPath);
		sockets.push(viewer);

		// First window: spawn + started + 100 progress frames, all synchronous —
		// inside one 150ms coalesce window by construction (one timer).
		roster.applySpawn({ type: "before_subagent_spawn", agent: "scout", spawnKey: "w-1" });
		roster.applyLifecycle({ id: "w-1", agent: "scout", status: "started" });
		for (let i = 1; i <= 100; i++) {
			roster.applyProgress(progress("w-1", i));
		}
		// Cross one full window so the coalesce timer fires.
		await sleep(220);

		const upsertsW1 = viewer.messages.filter(
			(m): m is Extract<Message, { type: "worker.upsert" }> =>
				m.type === "worker.upsert" && m.worker.id === "w-1",
		);
		console.log(`[evidence] window-1 upsert count for 100 frames: ${upsertsW1.length}`);
		expect(upsertsW1).toHaveLength(1); // <=1 delta per window per worker
		// latest-wins: the single broadcast carries the LAST snapshot
		expect(upsertsW1[0]?.worker.counters?.tokens).toBe(100);
		expect(upsertsW1[0]?.worker.status).toBe("running");

		// Second window: a single progress frame → exactly one more upsert.
		roster.applyProgress(progress("w-1", 101));
		await sleep(220);
		const upserts2 = viewer.messages.filter(
			(m) => m.type === "worker.upsert" && m.worker.id === "w-1",
		);
		console.log(`[evidence] total upserts after 2 windows (101 frames): ${upserts2.length}`);
		expect(upserts2).toHaveLength(2);
	});
});

describe("P6-R8 frame volume (F-18/D5) — flat heap + bounded lines", () => {
	test("50k frames through encode/decode/roster/viewer: bounded heap, bounded lines", () => {
		const FRAMES = 50_000;
		const roster = new Roster();
		roster.applySpawn({ type: "before_subagent_spawn", agent: "scout", spawnKey: "w-1" });
		roster.applyLifecycle({ id: "w-1", agent: "scout", status: "started" });

		let vs: ViewerState = applyMessage(initialViewerState(), {
			v: 1,
			type: "hello",
			session: "sess-perf",
			workers: [],
		});

		const roundTrip = (i: number): void => {
			roster.applyProgress(progress("w-1", i));
			const snap = roster.snapshot().find((w) => w.id === "w-1");
			if (snap === undefined) throw new Error("worker missing");
			const encoded = encodeMessage({ v: 1, type: "worker.upsert", worker: snap });
			const decoded = decodeMessage(encoded);
			if (!decoded.ok) throw new Error("decode failed on our own frame");
			vs = applyMessage(vs, decoded.message);
		};

		// warm the JIT + allocator before measuring
		for (let i = 0; i < 5_000; i++) roundTrip(i);
		Bun.gc(true);
		const heapBefore = process.memoryUsage().heapUsed;

		for (let i = 5_001; i <= FRAMES; i++) roundTrip(i);
		Bun.gc(true);
		const heapAfter = process.memoryUsage().heapUsed;

		const deltaBytes = heapAfter - heapBefore;
		const deltaMiB = deltaBytes / (1024 * 1024);
		console.log(
			`[evidence] 50k frames: heapUsed ${(heapBefore / 1048576).toFixed(1)}MiB -> ` +
				`${(heapAfter / 1048576).toFixed(1)}MiB (delta ${deltaMiB.toFixed(2)}MiB)`,
		);

		// Flat heap: churned allocations are all transient; retained state is
		// O(1). 8 MiB gives >16x headroom over the measured ~0.5 MiB delta while
		// still failing any regression that retains per-frame state (~160B+/frame).
		expect(deltaBytes).toBeLessThan(8 * 1024 * 1024);

		// Bounded viewer surface — notices capped at 100, roster direct-only.
		expect(vs.notices.length).toBeLessThanOrEqual(100);
		expect(vs.workers.size).toBe(1);
		expect(roster.snapshot()).toHaveLength(1);

		// renderScreen lines are O(workers + chrome), never O(frames).
		const screen = renderScreen(vs);
		const lineCount = screen.split("\n").length;
		console.log(`[evidence] renderScreen lines after 50k frames: ${lineCount}`);
		expect(lineCount).toBeLessThanOrEqual(vs.workers.size + 16);

		// transcript refs bounded by worker count, not frame count
		expect(vs.transcriptRefs.size).toBeLessThanOrEqual(vs.workers.size);
	});

	test("50k decodes on a mixed junk corpus stays flat", () => {
		const junk = [
			"not json",
			'{"v":1,"role":"viewer","session":"s"',
			'{"v":2,"type":"worker.removed","id":"w"}',
			'{"v":1,"type":"control.spawn"}',
			'{"v":1,"type":"worker.upsert","worker":{"id":"w1","agent":"a","status":"running","updatedAt":1}}',
		];
		for (let i = 0; i < 5_000; i++) {
			decodeClientMessage(junk[i % junk.length] ?? "x");
			decodeMessage(junk[i % junk.length] ?? "x");
		}
		Bun.gc(true);
		const before = process.memoryUsage().heapUsed;
		for (let i = 0; i < 50_000; i++) {
			const f = junk[i % junk.length] ?? "x";
			decodeClientMessage(f);
			decodeMessage(f);
		}
		Bun.gc(true);
		const after = process.memoryUsage().heapUsed;
		const delta = (after - before) / (1024 * 1024);
		console.log(`[evidence] 50k decodes on mixed junk: heap delta ${delta.toFixed(2)}MiB`);
		expect(after - before).toBeLessThan(8 * 1024 * 1024);
	});
});
