/**
 * Viewer entry point — `resolveViewerCommand()` target (F-16), launched by
 * P4 as an ordinary pane process with env from the F-01 handoff:
 * `LENS_SOCKET_PATH` = the bridge socket (never the server socket),
 * `LENS_SESSION` = OMP session id, optional `LENS_WORKER_ID` / `--worker <id>`
 * scopes to one worker (D3).
 *
 * The process is strictly read-only (P3-R7): the only outbound frame is the
 * ClientMessage handshake inside connectBridge; keyboard input only steers
 * local view state (select / expand / thinking toggle / quit). It performs
 * no pane orchestration itself — no reporting, no layout calls (P3-R12,
 * RC-7): it paints to stdout and exits.
 */
import type { BridgeClient, ConnectBridgeOptions } from "./client";
import { connectBridge } from "./client";
import { renderScreen, selectableWorkerIds } from "./render";
import { initialViewerState, type ViewerState } from "./state";
import { renderWorkerTranscript } from "./transcript";

export interface ViewerEnv {
	socketPath: string;
	session: string;
	workerId?: string;
}

/** F-01 handoff: reads only LENS_* vars; null when the launch env is absent. */
export function viewerEnv(env: NodeJS.ProcessEnv): ViewerEnv | null {
	const socketPath = env.LENS_SOCKET_PATH;
	const session = env.LENS_SESSION;
	if (socketPath === undefined || socketPath === "") return null;
	if (session === undefined || session === "") return null;
	const workerId = env.LENS_WORKER_ID;
	return workerId === undefined || workerId === ""
		? { socketPath, session }
		: { socketPath, session, workerId };
}

const USAGE =
	"usage: bun src/viewer/cli.ts [--worker <id>] " +
	"(env: LENS_SOCKET_PATH, LENS_SESSION[, LENS_WORKER_ID])";

/**
 * Env + argv → launch config. `--worker <id>`/`--worker=<id>` overrides
 * `LENS_WORKER_ID` (D3). Throws on any unrecognized argument or missing env —
 * P4 owns a well-formed launch, anything else is a usage error.
 */
export function resolveViewerConfig(env: NodeJS.ProcessEnv, argv: string[]): ViewerEnv {
	let workerArg: string | undefined;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--worker") {
			const value = argv[i + 1];
			if (value === undefined || value === "" || value.startsWith("--")) {
				throw new Error(`--worker requires an id\n${USAGE}`);
			}
			workerArg = value;
			i += 1;
		} else if (arg?.startsWith("--worker=") === true) {
			const value = arg.slice("--worker=".length);
			if (value === "") throw new Error(`--worker requires an id\n${USAGE}`);
			workerArg = value;
		} else {
			throw new Error(`unrecognized argument: ${arg}\n${USAGE}`);
		}
	}
	const base = viewerEnv(env);
	if (base === null) throw new Error(USAGE);
	return workerArg === undefined ? base : { ...base, workerId: workerArg };
}

/** Every action a key may trigger — the read-only vocabulary (P3-R7). */
export type KeyAction =
	| "none"
	| "selectNext"
	| "selectPrev"
	| "toggleFinished"
	| "toggleThinking"
	| "refresh"
	| "quit";

/**
 * Static keyboard map (P3-R7 keyboard-map audit): navigation/toggles only.
 * There is deliberately no binding that produces an outbound frame.
 */
const KEYMAP: Record<string, KeyAction> = {
	j: "selectNext",
	k: "selectPrev",
	"\x1b[B": "selectNext", // arrow down
	"\x1b[A": "selectPrev", // arrow up
	e: "toggleFinished",
	"\r": "toggleFinished",
	" ": "toggleFinished",
	t: "toggleThinking",
	r: "refresh",
	q: "quit",
	"\x03": "quit", // ctrl-c
};

/** Declared universe of actions — every keyFor result must land here. */
export const READONLY_ACTIONS: Record<KeyAction, true> = {
	none: true,
	selectNext: true,
	selectPrev: true,
	toggleFinished: true,
	toggleThinking: true,
	refresh: true,
	quit: true,
};

export function keyFor(key: string): KeyAction {
	return KEYMAP[key] ?? "none";
}

