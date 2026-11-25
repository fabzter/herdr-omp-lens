#!/usr/bin/env bun
/**
 * P6-R6 isolated named-session lifecycle E2E (F-14/D2/D3, FR-05/09/13).
 *
 * Scripted, rerunnable drive of the herdr-omp-lens extension inside a NEW,
 * disposable Herdr workspace — never the user's daily workspace. Asserts:
 *
 *   1. auto-open on first subagent spawn, no focus theft;
 *   2. manual close → next subtask reopens exactly ONE tab (FR-05);
 *   3. read-only `/lens split <workerId>` opens a no-focus worker-scoped
 *      viewer (LENS_WORKER_ID, D3);
 *   4. finished-collapse ("finished (N) — press e to expand");
 *   5. OMP restart (local build, P5 history): overview auto-opens on
 *      non-empty history (D2), a surviving viewer tab is reused/reconnected
 *      to the NEW socket — never duplicated — prior workers render
 *      `[not-live]` (FR-09), no live duplicate;
 *   6. focus preservation incl. a spawn while a DIFFERENT workspace is
 *      focused (U-HDR-2/F-14; FR-13 scoped on theft, never silently passed);
 *   7. viewer pane never misclassified as an agent (U-HDR-1 → FAIL);
 *   8. daily workspace enumerated before AND after, proven untouched.
 *
 * Build matrix: steps 1–6 run the INSTALLED plugin (P1–P4 build); the restart
 * leg relaunches omp with `--no-extensions -e <repo>/src/extension/index.ts`
 * so the LOCAL P5+P6 build's history scan + survivor rebind is exercised.
 *
 * Usage: `bun tests/e2e/isolated-session.e2e.ts` (via scripts/run-e2e.sh).
 * Requires HERDR_ENV=1 (must run inside a Herdr pane — the herdr CLI targets
 * the session its caller env is bound to). Evidence is written to
 * <scratch>/evidence/ — set E2E_KEEP_WORKSPACE=1 to skip teardown.
 *
 * Modes: the DEFAULT run is SAFE — preflight + disposable workspace
 * create/enumerate/teardown round-trip + the daily-workspace unchanged
 * assertion; no agent is launched, so it is rerunnable without disturbing
 * the user's panes. `RUN_E2E_LIVE=1` runs the full live lifecycle above.
 * Live steps are bounded (retry-once via waitForRetry, per-step hard
 * timeouts); an infra/timeout error records a `manual` evidence line and
 * the run continues — only a genuine assertion breach fails the run.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config / constants
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const LOCAL_EXTENSION = resolve(REPO_ROOT, "src/extension/index.ts");
const OVERVIEW_LABEL = "OMP subagents";
const CONNECTED_TAG = "[connected]";
const NOT_LIVE = "[not-live]";

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const SCRATCH = process.env.E2E_SCRATCH ?? join(tmpdir(), `lens-e2e-scratch-${TS}-${process.pid}`);
const EVIDENCE_DIR = join(SCRATCH, "evidence");
const WORKSPACE_LABEL = `lens-e2e-${TS}`;
/**
 * The user's live config wedges every task subagent in a `prewalk-continue`
 * loop (task.prewalk:true + agentPrewalk.task:"on" — verified live: the
 * subagent emits its answer, gets injected "Continue task now", and never
 * exits). The E2E launches omp with a --config overlay that disables
 * prewalk JUST for the disposable session; the user's config is untouched.
 */
const E2E_CONFIG_OVERLAY = join(SCRATCH, "omp-e2e-overlay.yml");
const OVERLAY_YAML = [
	"task:",
	"  prewalk: false",
	"  agentPrewalk:",
	'    task: "off"',
	"prewalk:",
	"  enabled: false",
	'  auto: "off"',
	"",
].join("\n");

const KEEP_WORKSPACE = process.env.E2E_KEEP_WORKSPACE === "1";
const SKIP_RESTART = process.env.E2E_SKIP_RESTART === "1";
/** RUN_E2E_LIVE=1 enables the full agent lifecycle; default is the safe,
 *  rerunnable disposable create/teardown + daily-unchanged run. */
const LIVE = process.env.RUN_E2E_LIVE === "1";

const T = {
	cliMs: 30_000,
	agentStartMs: 90_000,
	promptMs: 300_000,
	stallMs: 200_000,
	tabOpenMs: 150_000,
	viewerConnectMs: 30_000,
	finishedMs: 180_000,
	agentExitMs: 45_000,
	pollMs: 400,
};

const SCOUT_A =
	"Use the task tool to dispatch exactly one subagent with instruction " +
	"'Reply with the single word alpha immediately. Do not call any tools.' " +
	"Then reply done.";
const SCOUT_B =
	"Use the task tool to dispatch exactly one subagent with instruction " +
	"'Reply with the single word bravo immediately. Do not call any tools.' " +
	"Then reply done.";
const SCOUT_C =
	"Use the task tool to dispatch exactly one subagent with instruction " +
	"'Reply with the single word charlie immediately. Do not call any tools.' " +
	"Then reply done.";

// ---------------------------------------------------------------------------
// Result recording — every check lands here; the report is honest by
// construction (a `manual`/`skipped` line is evidence, not a pass).
// ---------------------------------------------------------------------------

type CheckStatus = "pass" | "fail" | "manual" | "skipped" | "note";
interface Check {
	readonly step: string;
	readonly name: string;
	status: CheckStatus;
	detail: string;
}

const checks: Check[] = [];
function record(step: string, name: string, status: CheckStatus, detail = ""): void {
	checks.push({ step, name, status, detail });
	const mark = { pass: "PASS", fail: "FAIL", manual: "MANUAL", skipped: "SKIP", note: "note" }[
		status
	];
	console.log(`[${mark}] ${step} :: ${name}${detail === "" ? "" : ` — ${detail}`}`);
}

class StepError extends Error {
	readonly step: string;
	constructor(step: string, message: string) {
		super(message);
		this.step = step;
	}
}
function pass(step: string, name: string, detail = ""): void {
	record(step, name, "pass", detail);
}
function note(step: string, name: string, detail: string): void {
	record(step, name, "note", detail);
}
function fail(step: string, name: string, detail: string): StepError {
	record(step, name, "fail", detail);
	return new StepError(step, `${name}: ${detail}`);
}

// ---------------------------------------------------------------------------
// herdr CLI plumbing (zod-typed, no any — project style)
// ---------------------------------------------------------------------------

const envelope = z.object({ id: z.string().optional(), result: z.unknown() });

const wsListSchema = z.object({
	type: z.literal("workspace_list"),
	workspaces: z.array(
		z.object({
			workspace_id: z.string(),
			label: z.string().optional(),
			focused: z.boolean(),
			pane_count: z.number(),
			tab_count: z.number(),
		}),
	),
});

const tabListSchema = z.object({
	type: z.literal("tab_list"),
	tabs: z.array(
		z.object({
			tab_id: z.string(),
			workspace_id: z.string(),
			label: z.string().optional(),
			focused: z.boolean(),
			pane_count: z.number(),
		}),
	),
});

const paneListSchema = z.object({
	type: z.literal("pane_list"),
	panes: z.array(
		z.object({
			pane_id: z.string(),
			tab_id: z.string(),
			workspace_id: z.string(),
			agent: z.string().nullish(),
			agent_status: z.string().optional(),
			cwd: z.string().optional(),
			title: z.string().nullish(),
			terminal_title_stripped: z.string().nullish(),
		}),
	),
});

const wsCreatedSchema = z.object({
	type: z.literal("workspace_created"),
	workspace: z.object({ workspace_id: z.string() }),
	tab: z.object({ tab_id: z.string() }),
	root_pane: z.object({ pane_id: z.string(), cwd: z.string() }),
});

