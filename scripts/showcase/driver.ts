/**
 * Showcase driver: runs the REAL viewer (runViewer) against a scripted local
 * bridge, feeding realistic worker events + key input on a timeline. Recorded
 * with asciinema; the product code is unmodified. Demo data only.
 *
 * usage: bun scripts/showcase/driver.ts <scenario>
 * scenarios: overview | scroll | multisession (multisession uses two bridges)
 */
import { runViewer } from "../../src/viewer/cli";
import type { BridgeClient, ConnectBridgeOptions } from "../../src/viewer/client";
import { applyMessage, initialViewerState, type ViewerState } from "../../src/viewer/state";
import type { Message, WorkerSnapshot } from "../../src/protocol/types";

const scenario = process.argv[2] ?? "overview";

function worker(id: string, name: string, over: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
	return {
		id,
		name,
		agent: "task",
		status: "running",
		updatedAt: Date.now(),
		model: "devin/swe-2-1",
		counters: { requests: 1, tokens: 1200, durationMs: 4000 },
		...over,
	};
}

/** Scripted in-process bridge: same surface as connectBridge, no socket. */
function scriptedBridge(initial: Message[]) {
	let state = initialViewerState();
	const subs = new Set<(s: ViewerState) => void>();
	const statusSubs = new Set<(s: string) => void>();
	for (const m of initial) state = applyMessage(state, m);
	const client: BridgeClient = {
		get state() {
			return state;
		},
		status: () => "connected",
		subscribe(cb) {
			subs.add(cb);
		},
		onStatus(cb) {
			statusSubs.add(cb as (s: string) => void);
		},
		close: async () => {},
	};
	return {
		client,
		emit(m: Message) {
			state = applyMessage(state, m);
			for (const cb of subs) cb(state);
		},
	};
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Key feed: yields keys on a timeline, then ends (viewer exits on EOF). */
async function* keys(plan: [number, string][]): AsyncIterable<string> {
	let t = 0;
	for (const [at, key] of plan) {
		await sleep(Math.max(0, at - t));
		t = at;
		yield key;
	}
	await sleep(1200);
}

const TX = Array.from({ length: 120 }, (_, i) => {
	if (i % 9 === 0) return `$ step ${i / 9}: checking module ${i}`;
	if (i % 9 === 1) return `  reading src/module-${i}.ts …`;
	if (i % 9 === 4) return `  ✓ found 2 references`;
	return `  … analysis line ${i}`;
}).join("\n");

async function main(): Promise<void> {
	const hello: Message = {
		v: 1,
		type: "hello",
		session: "01a21885-demo",
		workers: [],
	};
	const bridge = scriptedBridge([hello]);
	const connect = async (_opts: ConnectBridgeOptions) => bridge.client;
	const renderTranscript = async (_file: string, _thinking: boolean) => TX;

	if (scenario === "overview") {
		// spawn two workers, progress, one completes + is reaped (retained!), select
		const events: [number, () => void][] = [
			[1500, () => bridge.emit({ v: 1, type: "worker.upsert", worker: worker("w1", "scout-docs", { assignment: "map the auth flow", sessionFile: "/tmp/demo-w1.jsonl" }) })],
			[3200, () => bridge.emit({ v: 1, type: "worker.upsert", worker: worker("w2", "review-pr-412", { assignment: "review PR #412", sessionFile: "/tmp/demo-w2.jsonl" }) })],
			[5000, () => bridge.emit({ v: 1, type: "worker.upsert", worker: worker("w1", "scout-docs", { assignment: "map the auth flow", sessionFile: "/tmp/demo-w1.jsonl", counters: { requests: 4, tokens: 18400, durationMs: 12000 }, activity: "reading src/auth" }) })],
			[7000, () => bridge.emit({ v: 1, type: "worker.upsert", worker: worker("w2", "review-pr-412", { assignment: "review PR #412", sessionFile: "/tmp/demo-w2.jsonl", status: "completed", counters: { requests: 7, tokens: 30100, cost: 0.08, durationMs: 21000 } }) })],
			[8200, () => bridge.emit({ v: 1, type: "worker.removed", id: "w2" })],
		];
		// absolute-time scheduler (the old for-await slept the SUM of delays)
		void (async () => {
			const t0 = Date.now();
			for (const [at, fn] of events) {
				const wait = at - (Date.now() - t0);
				if (wait > 0) await sleep(wait);
				fn();
			}
		})();
		const keyPlan: [number, string][] = [
			[9500, "j"], // select the finished worker (retained after reap)
			[11500, "k"], // back to the live one
			[13000, "e"], // collapse finished
			[14500, "e"], // expand again
			[16000, "q"],
		];
		await runViewer({
			env: { LENS_SOCKET_PATH: "/demo", LENS_SESSION: "01a21885-demo" },
			argv: [],
			out: process.stdout,
			err: process.stderr,
			connect,
			renderTranscript,
			keys: keys(keyPlan),
		});
	} else if (scenario === "scroll") {
		const bridge2 = scriptedBridge([
			{ v: 1, type: "hello", session: "01a21885-demo", workers: [worker("w1", "scout-docs", { assignment: "map the auth flow", sessionFile: "/tmp/demo-w1.jsonl", counters: { requests: 12, tokens: 48200, durationMs: 61000 } })] },
		]);
		const keyPlan: [number, string][] = [
			[2500, "K"], [3000, "K"], [3500, "K"],
			[4500, "\x1b[5~"], // PgUp
			[6000, "\x1b[5~"],
			[7500, "g"], // top
			[9500, "\x1b[<64;40;12M"], // wheel up
			[10000, "\x1b[<64;40;12M"],
			[11000, "\x1b[<65;40;12M"], // wheel down
			[12000, "G"], // follow
			[14000, "q"],
		];
		await runViewer({
			env: { LENS_SOCKET_PATH: "/demo", LENS_SESSION: "01a21885-demo" },
			argv: [],
			out: process.stdout,
			err: process.stderr,
			connect: async () => bridge2.client,
			renderTranscript,
			keys: keys(keyPlan),
		});
	} else {
		console.error(`unknown scenario: ${scenario}`);
		process.exit(2);
	}
}

await main();
process.exit(0);