function moveSelection(s: ViewerState, delta: 1 | -1): ViewerState {
	const ids = selectableWorkerIds(s);
	if (ids.length === 0) return s.selectedId === undefined ? s : { ...s, selectedId: undefined };
	const idx = s.selectedId !== undefined ? ids.indexOf(s.selectedId) : -1;
	const next = idx === -1 ? (delta === 1 ? 0 : ids.length - 1) : idx + delta;
	if (next < 0 || next >= ids.length) return s; // clamp: no wrap
	return s.selectedId === ids[next] ? s : { ...s, selectedId: ids[next] };
}

/** Pure key effect on view state; quit/refresh/none leave state untouched. */
export function handleKey(s: ViewerState, action: KeyAction): ViewerState {
	switch (action) {
		case "selectNext":
			return moveSelection(s, 1);
		case "selectPrev":
			return moveSelection(s, -1);
		case "toggleFinished":
			return { ...s, finishedCollapsed: !s.finishedCollapsed };
		case "toggleThinking":
			return { ...s, thinkingVisible: !s.thinkingVisible };
		default:
			return s;
	}
}

/**
 * Splits a raw stdin chunk into logical keys: CSI sequences count as one
 * key, every other byte stands alone (paste-safe, split-sequence safe).
 */
export function splitKeys(chunk: string): string[] {
	const keys: string[] = [];
	for (let i = 0; i < chunk.length; i += 1) {
		if (chunk[i] === "\x1b" && chunk[i + 1] === "[" && chunk[i + 2] !== undefined) {
			keys.push(chunk.slice(i, i + 3));
			i += 2;
			continue;
		}
		const k = chunk[i];
		if (k !== undefined) keys.push(k);
	}
	return keys;
}

export interface WriteSink {
	write(text: string): void;
}

export interface RunViewerDeps {
	env: NodeJS.ProcessEnv;
	argv: string[];
	out: WriteSink;
	err: WriteSink;
	/** Injectable for tests; default connectBridge. */
	connect?: (opts: ConnectBridgeOptions) => Promise<BridgeClient>;
	/** Injectable for tests; default renderWorkerTranscript. */
	renderTranscript?: (sessionFile: string, thinking: boolean) => Promise<string>;
	/** Keys as logical key names; default: raw stdin (setRawMode when a TTY). */
	keys?: AsyncIterable<string>;
	/** Test hook invoked after every repaint. */
	onPaint?: (text: string) => void;
}

interface TranscriptSlot {
	workerId?: string;
	key?: string;
	/** Identity of the last rendered target (worker@file:thinking); the stamp
	 * is deliberately excluded so progress churn keeps prior text. */
	identity?: string;
	text?: string;
	error?: string;
}

const ANSI_RESET = "\x1b[2J\x1b[H";

/**
 * Overlay: the reducer replaces state wholesale; the UI layer owns the
 * view-only fields back onto it (selection/collapse/thinking). Selection
 * defaults to the first selectable row and survives across deltas while
 * its worker is still reported.
 */
function mergeUi(s: ViewerState, ui: ViewerState): ViewerState {
	const scoped = s.scope?.workerId;
	let selectedId: string | undefined;
	if (scoped === undefined) {
		const kept =
			ui.selectedId !== undefined && s.workers.has(ui.selectedId) ? ui.selectedId : undefined;
		const overlaid = { ...s, finishedCollapsed: ui.finishedCollapsed };
		selectedId = kept ?? selectableWorkerIds(overlaid)[0];
	}
	return {
		...s,
		scope: ui.scope ?? s.scope,
		selectedId,
		finishedCollapsed: ui.finishedCollapsed,
		thinkingVisible: ui.thinkingVisible,
	};
}

async function* stdinKeys(): AsyncIterable<string> {
	let raw = false;
	try {
		if (typeof process.stdin.setRawMode === "function") {
			process.stdin.setRawMode(true);
			raw = true;
		}
		for await (const chunk of process.stdin as AsyncIterable<string | Buffer>) {
			yield typeof chunk === "string" ? chunk : chunk.toString("utf8");
		}
	} finally {
		if (raw) process.stdin.setRawMode(false);
	}
}

/**
 * One viewer run: config → connect → repaint-on-change → keys until quit or
 * stdin EOF. Exit codes: 0 clean, 2 usage/env error. Never throws.
 */