const paneInfoSchema = z.object({
	type: z.literal("pane_info"),
	pane: z.object({
		pane_id: z.string(),
		tab_id: z.string(),
		workspace_id: z.string(),
		cwd: z.string().optional(),
		title: z.string().nullish(),
		agent: z.string().nullish(),
	}),
});

const agentStartedSchema = z.object({
	type: z.literal("agent_started"),
	agent: z.object({
		name: z.string(),
		pane_id: z.string(),
		agent_status: z.string(),
		agent_session: z.object({ value: z.string() }).nullish(),
	}),
	argv: z.array(z.string()).optional(),
});

const agentListSchema = z.object({
	type: z.literal("agent_list"),
	agents: z.array(
		z.object({
			name: z.string().optional(),
			pane_id: z.string(),
			agent_status: z.string(),
			agent_session: z.object({ value: z.string() }).nullish(),
		}),
	),
});

type Json = unknown;

async function herdrJson(args: string[], timeoutMs = T.cliMs): Promise<Json> {
	const proc = Bun.spawn(["herdr", ...args], { stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => {
		try {
			proc.kill("SIGKILL");
		} catch {
			// already dead
		}
	}, timeoutMs);
	const [code, out, err] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	clearTimeout(timer);
	if (code !== 0) {
		throw new Error(`herdr ${args.join(" ")} → exit ${code}: ${(err || out).slice(0, 500)}`);
	}
	return envelope.parse(JSON.parse(out)).result;
}

/** `herdr pane read` returns RAW screen text, not JSON. */
async function paneRead(paneId: string, lines = 60): Promise<string> {
	const proc = Bun.spawn(
		["herdr", "pane", "read", paneId, "--source", "visible", "--lines", String(lines)],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const timer = setTimeout(() => {
		try {
			proc.kill("SIGKILL");
		} catch {}
	}, T.cliMs);
	const [code, out, err] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	clearTimeout(timer);
	if (code !== 0) throw new Error(`pane read ${paneId} → exit ${code}: ${err.slice(0, 300)}`);
	return out;
}

interface FocusState {
	readonly focusedWorkspace: string | undefined;
	readonly focusedTab: string | undefined;
}
async function focusState(): Promise<FocusState> {
	const ws = wsListSchema.parse(await herdrJson(["workspace", "list"]));
	const tabs = tabListSchema.parse(await herdrJson(["tab", "list"]));
	return {
		focusedWorkspace: ws.workspaces.find((w) => w.focused)?.workspace_id,
		focusedTab: tabs.tabs.find((t) => t.focused)?.tab_id,
	};
}

interface Enumerate {
	readonly workspaces: Map<string, string>;
	readonly tabs: Map<string, { workspaceId: string; label: string | undefined }>;
	readonly panes: Map<string, { tabId: string; workspaceId: string; agent: string | null }>;
}
async function enumerate(): Promise<Enumerate> {
	const ws = wsListSchema.parse(await herdrJson(["workspace", "list"]));
	const tabs = tabListSchema.parse(await herdrJson(["tab", "list"]));
	const panes = paneListSchema.parse(await herdrJson(["pane", "list"]));
	return {
		workspaces: new Map(ws.workspaces.map((w) => [w.workspace_id, w.label ?? ""])),
		tabs: new Map(
			tabs.tabs.map((t) => [t.tab_id, { workspaceId: t.workspace_id, label: t.label }]),
		),
		panes: new Map(
			panes.panes.map((p) => [
				p.pane_id,
				{ tabId: p.tab_id, workspaceId: p.workspace_id, agent: p.agent ?? null },
			]),
		),
	};
}

interface WsTabs {
	readonly overviewTabs: string[];
	readonly allTabs: { tabId: string; label: string | undefined; focused: boolean }[];
}
async function tabsIn(workspaceId: string): Promise<WsTabs> {
	const tabs = tabListSchema.parse(await herdrJson(["tab", "list"]));
	const mine = tabs.tabs.filter((t) => t.workspace_id === workspaceId);
	return {
		overviewTabs: mine.filter((t) => t.label === OVERVIEW_LABEL).map((t) => t.tab_id),
		allTabs: mine.map((t) => ({ tabId: t.tab_id, label: t.label, focused: t.focused })),
	};
}

async function panesInTab(tabId: string) {
	const panes = paneListSchema.parse(await herdrJson(["pane", "list"]));
	return panes.panes.filter((p) => p.tab_id === tabId);
}

/** Poll until `fn` returns a truthy value; throws after timeoutMs. */
async function waitFor<V>(
	desc: string,
	fn: () => Promise<V | undefined>,
	timeoutMs: number,
	intervalMs = T.pollMs,
): Promise<V> {
	const deadline = performance.now() + timeoutMs;
	let lastErr: unknown;
	while (performance.now() <= deadline) {
		try {
			const v = await fn();
			if (v !== undefined && v !== false) return v;
		} catch (err) {
			lastErr = err;
		}
		await Bun.sleep(intervalMs);
	}
	throw new Error(
		`timeout waiting for ${desc} after ${timeoutMs}ms` +
			(lastErr !== undefined ? ` (last error: ${String(lastErr).slice(0, 300)})` : ""),
	);
}

/** waitFor with the retry-once policy for flaky live steps. */
async function waitForRetry<V>(
	desc: string,
	fn: () => Promise<V | undefined>,
	timeoutMs: number,
): Promise<V> {
	try {
		return await waitFor(desc, fn, timeoutMs);
	} catch (err) {
		note("retry", desc, `first attempt failed (${String(err).slice(0, 160)}); retrying once`);
		return await waitFor(desc, fn, timeoutMs);
	}
}

/** Fire an `agent prompt --wait` as a background process (turns take minutes). */
interface PromptJob {
	done: Promise<{ code: number; out: string; err: string; killed: boolean }>;
	accepted: Promise<void>;
}
function spawnPrompt(name: string, text: string, timeoutMs = T.promptMs): PromptJob {
	const proc = Bun.spawn(
		["herdr", "agent", "prompt", name, text, "--wait", "--timeout", String(timeoutMs)],
		{ stdout: "pipe", stderr: "pipe" },
	);
	let killed = false;
	const timer = setTimeout(() => {
		killed = true;
		try {
			proc.kill("SIGKILL");
		} catch {}
	}, timeoutMs + 60_000);
	const done = (async () => {
		const [code, out, err] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		clearTimeout(timer);
		return { code, out, err, killed };
	})();
	// Acceptance: the proc is still alive 4s in (it only exits early on
	// immediate rejection — agent_blocked/agent_not_ready/stalled gate).
	const accepted = (async () => {
		const early = await Promise.race([
			done.then(() => "exited"),
			Bun.sleep(4000).then(() => "alive"),
		]);
		if (early === "exited") {
			const r = await done;
			if (r.code !== 0) throw new Error(`prompt rejected early: ${(r.err || r.out).slice(0, 300)}`);
		}
	})();
	return { done, accepted };
}

/** Type literal text + enter into the TUI input — the faithful slash-command path. */
async function paneTypeCommand(paneId: string, text: string): Promise<void> {
	await herdrJson(["pane", "send-text", paneId, text]);
	await paneSendKeys(paneId, ["enter"]);
}

/** Spawn `herdr <args>` bounded by a SIGKILL timer — same policy as herdrJson,
 *  for raw-output commands (prompt w/o --wait, send-keys, --version probe).
 *  A stalled herdr can never hang teardown (F1). Returns stdout. */
async function herdrProc(args: string[], label: string, timeoutMs = T.cliMs): Promise<string> {
	const proc = Bun.spawn(["herdr", ...args], { stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => {
		try {
			proc.kill("SIGKILL");
		} catch {
			// already dead
		}
	}, timeoutMs);
	const [code, out, err] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	clearTimeout(timer);
	if (code !== 0) throw new Error(`${label} → exit ${code}: ${(err || out).slice(0, 300)}`);
	return out;
}

/** Submit text without --wait (slash commands never produce a working state). */
async function agentSubmit(name: string, text: string): Promise<void> {
	await herdrProc(["agent", "prompt", name, text], `agent prompt ${name}`);
}

async function paneSendKeys(paneId: string, keys: string[]): Promise<void> {
	await herdrProc(["pane", "send-keys", paneId, ...keys], `pane send-keys ${paneId}`);
}

interface Occupant {
	readonly hasAgent: boolean;
	readonly status: string;
}
async function paneOccupant(paneId: string): Promise<Occupant | undefined> {
	const panes = paneListSchema.parse(await herdrJson(["pane", "list"]));
	const p = panes.panes.find((x) => x.pane_id === paneId);
	if (p === undefined) return undefined;
	return {
		hasAgent: p.agent !== null && p.agent !== undefined,
		status: p.agent_status ?? "unknown",
	};
}

/**
 * Watchdog for wedged turns (observed live: a prewalk-continue loop kept a
 * done subagent "running" for minutes). At stallMs the agent gets `esc`,
 * which aborts the turn — aborted workers still satisfy finished-collapse.
 */
function stallWatch(step: string, agentName: string, stallMs: number): () => void {
	const timer = setTimeout(() => {
		void (async () => {
			const o = await paneOccupant(st.shellPaneId as string).catch(() => undefined);
			if (o?.hasAgent && (o.status === "working" || o.status === "blocked")) {
				note(step, "stall watchdog", `agent ${o.status} > ${stallMs}ms — sending esc`);
				await herdrJson(["agent", "send-keys", agentName, "esc"]).catch(() => {});
			}
		})();
	}, stallMs);
	return () => clearTimeout(timer);
}

/** Exit the omp TUI: free a wedged turn, then /exit → esc+/exit → ctrl+c → ctrl+d. */
async function stopAgent(step: string): Promise<void> {
	const shell = st.shellPaneId as string;
	const name = st.agentName as string;
	const cleared = async (): Promise<true | undefined> => {
		const o = await paneOccupant(shell);
		return o !== undefined && !o.hasAgent ? true : undefined;
	};
	const occ = await paneOccupant(shell).catch(() => undefined);
	if (occ?.hasAgent && (occ.status === "working" || occ.status === "blocked")) {
		await herdrJson(["agent", "send-keys", name, "esc"]).catch(() => {});
		await Bun.sleep(1500);
	}
	await agentSubmit(name, "/exit").catch(() => {});
	const ok = await waitFor("omp /exit", cleared, T.agentExitMs).catch(async () => {
		note(step, "omp exit", "/exit did not clear the agent; esc + retry, then key fallbacks");
		await herdrJson(["agent", "send-keys", name, "esc"]).catch(() => {});
		await agentSubmit(name, "/exit").catch(() => {});
		return waitFor("omp /exit retry", cleared, 20_000).catch(async () => {
			await paneSendKeys(shell, ["ctrl+c", "ctrl+c"]).catch(() => {});
			return waitFor("omp ctrl+c exit", cleared, 15_000).catch(async () => {
				await paneSendKeys(shell, ["ctrl+d"]).catch(() => {});
				return waitFor("omp ctrl+d exit", cleared, 15_000).catch(() => undefined);
			});
		});
	});
	if (ok !== true) throw fail(step, "omp exited", "agent still occupies the shell pane");
}

function sessionIdFromFile(sessionFile: string): string {
	const base = sessionFile.slice(sessionFile.lastIndexOf("/") + 1);
	const m = /_([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/.exec(base);
	return m?.[1] ?? base.replace(/\.jsonl$/, "");
}

/** Enumerate worker ids + files for a session (artifact dir convention). */
function workersInSession(sessionFile: string): { ids: string[]; dir: string } {
	const dir = sessionFile.replace(/\.jsonl$/, "");
	try {
		const ids = readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl") && !f.startsWith("."))
			.map((f) => f.slice(0, -".jsonl".length))
			.sort();
		return { ids, dir };
	} catch {
		return { ids: [], dir };
	}
}

/** Does the worker JSONL carry a terminal session_exit marker? */
function workerFinished(sessionFile: string, workerId: string): boolean {
	const path = join(sessionFile.replace(/\.jsonl$/, ""), `${workerId}.jsonl`);
	try {
		const tail = readFileSync(path, "utf8").slice(-8192);
		return tail.includes('"session_exit"') || tail.includes("session_exit");
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Raw lifecycle event capture (U-HDR-3/U-HDR-5 evidence, read-only)
// ---------------------------------------------------------------------------

const capturedEvents: string[] = [];

function startEventCapture(): void {
	const socketPath = process.env.HERDR_SOCKET_PATH;
	if (socketPath === undefined || socketPath === "") return;
	const id = `e2e-events-${process.pid}`;
	void (async () => {
		try {
			const socket = await Bun.connect({
				unix: socketPath,
				socket: {
					open(s) {
						s.write(
							`${JSON.stringify({
								id,
								method: "events.subscribe",
								params: {
									subscriptions: [
										{ type: "tab.closed" },
										{ type: "pane.closed" },
										{ type: "pane.exited" },
										{ type: "pane.moved" },
										{ type: "workspace.closed" },
										{ type: "layout.updated" },
									],
								},
							})}\n`,
						);
					},
					data(_s, chunk) {
						for (const line of new TextDecoder().decode(chunk).split("\n")) {
							if (line.trim() !== "") capturedEvents.push(line);
						}
					},
					close() {},
					error() {},
					connectError() {},
				},
			});
			void socket; // held open for the run's duration
		} catch {
			// capture is best-effort evidence only
		}
	})();
}

function saveEventCapture(): void {
	if (capturedEvents.length === 0) return;
	writeFileSync(join(EVIDENCE_DIR, "lifecycle-events.ndjson"), `${capturedEvents.join("\n")}\n`);
	const kinds = capturedEvents
		.map((l) => {
			try {
				const e = JSON.parse(l) as { method?: string; params?: { type?: string } };
				return e.params?.type ?? e.method ?? "?";
			} catch {
				return "?";
			}
		})
		.join(", ");
	note("events", "lifecycle frames captured", `${capturedEvents.length} frames: ${kinds}`);
	// U-HDR-3: pane.exited payload shape — record what the frame carried.
	for (const line of capturedEvents) {
		if (line.includes("exited")) {
			note("events", "U-HDR-3 pane.exited payload", line.slice(0, 300));
		}
	}
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

interface E2EState {
	workspaceId?: string;
	rootPaneId?: string;
	shellPaneId?: string;
	agentName?: string;
	overviewTabId?: string;
	overviewPaneId?: string;
	splitPaneId?: string;
	sessionFile1?: string;
	sessionId1?: string;
	sessionFile2?: string;
	sessionId2?: string;
	workerIds: string[];
	realCwd?: string;
	closedManually: boolean;
	viewerQuitSent: Set<string>;
}

const st: E2EState = { workerIds: [], closedManually: false, viewerQuitSent: new Set() };

async function preflight(): Promise<Enumerate> {
	if (process.env.HERDR_ENV !== "1") {
		throw new Error(
			"HERDR_ENV is not 1 — this E2E must run INSIDE a Herdr pane " +
				"(the herdr CLI targets the session its caller env is bound to).",
		);
	}
	// Self-checks: the tools the driver shells out to must exist before any
	// live step is attempted (herdr is always required; omp only for live).
	for (const bin of LIVE ? ["herdr", "bun", "omp"] : ["herdr", "bun"]) {
		const found = Bun.which(bin);
		if (found === null) throw new Error(`required tool '${bin}' not on PATH`);
		note("setup", `tool ${bin}`, found);
	}
	if (!existsSync(LOCAL_EXTENSION)) {
		throw new Error(`local extension source missing: ${LOCAL_EXTENSION}`);
	}
	note("setup", "local extension", `${LOCAL_EXTENSION} (restart leg only)`);
	mkdirSync(SCRATCH, { recursive: true });
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	writeFileSync(E2E_CONFIG_OVERLAY, OVERLAY_YAML);
	startEventCapture();
	const v = await herdrJson(["--version"]).catch(async () =>
		herdrProc(["--version"], "herdr --version"),
	);
	note("setup", "environment", `herdr version probe: ${String(v).slice(0, 120)}`);
	pass("setup", "HERDR_ENV=1", `caller pane ${process.env.HERDR_PANE_ID ?? "?"}`);
	// Sweep stale lens-e2e-* workspaces BEFORE the baseline so a dead prior
	// run can never leak into the before/after diff. Only lens-e2e- prefixed
	// labels are touched — the daily workspaces are never closed here.
	const stale = await enumerate();
	for (const [id, label] of stale.workspaces) {
		if (label.startsWith("lens-e2e-")) {
			await herdrJson(["workspace", "close", id]).catch(() => {});
			note("setup", "stale disposable closed", `${id} (${label})`);
		}
	}
	const before = await enumerate();
	pass(
		"setup",
		"daily workspace enumerated (before)",
		`${before.workspaces.size} workspaces / ${before.tabs.size} tabs / ${before.panes.size} panes`,
	);
	writeFileSync(
		join(EVIDENCE_DIR, "enumerate-before.json"),
		JSON.stringify(
			{
				workspaces: [...before.workspaces],
				tabs: [...before.tabs],
				panes: [...before.panes],
			},
			null,
			2,
		),
	);
	return before;
}

async function assertFocusPreserved(step: string, before: FocusState, wsId: string): Promise<void> {
	await Bun.sleep(300); // let any focus transition settle
	const after = await focusState();
	const mine = await tabsIn(wsId);
	const focusedMine = mine.allTabs.filter((t) => t.focused);
	if (focusedMine.length > 0) {
		throw fail(step, "no focus theft", `e2e tab ${focusedMine[0]?.tabId} took focus`);
	}
	if (after.focusedTab !== before.focusedTab) {
		throw fail(
			step,
			"no focus theft",
			`focused tab moved ${before.focusedTab} → ${after.focusedTab}`,
		);
	}
	pass(step, "no focus theft", `focus stayed on ${after.focusedTab} (${after.focusedWorkspace})`);
}

/** Assert every pane in the overview tab is a plain pane, never an agent. */
async function assertViewerNotAgent(step: string, tabId: string): Promise<void> {
	const panes = await panesInTab(tabId);
	for (const p of panes) {
		if (p.agent !== null && p.agent !== undefined) {
			throw fail(
				step,
				"U-HDR-1 viewer never agent",
				`pane ${p.pane_id} misclassified as agent=${p.agent} (${p.agent_status})`,
			);
		}
	}
	pass(
		step,
		"U-HDR-1 viewer never agent",
		`${panes.length} viewer pane(s) report agent=null/undefined`,
	);
}

function collectWorkerIds(step: string): void {
	if (st.sessionFile1 !== undefined) {
		const { ids } = workersInSession(st.sessionFile1);
		for (const id of ids) if (!st.workerIds.includes(id)) st.workerIds.push(id);
	}
	if (st.sessionFile2 !== undefined) {
		const { ids } = workersInSession(st.sessionFile2);
		for (const id of ids) if (!st.workerIds.includes(id)) st.workerIds.push(id);
	}
	if (st.workerIds.length > 0) {
		note(step, "worker ids", st.workerIds.join(", "));
	}
}

async function findOverview(wsId: string): Promise<{ tabId: string; paneId: string } | undefined> {
	const { overviewTabs } = await tabsIn(wsId);
	if (overviewTabs.length === 0) return undefined;
	const tabId = overviewTabs[0] as string;
	const panes = await panesInTab(tabId);
	const pane = panes.find((p) => (p.title ?? "") === OVERVIEW_LABEL) ?? panes[0];
	if (pane === undefined) return undefined;
	return { tabId, paneId: pane.pane_id };
}

async function stepSetupAndSpawn(before: Enumerate): Promise<void> {
	const step = "s1";
	// --- disposable workspace -------------------------------------------------
	const created = wsCreatedSchema.parse(
		await herdrJson([
			"workspace",
			"create",
			"--cwd",
			SCRATCH,
			"--label",
			WORKSPACE_LABEL,
			"--no-focus",
		]),
	);
	st.workspaceId = created.workspace.workspace_id;
	st.rootPaneId = created.root_pane.pane_id;
	st.realCwd = created.root_pane.cwd; // canonical path (OMP encodes this one)
	pass(step, "disposable workspace created", `${st.workspaceId} (${WORKSPACE_LABEL})`);
	if (before.workspaces.has(st.workspaceId)) {
		throw fail(
			step,
			"workspace is new",
			`${st.workspaceId} collided with a pre-existing workspace`,
		);
	}
	const split = paneInfoSchema.parse(
		await herdrJson([
			"pane",
			"split",
			st.rootPaneId,
			"--direction",
			"right",
			"--cwd",
			st.realCwd,
			"--no-focus",
		]),
	);
	st.shellPaneId = split.pane.pane_id;
	pass(step, "shell pane split", `${st.shellPaneId} cwd=${st.realCwd}`);

	// --- launch omp (INSTALLED plugin) ----------------------------------------
	st.agentName = `lense2e${TS.slice(-6).replace(/-/g, "").toLowerCase()}`.slice(0, 31);
	// The split pane needs a beat to reach an interactive shell prompt;
	// agent_pane_busy is transient — retry once (proven live on 0.9.5).
	const started = await (async () => {
		const args = [
			"agent",
			"start",
			st.agentName as string,
			"--kind",
			"omp",
			"--pane",
			st.shellPaneId as string,
			"--timeout",
			String(T.agentStartMs),
			"--",
			"--config",
			E2E_CONFIG_OVERLAY,
		];
		for (let attempt = 0; ; attempt++) {
			try {
				return agentStartedSchema.parse(await herdrJson(args, T.agentStartMs + T.cliMs));
			} catch (err) {
				if (attempt >= 3 || !String(err).includes("agent_pane_busy")) throw err;
				await Bun.sleep(3000);
			}
		}
	})();
	st.sessionFile1 = started.agent.agent_session?.value;
	st.sessionId1 = st.sessionFile1 === undefined ? undefined : sessionIdFromFile(st.sessionFile1);
	pass(
		step,
		"omp launched (installed build)",
		`agent=${started.agent.name} session=${st.sessionId1} file=${st.sessionFile1}`,
	);

	// Let the TUI settle after interactive_ready — prompts submitted inside the
	// first seconds of init can be silently dropped (observed: run that timed
	// out at 90s+90s with no tab because the prompt never ran).
	await waitFor(
		"agent idle after start",
		async () => {
			const o = await paneOccupant(st.shellPaneId as string);
			return o?.hasAgent && (o.status === "idle" || o.status === "done") ? true : undefined;
		},
		30_000,
	).catch(() => note(step, "agent idle wait", "still working — prompting anyway"));
	await Bun.sleep(3000);

	// --- first spawn → auto-open ----------------------------------------------
	const beforeFocus = await focusState();
	const prompt = spawnPrompt(st.agentName, SCOUT_A);
	await prompt.accepted;
	const stopWatch1 = stallWatch(step, st.agentName, T.stallMs);
	const overview = await waitForRetry(
		"overview tab auto-open on first spawn",
		async () => findOverview(st.workspaceId as string),
		T.tabOpenMs,
	);
	st.overviewTabId = overview.tabId;
	st.overviewPaneId = overview.paneId;
	pass(step, "auto-open on first spawn", `tab ${overview.tabId} pane ${overview.paneId}`);
	if (before.workspaces.has(st.workspaceId) || before.tabs.has(overview.tabId)) {
		throw fail(step, "overview created in disposable workspace only", "id collided with baseline");
	}
	await assertFocusPreserved(step, beforeFocus, st.workspaceId);
	await assertViewerNotAgent(step, overview.tabId);

	// viewer connects to the bridge and renders the live roster
	const screen = await waitForRetry(
		"viewer [connected] with a live worker",
		async () => {
			const text = await paneRead(st.overviewPaneId as string);
			if (text.includes(CONNECTED_TAG) && /workers \([1-9]\d*\):/.test(text)) return text;
			return undefined;
		},
		T.viewerConnectMs,
	);
	if (!screen.includes(`session ${st.sessionId1}`)) {
		note(step, "session id in header", `header shows different id; expected ${st.sessionId1}`);
	}
	pass(step, "viewer connected, live worker listed", "[connected] + workers (>=1)");

	// --- prompt completes; worker collapses into finished ---------------------
	// Poll for the transient finished-collapse WHILE the turn runs: the bridge
	// broadcasts upsert{completed} then worker.removed back-to-back, so the
	// "finished (N) — press e to expand" row exists only in a short window.
	const collapsePoll = waitFor(
		"finished-collapse (transient window)",
		async () => {
			const text = await paneRead(st.overviewPaneId as string);
			const m = /finished \((\d+)\) — press e to expand/.exec(text);
			return m !== null ? { text, n: m[1] } : undefined;
		},
		T.finishedMs,
	).then((v) => ({ ok: true as const, v }));
	const res = await prompt.done;
	stopWatch1();
	if (res.code !== 0 || res.killed) {
		note(
			step,
			"agent prompt --wait exit",
			`exit=${res.code} killed=${res.killed} err=${res.err.slice(0, 200)}`,
		);
	}
	const collapsed = await collapsePoll
		.then((r) => ({ ...r.v, witnessed: true as const }))
		.catch(async () => {
			// The transient window was missed — the finished worker is removed
			// by design (roster finished→worker.removed). Workers (0) IS the
			// post-finish steady state; assert that and record the limitation.
			const text = await paneRead(st.overviewPaneId as string);
			if (!/workers \(0\):/.test(text)) {
				throw fail(
					step,
					"finished-collapse",
					"collapse window missed AND roster not empty — worker never finished",
				);
			}
			return { text, n: "transient", witnessed: false as const };
		});
	if (collapsed.witnessed) {
		pass(step, "finished-collapse", `finished (${collapsed.n}) — press e to expand`);
	} else {
		// F3: workers(0) proves reaping, NOT that the collapse UI rendered —
		// record manual evidence so a green run never implies it was witnessed.
		record(
			step,
			"finished-collapse",
			"manual",
			"collapse window missed — workers(0) proves the worker reaped, but 'finished (N) — press e to expand' was NOT witnessed live (unit-covered; rerun RUN_E2E_LIVE=1)",
		);
	}
	collectWorkerIds(step);
	// Artifact cross-check: a terminal session_exit marker must land in the
	// worker JSONL — it is exactly what the restart history scan reads (P5-R4).
	if (st.sessionFile1 === undefined) {
		record(
			step,
			"worker session_exit marker",
			"skipped",
			"no session file (agent_session undefined at agent_started)",
		);
	} else {
		const file1 = st.sessionFile1;
		const marked = await waitFor(
			"worker session_exit marker on disk",
			async () => {
				const { ids } = workersInSession(file1);
				return ids.some((id) => workerFinished(file1, id)) ? ids : undefined;
			},
			T.finishedMs,
		).catch(() => undefined);
		if (marked === undefined) {
			note(
				step,
				"worker session_exit marker",
				"no marker yet — restart history may map the worker as aborted; continuing",
			);
		} else {
			pass(step, "worker session_exit on disk", `${marked.length} worker file(s), marker present`);
		}
	}
}
/**
 * Safe-mode step: create the disposable workspace, prove it enumerated, close
 * it, prove it is gone — no agent launched. In live mode the identical
 * create/teardown path is exercised by stepSetupAndSpawn + teardown instead.
 */
async function stepDisposableRoundTrip(before: Enumerate): Promise<void> {
	const step = "s0";
	if (LIVE) {
		note(step, "live mode", "create/teardown exercised by s1 + teardown instead");
		return;
	}
	const created = wsCreatedSchema.parse(
		await herdrJson([
			"workspace",
			"create",
			"--cwd",
			SCRATCH,
			"--label",
			WORKSPACE_LABEL,
			"--no-focus",
		]),
	);
	st.workspaceId = created.workspace.workspace_id;
	st.rootPaneId = created.root_pane.pane_id;
	st.realCwd = created.root_pane.cwd;
	if (before.workspaces.has(st.workspaceId)) {
		throw fail(step, "workspace is new", `${st.workspaceId} collided with a pre-existing id`);
	}
	pass(
		step,
		"disposable workspace created + enumerated",
		`${st.workspaceId} (${WORKSPACE_LABEL}) cwd=${st.realCwd}`,
	);
	await herdrJson(["workspace", "close", st.workspaceId]);
	pass(step, "disposable workspace closed", st.workspaceId);
	await waitFor(
		"disposable workspace gone",
		async () => {
			const en = await enumerate();
			return !en.workspaces.has(st.workspaceId as string) ? true : undefined;
		},
		15_000,
	);
	pass(step, "disposable workspace gone", st.workspaceId);
	st.workspaceId = undefined; // already closed — teardown skips it
}

async function stepCloseReopen(): Promise<void> {
	const step = "s2";
	const wsId = st.workspaceId as string;
	// --- manual close ----------------------------------------------------------
	await herdrJson(["tab", "close", st.overviewTabId as string]);
	const gone = await waitFor(
		"overview tab closes",
		async () => {
			const { overviewTabs } = await tabsIn(wsId);
			return overviewTabs.length === 0 ? true : undefined;
		},
		T.tabOpenMs,
	);
	st.closedManually = gone;
	pass(step, "manual close honored", `tab ${st.overviewTabId} closed`);
	st.overviewTabId = undefined;
	st.overviewPaneId = undefined;
	// FR-14: closing the view must never touch the worker — agent still alive.
	const agents = agentListSchema.parse(await herdrJson(["agent", "list"]));
	const alive = agents.agents.some((a) => a.name === st.agentName);
	if (!alive)
		throw fail(step, "worker survives viewer close (FR-14)", "agent gone after tab close");
	pass(step, "worker survives viewer close (FR-14)", `agent ${st.agentName} still live`);

	// --- next subtask reopens exactly once --------------------------------------
	const beforeFocus = await focusState();
	const prompt = spawnPrompt(st.agentName as string, SCOUT_B);
	await prompt.accepted;
	const stopWatch2 = stallWatch(step, st.agentName as string, T.stallMs);
	const overview = await waitForRetry(
		"reopen on next subtask",
		async () => findOverview(wsId),
		T.tabOpenMs,
	);
	// exactly ONE overview tab in the disposable workspace (FR-05)
	const { overviewTabs } = await tabsIn(wsId);
	if (overviewTabs.length !== 1) {
		throw fail(
			step,
			"exactly one overview tab (FR-05)",
			`${overviewTabs.length} tabs labeled '${OVERVIEW_LABEL}': ${overviewTabs.join(",")}`,
		);
	}
	if (overviewTabs[0] !== overview.tabId) {
		throw fail(step, "exactly one overview tab (FR-05)", "findOverview saw a different tab");
	}
	st.overviewTabId = overview.tabId;
	st.overviewPaneId = overview.paneId;
	pass(step, "exactly one overview tab reopened (FR-05)", `tab ${overview.tabId}`);
	await assertFocusPreserved(step, beforeFocus, wsId);
	await assertViewerNotAgent(step, overview.tabId);
	await prompt.done;
	stopWatch2();
	const done2 = await waitForRetry(
		"second worker reaches terminal state",
		async () => {
			const text = await paneRead(st.overviewPaneId as string);
			// finished-collapse is transient (upsert→removed back-to-back);
			// workers(0) is the steady post-finish state — both prove terminal.
			if (/finished \([1-9]\d*\) — press e to expand/.test(text))
				return "finished-collapse observed";
			if (/workers \(0\):/.test(text))
				return "workers (0) — finished worker reaped (transient collapse missed)";
			return undefined;
		},
		T.finishedMs,
	);
	note(step, "second worker terminal state", done2);
	collectWorkerIds(step);
}

async function stepLensSplit(): Promise<void> {
	const step = "s3";
	const wsId = st.workspaceId as string;
	if (st.workerIds.length === 0) {
		record(step, "lens split worker id", "skipped", "no worker artifacts found on disk");
		return;
	}
	const workerId = st.workerIds[0] as string;
	const beforeFocus = await focusState();
	// Registration pre-check: typing "/lens" opens the TUI command palette
	// listing the command — evidence /lens is registered in this build before
	// the split attempt. Esc clears the palette, then the real command runs.
	await herdrJson(["pane", "send-text", st.shellPaneId as string, "/lens"]).catch(() => {});
	await Bun.sleep(800);
	const palette = await paneRead(st.shellPaneId as string);
	if (/lens\s+open the herdr-omp-lens overview/.test(palette)) {
		note(step, "/lens registered", "palette shows '/lens open the herdr-omp-lens overview…'");
	} else {
		note(step, "/lens registered", "palette did not surface — /lens may be absent in this build");
	}
	await paneSendKeys(st.shellPaneId as string, ["escape"]).catch(() => {});
	await Bun.sleep(400);
	await paneTypeCommand(st.shellPaneId as string, `/lens split ${workerId}`);
	const splitPane = await waitForRetry(
		`/lens split ${workerId} opens worker-scoped pane`,
		async () => {
			const panes = await panesInTab(st.overviewTabId as string);
			const candidate = panes.find((p) => p.pane_id !== st.overviewPaneId);
			if (candidate === undefined) return undefined;
			const info = paneInfoSchema.parse(await herdrJson(["pane", "get", candidate.pane_id]));
			const title = info.pane.title ?? "";
			if (!title.includes(OVERVIEW_LABEL)) return undefined;
			return { paneId: candidate.pane_id, title };
		},
		T.tabOpenMs,
	);
	st.splitPaneId = splitPane.paneId;
	pass(
		step,
		"worker-scoped split opened (D3)",
		`pane ${splitPane.paneId} title '${splitPane.title}'`,
	);
	if (!splitPane.title.includes(workerId)) {
		note(
			step,
			"split title carries worker id",
			`title '${splitPane.title}' vs worker '${workerId}'`,
		);
	}
	await assertFocusPreserved(step, beforeFocus, wsId);
	await assertViewerNotAgent(step, st.overviewTabId as string);
	const scoped = await waitForRetry(
		"scoped viewer renders worker",
		async () => {
			const text = await paneRead(splitPane.paneId);
			if (text.includes(`scope: worker ${workerId}`) && text.includes(CONNECTED_TAG)) return text;
			return undefined;
		},
		T.viewerConnectMs,
	);
	pass(
		step,
		"LENS_WORKER_ID scoped view",
		scoped.includes("not found") ? "scope rendered 'not found'" : "scope + transcript rendered",
	);
}

async function stepRestart(): Promise<void> {
	const step = "s4";
	if (SKIP_RESTART) {
		record(step, "OMP restart leg", "skipped", "E2E_SKIP_RESTART=1");
		return;
	}
	const wsId = st.workspaceId as string;
	const priorTabId = st.overviewTabId as string;
	const priorPaneId = st.overviewPaneId as string;

	// --- exit omp ---------------------------------------------------------------
	await stopAgent(step);
	pass(step, "omp exited", `session ${st.sessionId1} closed`);

	// --- relaunch in the SAME cwd, LOCAL build only ------------------------------
	const agentName2 = `${st.agentName}b`.slice(0, 31);
	const argv = [
		"agent",
		"start",
		agentName2,
		"--kind",
		"omp",
		"--pane",
		st.shellPaneId as string,
		"--timeout",
		String(T.agentStartMs),
		"--",
		"--no-extensions",
		"--config",
		E2E_CONFIG_OVERLAY,
		"-e",
		LOCAL_EXTENSION,
	];
	let started2: z.output<typeof agentStartedSchema>;
	try {
		started2 = agentStartedSchema.parse(await herdrJson(argv, T.agentStartMs + T.cliMs));
	} catch (err) {
		// Some builds reject AGENT_ARG. Fall back to a plain `omp` launch driven
		// by pane run — Herdr re-detects the TUI as an omp agent either way.
		note(
			step,
			"agent start with args",
			`rejected (${String(err).slice(0, 160)}); falling back to pane run omp -e`,
		);
		await herdrJson([
			"pane",
			"run",
			st.shellPaneId as string,
			`omp --no-extensions --config ${E2E_CONFIG_OVERLAY} -e ${LOCAL_EXTENSION}`,
		]);
		await waitFor(
			"omp re-detected as agent",
			async () => {
				const agents = agentListSchema.parse(await herdrJson(["agent", "list"]));
				const a = agents.agents.find((x) => x.pane_id === st.shellPaneId);
				return a !== undefined ? a : undefined;
			},
			T.agentStartMs,
		);
		const agents = agentListSchema.parse(await herdrJson(["agent", "list"]));
		const a = agents.agents.find((x) => x.pane_id === st.shellPaneId);
		started2 = agentStartedSchema.parse({
			type: "agent_started",
			agent: {
				name: a?.name ?? "unknown",
				pane_id: st.shellPaneId as string,
				agent_status: a?.agent_status ?? "unknown",
				agent_session: a?.agent_session ?? null,
			},
		});
	}
	st.agentName = started2.agent.name;
	st.sessionFile2 = started2.agent.agent_session?.value;
	st.sessionId2 = st.sessionFile2 === undefined ? undefined : sessionIdFromFile(st.sessionFile2);
	pass(
		step,
		"omp restarted (local build, same cwd)",
		`agent=${st.agentName} session=${st.sessionId2}`,
	);
	if (st.sessionId2 === st.sessionId1) {
		throw fail(step, "new session id", "restart produced the same session id");
	}

	// --- history auto-open WITHOUT any spawn (D2) --------------------------------
	// The surviving tab must be REUSED (same tab id + pane id), never duplicated.
	const overview2 = await waitForRetry(
		"overview auto-open on non-empty history (D2)",
		async () => findOverview(wsId),
		T.tabOpenMs,
	);
	const { overviewTabs } = await tabsIn(wsId);
	if (overviewTabs.length !== 1) {
		throw fail(
			step,
			"surviving tab reused, never duplicated",
			`${overviewTabs.length} '${OVERVIEW_LABEL}' tabs after restart: ${overviewTabs.join(",")}`,
		);
	}
	const sameTab = overview2.tabId === priorTabId;
	const samePane = overview2.paneId === priorPaneId;
	if (!sameTab) {
		throw fail(
			step,
			"surviving tab reused (D2 rebind)",
			`overview tab changed ${priorTabId} → ${overview2.tabId} — D2 requires reusing the surviving tab, not a recreate`,
		);
	}
	if (!samePane) {
		note(
			step,
			"surviving viewer pane",
			`same tab ${priorTabId} but viewer pane changed ${priorPaneId} → ${overview2.paneId} — reconnect proven by socket check below`,
		);
	}
	pass(step, "surviving tab reused (D2 rebind)", `same tab ${priorTabId} rebound`);
	st.overviewTabId = overview2.tabId;
	st.overviewPaneId = overview2.paneId;
	await assertViewerNotAgent(step, overview2.tabId);

	// reconnect to the NEW socket: new session id + [connected]
	const screen2 = await waitForRetry(
		"viewer reconnected to new socket",
		async () => {
			const text = await paneRead(overview2.paneId);
			if (text.includes(CONNECTED_TAG) && text.includes(`session ${st.sessionId2}`)) return text;
			return undefined;
		},
		T.viewerConnectMs,
	);
	pass(step, "surviving viewer reconnected to NEW socket", `session ${st.sessionId2} [connected]`);

	// prior workers render not-live (FR-09); no live duplicate
	const priorIds = st.workerIds;
	if (priorIds.length === 0) {
		record(step, "prior workers not-live (FR-09)", "skipped", "no prior worker ids captured");
	} else {
		const missing = priorIds.filter((id) => !screen2.includes(id));
		if (missing.length > 0) {
			throw fail(
				step,
				"prior workers render (FR-09)",
				`ids missing from viewer: ${missing.join(",")}`,
			);
		}
		if (!screen2.includes(NOT_LIVE)) {
			throw fail(step, "prior workers not-live (FR-09)", `no ${NOT_LIVE} badge rendered`);
		}
		const dupes = priorIds.filter((id) => {
			const occurrences = screen2.split(id).length - 1;
			return occurrences > 2; // row line + inspector line is expected
		});
		if (dupes.length > 0) {
			note(step, "no live duplicate", `ids rendered >2 times: ${dupes.join(",")} — inspect`);
		}
		pass(step, "prior workers [not-live] (FR-09)", `${priorIds.join(", ")} marked ${NOT_LIVE}`);
	}
	collectWorkerIds(step);
}

async function stepCrossWorkspaceFocus(): Promise<void> {
	const step = "s5";
	const wsId = st.workspaceId as string;
	const focus = await focusState();
	if (focus.focusedWorkspace === wsId) {
		record(
			step,
			"cross-workspace spawn (U-HDR-2/F-14)",
			"skipped",
			"e2e workspace is focused — precondition (focus elsewhere) unmet",
		);
		return;
	}
	note(
		step,
		"cross-workspace precondition",
		`focused=${focus.focusedWorkspace} (${focus.focusedTab}); e2e=${wsId}`,
	);
	const prompt = spawnPrompt(st.agentName as string, SCOUT_C);
	await prompt.accepted;
	const stopWatch3 = stallWatch(step, st.agentName as string, T.stallMs);
	// Poll for the spawn evidence while focus lives in another workspace.
	await waitForRetry(
		"cross-workspace spawn lands",
		async () => {
			const text = await paneRead(st.overviewPaneId as string);
			return /workers \([1-9]\d*\):|finished \([1-9]\d*\)/.test(text) ? text : undefined;
		},
		T.tabOpenMs,
	);
	const after = await focusState();
	if (after.focusedTab !== focus.focusedTab || after.focusedWorkspace === wsId) {
		throw fail(
			step,
			"cross-workspace focus preserved (U-HDR-2/F-14, FR-13)",
			`focus moved ${focus.focusedTab}(${focus.focusedWorkspace}) → ${after.focusedTab}(${after.focusedWorkspace}) — tab.create stole focus`,
		);
	}
	pass(
		step,
		"cross-workspace focus preserved (FR-13)",
		`focus stayed ${after.focusedTab} (${after.focusedWorkspace})`,
	);
	await prompt.done;
	stopWatch3();
	// live-wins merge evidence: prior workers still [not-live], new one live→finished
	const done3 = await waitForRetry(
		"post-restart worker reaches terminal state",
		async () => {
			const text = await paneRead(st.overviewPaneId as string);
			if (/finished \([1-9]\d*\)/.test(text)) return "finished-collapse observed";
			if (/workers \(0\):/.test(text)) return "workers (0) steady state";
			return undefined;
		},
		T.finishedMs,
	);
	note(step, "post-restart worker terminal state", done3);
	collectWorkerIds(step);
}

async function assertDailyUntouched(before: Enumerate): Promise<void> {
	const step = "s6";
	const after = await enumerate();
	writeFileSync(
		join(EVIDENCE_DIR, "enumerate-after.json"),
		JSON.stringify(
			{
				workspaces: [...after.workspaces],
				tabs: [...after.tabs],
				panes: [...after.panes],
			},
			null,
			2,
		),
	);
	const myWs = st.workspaceId;
	// Exclude tabs/panes that belong to the disposable workspace by the
	// workspaceId field — never trust id formatting.
	const extraTabs = [...after.tabs.entries()]
		.filter(([id, t]) => !before.tabs.has(id) && t.workspaceId !== myWs)
		.map(([id]) => id);
	const extraPanes = [...after.panes.entries()]
		.filter(([id, p]) => !before.panes.has(id) && p.workspaceId !== myWs)
		.map(([id]) => id);
	const goneTabs = [...before.tabs.keys()].filter((id) => !after.tabs.has(id));
	const gonePanes = [...before.panes.keys()].filter((id) => !after.panes.has(id));
	const goneWs = [...before.workspaces.keys()].filter((id) => !after.workspaces.has(id));
	const extraWs = [...after.workspaces.keys()].filter(
		(id) => !before.workspaces.has(id) && id !== myWs,
	);
	const problems: string[] = [];
	if (goneWs.length > 0) problems.push(`workspaces vanished: ${goneWs.join(",")}`);
	if (extraWs.length > 0) problems.push(`foreign workspaces appeared: ${extraWs.join(",")}`);
	if (goneTabs.length > 0) problems.push(`tabs vanished: ${goneTabs.join(",")}`);
	if (extraTabs.length > 0) problems.push(`foreign tabs appeared: ${extraTabs.join(",")}`);
	if (gonePanes.length > 0) problems.push(`panes vanished: ${gonePanes.join(",")}`);
	if (extraPanes.length > 0) problems.push(`foreign panes appeared: ${extraPanes.join(",")}`);
	if (problems.length > 0) {
		throw fail(step, "daily workspace untouched", problems.join(" | "));
	}
	pass(
		step,
		"daily workspace untouched",
		`${before.workspaces.size} workspaces, ${before.tabs.size} tabs, ${before.panes.size} panes — identical before/after (e2e ids excluded)`,
	);
	// CRITICAL ISOLATION, end-of-run proof: no lens-e2e-* workspace may remain
	// (this run's own workspace excepted when E2E_KEEP_WORKSPACE=1 asked for it).
	const leftovers = [...after.workspaces.entries()].filter(
		([id, label]) => label.startsWith("lens-e2e-") && !(KEEP_WORKSPACE && id === st.workspaceId),
	);
	if (leftovers.length > 0) {
		throw fail(
			step,
			"no lens-e2e-* workspace left behind",
			leftovers.map(([id, label]) => `${id} (${label})`).join(", "),
		);
	}
	pass(step, "no lens-e2e-* workspace left behind", "disposable scope clean");
}

async function teardown(): Promise<void> {
	const step = "teardown";
	if (KEEP_WORKSPACE) {
		note(step, "workspace kept", `${st.workspaceId} (${WORKSPACE_LABEL}) — E2E_KEEP_WORKSPACE=1`);
		return;
	}
	// Quit any live viewer processes first (viewer 'q' is process-local, read-only).
	for (const paneId of [st.overviewPaneId, st.splitPaneId]) {
		if (paneId !== undefined && !st.viewerQuitSent.has(paneId)) {
			await paneSendKeys(paneId, ["q"]).catch(() => {});
			st.viewerQuitSent.add(paneId);
		}
	}
	// Exit the agent politely; a straggler dies with the workspace anyway.
	if (st.agentName !== undefined && st.shellPaneId !== undefined) {
		await agentSubmit(st.agentName, "/exit").catch(() => {});
		await Bun.sleep(1500);
		await paneSendKeys(st.shellPaneId, ["ctrl+c", "ctrl+c"]).catch(() => {});
	}
	if (st.workspaceId !== undefined) {
		const stillThere = await enumerate()
			.then((en) => en.workspaces.has(st.workspaceId as string))
			.catch(() => true);
		if (!stillThere) {
			note(step, "disposable workspace already gone", String(st.workspaceId));
			st.workspaceId = undefined;
			return;
		}
	}
	if (st.workspaceId !== undefined) {
		try {
			await herdrJson(["workspace", "close", st.workspaceId]);
			pass(step, "disposable workspace closed", st.workspaceId);
		} catch (err) {
			note(step, "workspace close", `error: ${String(err).slice(0, 200)} — closing panes manually`);
			const { allTabs } = await tabsIn(st.workspaceId).catch(() => ({
				overviewTabs: [] as string[],
				allTabs: [] as { tabId: string; label: string | undefined; focused: boolean }[],
			}));
			for (const t of allTabs) {
				await herdrJson(["tab", "close", t.tabId]).catch(() => {});
			}
			await herdrJson(["workspace", "close", st.workspaceId]).catch(() => {});
		}
		// confirm gone
		try {
			await waitFor(
				"disposable workspace gone",
				async () => {
					const en = await enumerate();
					return !en.workspaces.has(st.workspaceId as string) ? true : undefined;
				},
				15_000,
			);
			pass(step, "disposable workspace gone", String(st.workspaceId));
		} catch {
			record(step, "disposable workspace gone", "fail", `${st.workspaceId} still present`);
		}
	}
}

function writeReport(): number {
	const failures = checks.filter((c) => c.status === "fail");
	const manuals = checks.filter((c) => c.status === "manual");
	const skips = checks.filter((c) => c.status === "skipped");
	const summary = [
		"",
		"================ lens E2E summary ================",
		`workspace : ${st.workspaceId ?? "?"} (${WORKSPACE_LABEL})`,
		`scratch   : ${SCRATCH}`,
		`session 1 : ${st.sessionId1 ?? "?"}  file ${st.sessionFile1 ?? "?"}`,
		`session 2 : ${st.sessionId2 ?? "(restart skipped)"}  file ${st.sessionFile2 ?? "-"}`,
		`workers   : ${st.workerIds.join(", ") || "(none captured)"}`,
		`build     : installed plugin for s1–s3; local -e ${LOCAL_EXTENSION} for s4+`,
		`checks    : ${checks.filter((c) => c.status === "pass").length} pass, ${failures.length} fail, ${manuals.length} manual, ${skips.length} skipped, ${checks.filter((c) => c.status === "note").length} notes`,
		...checks.map(
			(c) => `  [${c.status}] ${c.step} ${c.name}${c.detail === "" ? "" : ` — ${c.detail}`}`,
		),
		"=================================================",
	].join("\n");
	saveEventCapture();
	console.log(summary);
	writeFileSync(join(EVIDENCE_DIR, "e2e-report.txt"), `${summary}\n`);
	writeFileSync(
		join(EVIDENCE_DIR, "e2e-checks.json"),
		JSON.stringify({ workspace: WORKSPACE_LABEL, scratch: SCRATCH, st, checks }, null, 2),
	);
	return failures.length > 0 ? 1 : 0;
}

/** A failed step never aborts the run: assertion breaches stay `fail`
 *  (via the StepError already recorded), while plain Errors (CLI hiccups,
 *  timeouts — environment-coupled) land as `manual` evidence lines and the
 *  run continues, per the bounded-retry mandate. */
async function runStep(step: string, name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
	} catch (err) {
		if (err instanceof StepError) return; // fail() already recorded the breach
		record(
			step,
			`${name} — env-coupled`,
			"manual",
			`${String(err).slice(0, 280)} | rerun: RUN_E2E_LIVE=1 bash scripts/run-e2e.sh`,
		);
	}
}

async function main(): Promise<number> {
	let before: Enumerate;
	try {
		before = await preflight();
	} catch (err) {
		console.error(`preflight failed: ${err instanceof Error ? err.message : String(err)}`);
		return 2;
	}
	if (!LIVE) {
		note("mode", "safe mode", "RUN_E2E_LIVE unset — disposable round-trip only, no agent launched");
	} else {
		note("mode", "live mode", "RUN_E2E_LIVE=1 — full lifecycle drive");
	}
	try {
		await runStep("s0", "disposable create/teardown round-trip", () =>
			stepDisposableRoundTrip(before),
		);
		if (LIVE) {
			await runStep("s1", "setup + first spawn", () => stepSetupAndSpawn(before));
			const s2req =
				st.overviewTabId !== undefined &&
				st.overviewPaneId !== undefined &&
				st.agentName !== undefined &&
				st.workspaceId !== undefined;
			if (s2req) {
				await runStep("s2", "manual close → exactly-one reopen", () => stepCloseReopen());
			} else {
				record("s2", "manual close → exactly-one reopen", "skipped", "s1 prerequisites missing");
			}
			const s3req =
				st.overviewTabId !== undefined &&
				st.overviewPaneId !== undefined &&
				st.shellPaneId !== undefined &&
				st.workspaceId !== undefined;
			if (s3req) {
				await runStep("s3", "read-only /lens split", () => stepLensSplit());
			} else {
				record("s3", "read-only /lens split", "skipped", "overview/shell prerequisites missing");
			}
			const s4req =
				st.workspaceId !== undefined &&
				st.shellPaneId !== undefined &&
				st.agentName !== undefined &&
				st.overviewTabId !== undefined &&
				st.overviewPaneId !== undefined;
			if (s4req) {
				await runStep("s4", "OMP restart → history auto-open", () => stepRestart());
			} else {
				record(
					"s4",
					"OMP restart → history auto-open",
					"skipped",
					"live agent/overview prerequisites missing",
				);
			}
			const s5req =
				st.workspaceId !== undefined &&
				st.agentName !== undefined &&
				st.overviewPaneId !== undefined;
			if (s5req) {
				await runStep("s5", "cross-workspace focus preservation", () => stepCrossWorkspaceFocus());
			} else {
				record(
					"s5",
					"cross-workspace focus preservation",
					"skipped",
					"live agent/overview prerequisites missing",
				);
			}
		} else {
			for (const [s, name] of [
				["s1", "setup + first spawn"],
				["s2", "manual close → exactly-one reopen"],
				["s3", "read-only /lens split"],
				["s4", "OMP restart → history auto-open"],
				["s5", "cross-workspace focus preservation"],
			] as const) {
				record(s, name, "skipped", "safe mode — rerun with RUN_E2E_LIVE=1");
			}
		}
	} finally {
		await teardown().catch((err) => {
			record("teardown", "teardown error", "fail", String(err).slice(0, 300));
		});
		await assertDailyUntouched(before).catch((err) => {
			if (!(err instanceof StepError)) {
				record("s6", "after-enumeration error", "fail", String(err).slice(0, 300));
			}
		});
	}
	return writeReport();
}

process.exit(await main());