export async function runViewer(deps: RunViewerDeps): Promise<number> {
	let cfg: ViewerEnv;
	try {
		cfg = resolveViewerConfig(deps.env, deps.argv);
	} catch (e) {
		deps.err.write(`${e instanceof Error ? e.message : String(e)}\n`);
		return 2;
	}

	const connect = deps.connect ?? connectBridge;
	const render =
		deps.renderTranscript ??
		((file: string, thinking: boolean) => renderWorkerTranscript(file, { thinking }));

	let ui: ViewerState = initialViewerState({
		scope: cfg.workerId === undefined ? undefined : { workerId: cfg.workerId },
	});
	let status: string = "connecting";
	const slot: TranscriptSlot = {};
	let renderEpoch = 0;
	let quit = false;

	const client = await connect({
		socketPath: cfg.socketPath,
		session: cfg.session,
		state: ui,
	});
	status = client.status();

	const paint = (): void => {
		const opts =
			slot.text !== undefined && slot.workerId !== undefined
				? { status, transcript: { workerId: slot.workerId, text: slot.text } }
				: { status };
		const text = renderScreen(
			ui,
			slot.error !== undefined ? { ...opts, transcriptError: slot.error } : opts,
		);
		deps.out.write(`${ANSI_RESET + text}\n`);
		deps.onPaint?.(text);
	};

	const transcriptTarget = (): { id: string; file: string; stamp: number } | null => {
		const worker =
			cfg.workerId !== undefined
				? ui.workers.get(cfg.workerId)
				: ui.selectedId !== undefined
					? ui.workers.get(ui.selectedId)
					: undefined;
		if (worker === undefined) return null;
		const file = worker.sessionFile ?? ui.transcriptRefs.get(worker.id)?.sessionFile;
		if (file === undefined) return null;
		return { id: worker.id, file, stamp: worker.updatedAt };
	};

	/**
	 * Two-level freshness: `identity` (worker/file/thinking) decides whether
	 * the displayed text still applies — a stamp-only churn (progress updates
	 * touch updatedAt ~150ms cadence) must NOT blank the last good render to
	 * "(transcript loading…)". `key` additionally carries the stamp + epoch
	 * so a completed render re-fires on new data or an explicit refresh.
	 *
	 * Single-flight (P3-R11): at most one renderWorkerTranscript child runs
	 * at a time. Refreshes landing while one is in flight only update
	 * slot.key; when the render settles, pump() launches exactly ONE render
	 * for the latest key — bursts coalesce, superseded work is never spawned.
	 */
	let renderInFlight = false;
	let launchedKey: string | undefined;

	const computeKey = (
		target: { id: string; file: string; stamp: number },
		thinking: boolean,
	): string => `${target.id}@${target.file}:${thinking}#${target.stamp}:${renderEpoch}`;

	const launchRender = (
		target: { id: string; file: string; stamp: number },
		key: string,
		thinking: boolean,
	): void => {
		renderInFlight = true;
		launchedKey = key;
		const epoch = renderEpoch;
		const identity = `${target.id}@${target.file}:${thinking}`;
		void (async () => {
			try {
				const text = await render(target.file, thinking);
				if (slot.identity === identity && epoch === renderEpoch && !quit) {
					slot.text = text;
					slot.error = undefined;
					paint();
				}
			} catch (e) {
				if (slot.identity === identity && epoch === renderEpoch && !quit) {
					slot.error = e instanceof Error ? e.message : String(e);
					paint();
				}
			} finally {
				renderInFlight = false;
				pump(); // trailing refresh: launches iff the key moved on
				paint();
			}
		})();
	};

	client.subscribe((s) => {
		ui = mergeUi(s, ui);
		refreshTranscript(false);
		paint();
	});
	client.onStatus((st) => {
		status = st;
		paint();
	});
	ui = mergeUi(client.state, ui);
	refreshTranscript(true);
	paint();

	const keys = deps.keys ?? stdinKeys();
	for await (const chunk of keys) {
		for (const k of splitKeys(chunk)) {
			const action = keyFor(k);
			if (action === "none") continue;
			if (action === "quit") {
				quit = true;
				break;
			}
			if (action === "refresh") {
				renderEpoch += 1;
				refreshTranscript(true);
			} else {
				ui = handleKey(ui, action);
				refreshTranscript(action === "selectNext" || action === "selectPrev");
			}
			paint();
		}
		if (quit) break;
	}
	await client.close();
	return 0;
}

/** Entry — runnable as `bun src/viewer/cli.ts` with the F-01 env set. */
export async function main(): Promise<void> {
	process.exitCode = await runViewer({
		env: process.env,
		argv: process.argv.slice(2),
		out: process.stdout,
		err: process.stderr,
	});
}

if (import.meta.main) {
	void main();
}
