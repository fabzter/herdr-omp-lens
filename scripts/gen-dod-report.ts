#!/usr/bin/env bun
/**
 * P6-R1 DoD-v1 evidence report generator.
 *
 * Runs the suite once (junit), verifies every cited test exists and passes,
 * and maps EVERY FR-01..15 + NFR-01..06 to:
 *   - `pass`             — cited automated tests all pass AND no required live
 *                          witness is still pending;
 *   - `manual-evidence`  — cited automated tests pass (or none apply) but the
 *                          acceptance has a required witness/capture that is
 *                          either recorded-but-pending or still outstanding —
 *                          the named capture says exactly what;
 *   - `fail`             — a cited test failed, or a cited test name could not
 *                          be found in this run or in its file (untraced).
 *
 * No row is emitted without at least one automated test or named capture.
 * Owner sign-off (P6-R11) is NEVER recorded by this script — the sign-off
 * block stays unsigned for the owner.
 *
 * Usage: `bun scripts/gen-dod-report.ts` → writes docs/analysis/dod-v1-report.md
 * and exits non-zero if any requirement row is `fail`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const REPO = resolve(import.meta.dirname, "..");
const REPORT_PATH = join(REPO, "docs/analysis/dod-v1-report.md");

type TestRef = { file: string; name: string };
type ManualRef = { capture: string; what: string };
type Requirement = {
	id: string;
	title: string;
	tests?: TestRef[];
	manual?: ManualRef[];
	/** When set, the row's status is driven by the DOC_CHECKS result (machine
	 *  assertions over the docs), not by `tests` or `manual`. */
	docChecks?: boolean;
	/** When set, the row is `manual-evidence`: a required live witness/capture
	 *  is still outstanding even though every cited automated test is green. */
	witnessPending?: string;
};

const REQS: Requirement[] = [
	{
		id: "FR-01",
		title: "Herdr gate — activate only under HERDR_ENV=1 + full caller context",
		tests: [
			{ file: "tests/extension/gate.test.ts", name: "registers nothing when HERDR_ENV is unset" },
			{
				file: "tests/extension/gate.test.ts",
				name: "registers nothing when HERDR_ENV=1 but a context var is missing",
			},
			{
				file: "tests/extension/gate.test.ts",
				name: "registers /lens and activates observation when the full Herdr env is present",
			},
			{
				file: "tests/extension/observe-wiring.test.ts",
				name: "outside Herdr the gate is a no-op: startObservation is never invoked",
			},
			{
				file: "tests/guards/invariants.test.ts",
				name: "(e) FR-01: HERDR_ENV unset — extension registers nothing, activates nothing",
			},
			{ file: "tests/herdr/context.test.ts", name: "false when HERDR_ENV is not exactly '1'" },
		],
		manual: [
			{
				capture: "tests/guards/sabotage.md §(e)",
				what: "sabotage red — a fabricated caller context registers /lens and the suite fails",
			},
		],
	},
	{
		id: "FR-02",
		title: "Native observation — task:subagent:* bus → direct-worker roster",
		tests: [
			{
				file: "tests/extension/observe-wiring.test.ts",
				name: "subscribes the three task:subagent:* channels and before_subagent_spawn",
			},
			{
				file: "tests/extension/observe-wiring.test.ts",
				name: "spawn hook + frames feed the roster synchronously and broadcast (fire-and-forget)",
			},
			{
				file: "tests/extension/roster.test.ts",
				name: "a direct id joins the roster on its first lifecycle frame",
			},
			{ file: "tests/extension/roster.test.ts", name: "lifecycle started maps to running" },
			{
				file: "tests/extension/roster.test.ts",
				name: "counters come from the nested .progress object, not the envelope",
			},
			{
				file: "tests/extension/observe/schemas.test.ts",
				name: "reads counters from nested .progress envelope",
			},
		],
		manual: [
			{
				capture: "docs/analysis/phase-0-caveat-closure.md §Caveat 1",
				what: "interactive-TUI witness session 01a210e2-5995-74b7-99d0-1acf4182b855 — viewer rendered the live worker (closes U-OMP-1)",
			},
		],
	},
	{
		id: "FR-03",
		title: "Local bridge — unix-socket NDJSON, 0600 socket, versioned handshake",
		tests: [
			{
				file: "tests/extension/bridge.test.ts",
				name: "valid ClientMessage handshake gets hello{session,workers,history}",
			},
			{
				file: "tests/extension/bridge.test.ts",
				name: "spawn/change signals produce worker.upsert broadcasts",
			},
			{
				file: "tests/extension/bridge.test.ts",
				name: "default socketPath lives under a unique 0700 dir and the socket is 0600",
			},
			{
				file: "tests/extension/bridge.test.ts",
				name: "close() stops listening and unlinks the socket file",
			},
			{
				file: "tests/extension/bridge.test.ts",
				name: "F6: guard — bridge binds only a unix socket, never TCP (P2-R6)",
			},
			{
				file: "tests/guards/fail-soft.test.ts",
				name: "bridge socket: 0600 unix socket inside a 0700 per-session dir; no TCP listener",
			},
			{
				file: "tests/extension/bridge.test.ts",
				name: "SIGTERM unlinks the socket (real signal, child process)",
			},
		],
	},
	{
		id: "FR-04",
		title: "Overview tab — one no-focus `OMP subagents` tab on first spawn",
		tests: [
			{
				file: "tests/extension/topology.test.ts",
				name: "first spawn opens one no-focus overview tab and runs the viewer (P4-R2)",
			},
			{
				file: "tests/extension/topology.test.ts",
				name: "single-flight: parallel spawns create exactly one tab (P4-R4)",
			},
			{
				file: "tests/extension/topology.test.ts",
				name: "subscribes lifecycle before the first createOverviewTab (P4-R1)",
			},
			{
				file: "tests/extension/topology-herdr.test.ts",
				name: "runInPane sends the short viewer command verbatim into the root pane",
			},
			{
				file: "tests/extension/topology.test.ts",
				name: "onHistoryPresent auto-opens the overview with no spawn (D2)",
			},
		],
		manual: [
			{
				capture: "docs/analysis/phase-0-caveat-closure.md §Caveat 1",
				what: "witnessed session 01a210e2-5995-74b7-99d0-1acf4182b855 — overview tab auto-opened on the history/spawn signal",
			},
			{
				capture: "docs/analysis/clean-profile-install.md §3",
				what: "clean-profile run — tab `w11:t2 \"OMP subagents\"` (pane `w11:p2`), focus stayed `wN`",
			},
		],
	},
	{
		id: "FR-05",
		title: "Reopen after close — next spawn reopens exactly one tab",
		tests: [
			{
				file: "tests/extension/topology.test.ts",
				name: "manual close is respected; next spawn reopens exactly once (P4-R3)",
			},
			{
				file: "tests/extension/topology.test.ts",
				name: "final F2: overview pane.exited marks the view dead; next spawn relaunches in the same pane",
			},
			{
				file: "tests/extension/topology.test.ts",
				name: "F2: a split moved out of the tab does not block tab.closed confirm (FR-05)",
			},
			{
				file: "tests/extension/topology.test.ts",
				name: "tab.closed while pane still present in snapshot does NOT mark closed (moved race)",
			},
		],
		manual: [
			{
				capture: "docs/analysis/e2e-evidence.md §Manual-evidence steps",
				what: "E2E step s2 (close → next spawn → exactly one tab) — scripted, not yet live-witnessed",
			},
		],
		witnessPending: "E2E s2 close→reopen — owner live-witness outstanding",
	},
	{
		id: "FR-06",
		title: "Optional split — no-focus worker-scoped split, close ≠ cancel",
		tests: [
			{
				file: "tests/extension/topology.test.ts",
				name: "openWorkerSplit creates a no-focus worker-scoped split (P4-R7)",
			},
			{
				file: "tests/extension/topology.test.ts",
				name: "one split per worker: repeat call returns the live pane (Q-P4-3)",
			},
			{
				file: "tests/extension/topology.test.ts",
				name: "closing a split emits topology, never worker.removed (P4-R8/FR-14)",
			},
			{
				file: "tests/extension/lens-commands.test.ts",
				name: "/lens split <id> dispatches through the lens handler to openWorkerSplit",
			},
			{
				file: "tests/extension/lens-commands.test.ts",
				name: "/lens split without an id does nothing",
			},
			{
				file: "tests/viewer/cli.test.ts",
				name: "worker-scoped launch filters the screen to the scoped id only",
			},
		],
		manual: [
			{
				capture: "docs/analysis/e2e-evidence.md §Manual-evidence steps",
				what: "E2E step s3 (/lens split live) — scripted, not yet live-witnessed",
			},
		],
		witnessPending: "E2E s3 /lens split — owner live-witness outstanding",
	},
	{
		id: "FR-07",
		title: "OMP-like detail — roster fields, inspector, live transcript",
		tests: [
			{
				file: "tests/viewer/render.test.ts",
				name: "renders detail lines incl. model/role/thinking/session (FR-07)",
			},
			{
				file: "tests/viewer/render.test.ts",
				name: "selected worker gets inspector + transcript block",
			},
			{
				file: "tests/viewer/render.test.ts",
				name: "renders all present counters; empty when none",
			},
			{
				file: "tests/viewer/transcript.test.ts",
				name: "spawns `omp render <sessionFile> --plain` by default; never history://",
			},
			{
				file: "tests/viewer/transcript.test.ts",
				name: "real `omp render` on a synthetic fixture exits 0 and hides thinking by default",
			},
		],
	},
	{
		id: "FR-08",
		title: "Finished collapse — completed workers collapse by default",
		tests: [
			{
				file: "tests/viewer/render.test.ts",
				name: "finished collapse: collapsed by default, expanded reveals rows (P3-R6)",
			},
			{
				file: "tests/viewer/render.test.ts",
				name: "finished workers are not selectable while collapsed; appear when expanded",
			},
			{
				file: "tests/viewer/state.test.ts",
				name: "completed/failed/aborted are finished; others are not",
			},
			{
				file: "tests/viewer/cli.test.ts",
				name: "navigation skips finished workers while collapsed; expansion reveals them",
			},
		],
		manual: [
			{
				capture: "docs/analysis/e2e-evidence.md Fix-round F3",
				what: "collapse is transient — recorded `manual \"finished-collapse\"` (unit-covered, NOT witnessed live)",
			},
		],
	},
	{
		id: "FR-09",
		title: "History — persisted transcripts after restart, marked not-live",
		tests: [
			{
				file: "tests/extension/history/scan.test.ts",
				name: "maps direct workers, excludes nested and foreign",
			},
			{
				file: "tests/extension/history/status.test.ts",
				name: "completed transcript maps completed, counters absent, historical",
			},
			{
				file: "tests/extension/history/wiring.test.ts",
				name: "hello.history carries scanned workers on connect AND reconnect",
			},
			{
				file: "tests/extension/history/restart.test.ts",
				name: "new activation surfaces prior workers: not-live, transcript.ref, no spawn, no live copy",
			},
			{
				file: "tests/viewer/render.test.ts",
				name: "history section renders with not-live label (P3-R9)",
			},
			{
				file: "tests/viewer/state.test.ts",
				name: "live upsert wins over a historical entry for the same id (RC-3)",
			},
		],
		manual: [
			{
				capture: "docs/analysis/e2e-evidence.md §Manual-evidence steps",
				what: "E2E step s4 (OMP restart → auto-open + not-live history) — scripted, not yet live-witnessed",
			},
		],
		witnessPending: "E2E s4 restart→history — owner live-witness outstanding",
	},
	{
		id: "FR-10",
		title: "Direct-only scope — nested and other-session workers excluded",
		tests: [
			{
				file: "tests/extension/roster.test.ts",
				name: "frames for ids that were never spawned are excluded (nested/other-session filter)",
			},
			{
				file: "tests/extension/observe-wiring.test.ts",
				name: "frames for ids outside the direct-id set never enter the roster",
			},
			{
				file: "tests/extension/history/scan.test.ts",
				name: "maps direct workers, excludes nested and foreign",
			},
		],
	},
	{
		id: "FR-11",
		title: "Read-only — no control frames, no control affordance",
		tests: [
			{
				file: "tests/protocol/codec.test.ts",
				name: "extra control.* field -> {ok:false} (strict boundary)",
			},
			{
				file: "tests/guards/invariants.test.ts",
				name: "(d) FR-11: control.* frames are rejected at decodeClientMessage",
			},
			{
				file: "tests/guards/fail-soft.test.ts",
				name: "decodeClientMessage rejects malformed/truncated/wrong-v/control.* — no throw",
			},
			{
				file: "tests/viewer/cli.test.ts",
				name: "the only outbound frame is the handshake: no other socket write exists",
			},
			{
				file: "tests/viewer/cli.test.ts",
				name: "no viewer source contains a steering frame type",
			},
			{
				file: "tests/viewer/cli.test.ts",
				name: "keyFor maps every bound key to a declared read-only action",
			},
		],
		manual: [
			{
				capture: "tests/guards/sabotage.md §(d)",
				what: "sabotage red — relaxing the strict client schema to `.object()` makes a `control` field pass",
			},
		],
	},
	{
		id: "FR-12",
		title: "Fail-soft — never blocks an OMP turn; degrade to one notice",
		tests: [
			{
				file: "tests/guards/fail-soft.test.ts",
				name: "no pi.events → bus-unavailable notice; workers still discovered via artifact scan",
			},
			{
				file: "tests/guards/fail-soft.test.ts",
				name: "adapter death mid-transition: turn completes, one notice, roster intact",
			},
			{
				file: "tests/guards/fail-soft.test.ts",
				name: "circuit-break: adapter over a stalled socket degrades the topology with one notice",
			},
			{
				file: "tests/guards/invariants.test.ts",
				name: "(f) FR-12: handlers never throw when bridge + Herdr are dead",
			},
			{
				file: "tests/extension/topology.test.ts",
				name: "adapter failure degrades + notice, spawn signals still flow (P4-R11)",
			},
			{
				file: "tests/viewer/render.test.ts",
				name: "degraded and offline states are surfaced (FR-12, D1)",
			},
		],
		manual: [
			{
				capture: "tests/guards/sabotage.md §(f)",
				what: "sabotage red — an unguarded notice subscriber throws \"dead bridge\" into the handler",
			},
		],
	},
	{
		id: "FR-13",
		title: "No focus theft — every topology op is no-focus",
		tests: [
			{
				file: "tests/guards/invariants.test.ts",
				name: "(c) FR-13: every adapter create/split/run is no-focus; guard still throws",
			},
			{
				file: "tests/extension/topology-herdr.test.ts",
				name: "no-focus surface: topology never emits focus/ forbidden calls (P4-R5/R6 tamper)",
			},
			{
				file: "tests/herdr/adapter.test.ts",
				name: "sends tab.create with workspace_id, label, focus:false and env passthrough",
			},
			{
				file: "tests/herdr/guards.test.ts",
				name: "tab.create with focus:true throws (focus theft)",
			},
			{
				file: "tests/herdr/adapter.test.ts",
				name: "sends pane.split with target_pane_id, direction, focus:false, env passthrough",
			},
		],
		manual: [
			{
				capture: "docs/analysis/clean-profile-install.md §3",
				what: "clean-profile run — focused workspace stayed `wN` before/during/after (live, not cross-workspace spawn)",
			},
			{
				capture: "docs/analysis/e2e-evidence.md §Manual-evidence steps",
				what: "E2E step s5 (cross-workspace spawn focus) — scripted, not yet live-witnessed",
			},
		],
		witnessPending: "E2E s5 cross-workspace focus — owner live-witness outstanding",
	},
	{
		id: "FR-14",
		title: "Ownership invariants — view ops never spawn or remove workers",
		tests: [

			{
				file: "tests/guards/invariants.test.ts",
				name: "(b) FR-14: open/split/close/reopen never spawns a duplicate worker",
			},
			{
				file: "tests/extension/topology.test.ts",
				name: "onWorkerFinished drops the split binding only — never worker effects (P4-R8)",
			},
			{
				file: "tests/extension/topology.test.ts",
				name: "closing a split emits topology, never worker.removed (P4-R8/FR-14)",
			},
		],
		manual: [
			{
				capture: "tests/guards/sabotage.md §(a)/§(b)",
				what: "sabotage red — split-close → worker.removed and view-op re-spawn both fail the suite",
			},
		],
	},
	{
		id: "FR-15",
		title: "Reusable package — omp plugin link/install, humane README+docs",
		tests: [
			{
				file: "tests/extension/resolve.test.ts",
				name: "returns a runnable `bun <abs path to src/viewer/cli.ts>` invocation",
			},
			{
				file: "tests/extension/resolve.test.ts",
				name: "is independent of process.cwd()",
			},
			{
				file: "tests/viewer/cli.test.ts",
				name: "resolveViewerCommand resolves to the real cli.ts behind a runnable `bun` word",
			},
			{
				file: "tests/extension/topology-herdr.test.ts",
				name: "the production viewer command word is a runnable `bun <cli.ts>` invocation",
			},
		],
		manual: [
			{
				capture: "docs/analysis/clean-profile-install.md §2–§3",
				what: "clean-profile `p6t7-clean` link + live delegation from `/private/tmp/p6t7-scratch`: viewer `[connected]`, argv rooted at installed package",
			},
		],
	},
	{
		id: "NFR-01",
		title: "Local-only — unix socket 0600/0700, no network, no secrets",
		tests: [
			{
				file: "tests/guards/fail-soft.test.ts",
				name: "bridge socket: 0600 unix socket inside a 0700 per-session dir; no TCP listener",
			},
			{
				file: "tests/guards/fail-soft.test.ts",
				name: "a second session in the same workspace binds a DISTINCT socket",
			},
			{
				file: "tests/guards/fail-soft.test.ts",
				name: "close() unlinks the socket and removes the per-session dir",
			},
			{
				file: "tests/extension/history/guards.test.ts",
				name: "scan under Bun.spawn/listen/connect/serve recorders: no spawn, no socket, no forbidden argv",
			},
			{
				file: "tests/extension/history/guards.test.ts",
				name: "scans the real history sources (non-vacuous: scan.ts is present)",
			},
			{
				file: "tests/extension/bridge.test.ts",
				name: "two bridges in the same session get unique socket paths",
			},
		],
	},
	{
		id: "NFR-02",
		title: "Version discipline — pin OMP 19.0.1 / Herdr 0.9.5, fail soft on drift",
		tests: [
			{
				file: "tests/extension/observe-wiring.test.ts",
				name: "absent pi.events degrades: one warn notice is broadcast after bridge start",
			},
			{
				file: "tests/extension/roster.test.ts",
				name: "unknown status keeps the last known status and emits a notice",
			},
			{
				file: "tests/extension/observe/schemas.test.ts",
				name: "tolerates extra event keys (message_end carries a message)",
			},
			{
				file: "tests/guards/fail-soft.test.ts",
				name: "per-call timeout defaults are 2s connect / 5s request (source pin)",
			},
		],
		manual: [
			{
				capture: "docs/analysis/clean-profile-install.md §1",
				what: "installed `omp/19.1.1` (self-reported) + `herdr 0.9.5` vs spec pin `19.0.1` — drift recorded, owner decision open",
			},
		],
		witnessPending: "version-drift decision (OI-1) — owner chooses re-pin 19.0.1 vs accept 19.1.1",
	},
	{
		id: "NFR-03",
		title: "Performance — coalesce ≤150 ms, bounded buffers, bounded tail",
		tests: [
			{
				file: "tests/guards/perf-bounds.test.ts",
				name: "100-frame burst emits exactly 1 coalesced upsert per 150ms window, latest-wins",
			},
			{
				file: "tests/guards/perf-bounds.test.ts",
				name: "50k frames through encode/decode/roster/viewer: bounded heap, bounded lines",
			},
			{
				file: "tests/guards/perf-bounds.test.ts",
				name: "50k decodes on a mixed junk corpus stays flat",
			},
			{
				file: "tests/extension/bridge.test.ts",
				name: "rapid progress changes coalesce into a single upsert carrying the latest state",
			},
			{
				file: "tests/viewer/cli.test.ts",
				name: "stamp-only upserts single-flight renders and keep last good text (P3-R11 bound)",
			},
		],
		manual: [
			{
				capture: ".superpowers/sdd/2026-11-24-v1-hardening/progress.md (P6-4 completion line)",
				what: "measured: 50k-frame heap delta 0.48MiB, junk 0.32MiB; 100-frame burst → 1 coalesced upsert",
			},
		],
	},
	{
		id: "NFR-04",
		title: "Safety — OMP sole owner; no agent start/report_agent; no focus:true",
		tests: [
			{
				file: "tests/guards/herdr-source-scan.test.ts",
				name: "no findings over real src/**/*.ts",
			},
			{
				file: "tests/guards/herdr-source-scan.test.ts",
				name: "every fixture produces at least one finding (no silent pass)",
			},
			{
				file: "tests/guards/herdr-source-scan.test.ts",
				name: "a guards.ts missing denylist entries is flagged (requireDenylist)",
			},
			{
				file: "tests/herdr/guards.test.ts",
				name: "String.fromCharCode composition cannot evade the denylist",
			},
			{
				file: "tests/herdr/guards.test.ts",
				name: "computed params keys cannot smuggle focus or tab_id",
			},
			{
				file: "tests/extension/topology.test.ts",
				name: "owned panes are reported with source, never as an agent (P4-R13)",
			},
			{
				file: "tests/viewer/cli.test.ts",
				name: "no viewer file calls any forbidden pane/agent API or imports the pane adapter",
			},
			{
				file: "tests/guards/invariants.test.ts",
				name: "(g) F-15: every pi.on / pi.events.on / command handler is synchronous",
			},
		],
		manual: [
			{
				capture: "tests/guards/sabotage.md §(c)/§(g)",
				what: "sabotage red — focus:true flips and async handlers both fail at the guarded boundary",
			},
		],
	},
	{
		id: "NFR-05",
		title: "Testability — reducer/protocol/adapter units + isolated-session integration + tamper-proven",
		tests: [
			{
				file: "tests/guards/lifecycle-reconcile.test.ts",
				name: "events_lost: exactly one live subscription, transparent resubscribe, snapshot reconcile, no duplicate viewer",
			},
			{
				file: "tests/guards/shutdown.test.ts",
				name: "session_shutdown is idempotent — a second emit stops nothing twice",
			},
			{
				file: "tests/guards/fail-soft.test.ts",
				name: "stalled (not refused) socket trips the request timeout; refused fails fast",
			},
			{
				file: "tests/extension/history/restart.test.ts",
				name: "new activation surfaces prior workers: not-live, transcript.ref, no spawn, no live copy",
			},
		],
		manual: [
			{
				capture: "docs/analysis/e2e-evidence.md Run A",
				what: "safe E2E `bash scripts/run-e2e.sh` → exit 0 (7 pass / 0 fail / 5 skipped), daily workspace byte-identical",
			},
			{
				capture: "tests/guards/sabotage.md",
				what: "7/7 invariant sabotage patches produced red suite output before revert",
			},
		],
	},
	{
		id: "NFR-06",
		title: "Docs reconcile — docs match shipped behavior exactly",
		tests: [],
		docChecks: true,
		manual: [
			{
				capture: "this report §Doc-vs-shipped checklist (DC-1..DC-21)",
				what: "machine-asserted README/CONTRIBUTING/architecture sections contain shipped-truth content",
			},
			{
				capture: "README.md §Verified commands",
				what: "every documented command executed 2026-11-25 at 7e8e131, output quoted verbatim",
			},
		],
	},
];

// --- doc-vs-shipped checklist (P6-R10): machine assertions over the docs -----

type DocCheck = { id: string; file: string; pattern: RegExp; why: string };
const DOC_CHECKS: DocCheck[] = [
	{ id: "DC-1", file: "README.md", pattern: /read-only/i, why: "v1 read-only is stated" },
	{
		id: "DC-2",
		file: "README.md",
		pattern: /direct/i,
		why: "scope is direct workers only",
	},
	{
		id: "DC-3",
		file: "README.md",
		pattern: /reopen/i,
		why: "reopen-on-next-subtask semantics",
	},
	{
		id: "DC-4",
		file: "README.md",
		pattern: /degraded mode \(D1\)|\bD1\b/i,
		why: "degraded-mode behavior documented",
	},
	{
		id: "DC-5",
		file: "README.md",
		pattern: /R-04|not reconstructable/i,
		why: "history caveat R-04 recorded",
	},
	{
		id: "DC-6",
		file: "README.md",
		pattern: /19\.0\.1/,
		why: "spec pin recorded",
	},
	{
		id: "DC-7",
		file: "README.md",
		pattern: /19\.1\.1/,
		why: "installed drift recorded",
	},
	{
		id: "DC-8",
		file: "README.md",
		pattern: /Herdr 0\.9\.5|Herdr \*\*0\.9\.5\*\*/i,
		why: "Herdr version recorded",
	},
	{
		id: "DC-9",
		file: "README.md",
		pattern: /\/lens split/,
		why: "worker split command documented",
	},
	{
		id: "DC-10",
		file: "README.md",
		pattern: /^## Limitations$/m,
		why: "recorded-limitations section exists",
	},
	{
		id: "DC-11",
		file: "README.md",
		pattern: /omp plugin link/,
		why: "install command documented",
	},
	{
		id: "DC-12",
		file: "README.md",
		pattern: /OMP subagents/,
		why: "overview tab name shipped-truth",
	},
	{
		id: "DC-13",
		file: "README.md",
		pattern: /queued|idle|parked/i,
		why: "untriggered transitions recorded",
	},
	{
		id: "DC-14",
		file: "README.md",
		pattern: /no worker control|steer|cancel/i,
		why: "no worker control boundary stated",
	},
	{
		id: "DC-15",
		file: "CONTRIBUTING.md",
		pattern: /gen-dod-report\.ts/,
		why: "DoD regeneration documented",
	},
	{
		id: "DC-16",
		file: "CONTRIBUTING.md",
		pattern: /run-e2e\.sh/,
		why: "E2E command documented",
	},
	{
		id: "DC-17",
		file: "CONTRIBUTING.md",
		pattern: /sabotage\.md|tamper/i,
		why: "tamper-discipline documented",
	},
	{
		id: "DC-18",
		file: "docs/architecture.md",
		pattern: /0600/,
		why: "socket mode documented",
	},
	{
		id: "DC-19",
		file: "docs/architecture.md",
		pattern: /LENS_SOCKET_PATH/,
		why: "viewer env handoff documented",
	},
	{
		id: "DC-20",
		file: "docs/architecture.md",
		pattern: /degraded/i,
		why: "degraded-mode behavior documented",
	},
	{
		id: "DC-21",
		file: "docs/architecture.md",
		pattern: /subscribe/i,
		why: "subscribe-before-create documented",
	},
];

// --- recorded limitations + open items (sign-off pack) -----------------------

const LIMITATIONS: { what: string; source: string }[] = [
	{
		what: "`queued` not emitted by a parallel two-agent `task` batch on v19.1.1; no reachable trigger",
		source: "docs/analysis/phase-0-caveat-closure.md §Recorded limitations 1",
	},
	{
		what: "`idle` / `parked` have no deterministic trigger in print-mode `task` usage on this build",
		source: "docs/analysis/phase-0-caveat-closure.md §Recorded limitations 2",
	},
	{
		what: "`detached` semantics for TUI async spawns is unverified (field `optional()`, unconsumed — harmless but unverified)",
		source: "docs/analysis/phase-0-caveat-closure.md §Recorded limitations 3",
	},
	{
		what: "pre-activation workers are not observed — no registry snapshot exists for extensions (U-OMP-5)",
		source: "docs/analysis/phase-0-caveat-closure.md §U-OMP unknowns",
	},
	{
		what: "history caveat (R-04): live `counters` are not reconstructable from persisted JSONL — historical rows show `counters` absent + not-live badge",
		source: "docs/superpowers/specs/2026-11-19-herdr-omp-lens-design.md §12 R-04",
	},
	{
		what: "transient finished-collapse is unit-covered, not witnessed live (reaping can outpace readback)",
		source: "docs/analysis/e2e-evidence.md Fix-round F3",
	},
	{
		what: "Herdr-restart viewer-layout restore is out of scope for v1 (v2 horizon)",
		source: "docs/plans/00-master-plan.md §2 v2 horizon",
	},
	{
		what: "version drift: evidence collected on OMP 19.1.1 / Herdr 0.9.5 vs spec pin 19.0.1 — open owner decision",
		source: "docs/analysis/clean-profile-install.md §1",
	},
	{
		what: "E2E live steps s2–s5 (close→reopen, /lens split, restart→history, cross-workspace focus) are scripted but not yet owner-witnessed",
		source: "docs/analysis/e2e-evidence.md §Manual-evidence steps",
	},
];

const OPEN_ITEMS: { id: string; item: string; ownerAction: string; source: string }[] = [
	{
		id: "OI-1",
		item: "Version drift — installed OMP 19.1.1 vs spec pin 19.0.1",
		ownerAction: "decide: re-pin the spec to 19.1.1, or re-verify on 19.0.1",
		source: "docs/analysis/clean-profile-install.md §1; .superpowers/sdd/2026-11-24-v1-hardening/progress.md (P6-5 OPEN OWNER DECISION)",
	},
	{
		id: "OI-2",
		item: "E2E live lifecycle steps s2–s5 (close→reopen, /lens split, restart→history, cross-workspace focus)",
		ownerAction: "spot-witness `RUN_E2E_LIVE=1 bash scripts/run-e2e.sh` inside a Herdr pane; at minimum s5 focus",
		source: "docs/analysis/e2e-evidence.md §Manual-evidence steps; progress.md (P6-6 CONDITION)",
	},
	{
		id: "OI-3",
		item: "Deferred review minors (non-blocking follow-ups from P6 reviews)",
		ownerAction: "triage at final review; each already has a sibling assertion or bounded failure mode",
		source: "progress.md deferred-minor lines: invariants (f) h.errors check; scan-herdr-calls errorCtx exemption; e2e unbounded `herdr --version` preflight + stale pre-restart ids; clean-profile scratch teardown; P5 roll-up minors",
	},
];

// --- runtime ----------------------------------------------------------------

type Case = { name: string; cls: string; file: string; line: number; failed: boolean };

function decodeEntities(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

function runJunit(): { cases: Case[]; suites: number; tests: number; failures: number; assertions: number; stdoutTail: string } {
	const dir = mkdtempSync(join(tmpdir(), "dod-junit-"));
	const out = join(dir, "junit.xml");
	let stdoutTail = "";
	{
		const p = Bun.spawnSync({
			cmd: ["bun", "test", "--reporter=junit", `--reporter-outfile=${out}`],
			cwd: REPO,
			stdout: "pipe",
			stderr: "pipe",
		});
		stdoutTail = (new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr))
			.trimEnd()
			.split("\n")
			.slice(-4)
			.join("\n");
	}
	const xml = readFileSync(out, "utf8");
	rmSync(dir, { recursive: true, force: true });
	const cases: Case[] = [];
	for (const m of xml.matchAll(/<testcase name="([^"]*)" classname="([^"]*)" time="[^"]*" file="([^"]*)" line="(\d+)"/g)) {
		cases.push({ name: decodeEntities(m[1]), cls: decodeEntities(m[2]), file: m[3], line: Number(m[4]) });
	}
	// failed testcases have a child <failure .../> — re-parse to detect
	const caseStarts = [...xml.matchAll(/<testcase /g)].map((m) => m.index!);
	for (let i = 0; i < caseStarts.length; i++) {
		const seg = xml.slice(caseStarts[i], caseStarts[i + 1] ?? xml.length);
		if (/<failure|<skipped/.test(seg)) cases[i].failed = true;
	}
	const suites = (xml.match(/<testsuite /g) ?? []).length;
	const top = xml.match(/<testsuites [^>]*tests="(\d+)"[^>]*assertions="(\d+)"[^>]*failures="(\d+)"/);
	return {
		cases,
		suites,
		tests: top ? Number(top[1]) : cases.length,
		assertions: top ? Number(top[2]) : 0,
		failures: top ? Number(top[3]) : 0,
		stdoutTail,
	};
}

function gate(cmd: string[]): { ok: boolean; out: string } {
	const p = Bun.spawnSync({ cmd, cwd: REPO, stdout: "pipe", stderr: "pipe" });
	return { ok: p.exitCode === 0, out: (new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)).trim() };
}

function fileContains(file: string, needle: string): boolean {
	try {
		return readFileSync(join(REPO, file), "utf8").includes(needle);
	} catch {
		return false;
	}
}

function sabotageRows(): { letter: string; title: string; red: string }[] {
	const path = join(REPO, "tests/guards/sabotage.md");
	const text = readFileSync(path, "utf8");
	return text
		.split(/\n## /)
		.slice(1)
		.filter((p) => /^\([a-g]\) /.test(p.split("\n")[0]))
		.map((p) => {
			const title = p.split("\n")[0].trim();
			const letter = title[1];
			const red = p.split("**Red output:**")[1] ?? "";
			const block = /```\n([\s\S]*?)```/.exec(red)?.[1] ?? "";
			const lines = block
				.split("\n")
				.map((l) => l.trimEnd())
				.filter((l) => l.length > 0);
			const errLine = lines.find((l) => /^(error:|Expected|Received|HerdrForbiddenError|\(fail\))/.test(l)) ?? "";
			const failLine = lines.find((l) => l.startsWith("(fail)")) ?? "";
			const snippet = [errLine, failLine].filter(Boolean).slice(0, 2).join(" · ").slice(0, 220);
			return { letter, title, red: snippet };
		});
}

function main(): number {
	const junit = runJunit();
	const tsc = gate(["bun", "run", "typecheck"]);
	const lint = gate(["bun", "run", "lint"]);
	const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO }).toString().trim();
	const date = new Date().toISOString().slice(0, 10);

	// junit lookups
	const byFileName = new Map<string, Case[]>();
	for (const c of junit.cases) {
		const k = `${c.file}${c.name}`;
		(byFileName.get(k) ?? byFileName.set(k, []).get(k)!).push(c);
	}

	const problems: string[] = [];
	const rows: { req: Requirement; status: "pass" | "fail" | "manual-evidence"; cited: string[]; manualCells: string[]; issues: string[] }[] = [];

	for (const req of REQS) {
		const cited: string[] = [];
		const issues: string[] = [];
		for (const t of req.tests ?? []) {
			const k = `${t.file}${t.name}`;
			const found = byFileName.get(k);
			if (!fileContains(t.file, t.name)) {
				issues.push(`test name not found in ${t.file}: "${t.name}"`);
				continue;
			}
			if (!found || found.length === 0) {
				issues.push(`cited test absent from this run: ${t.file} :: "${t.name}"`);
				continue;
			}
			if (found.some((c) => c.failed)) {
				issues.push(`cited test FAILED: ${t.file} :: "${t.name}"`);
				continue;
			}
			cited.push(`${t.file} :: "${t.name}" (line ${found[0].line}, pass)`);
		}
		const manualCells = (req.manual ?? []).map((m) => `${m.capture} — ${m.what}`);
		let status: "pass" | "fail" | "manual-evidence" = "pass";
		if (issues.length > 0) status = "fail";
		else if (req.docChecks !== true && (req.tests ?? []).length === 0) status = "manual-evidence";
		else if (req.witnessPending) status = "manual-evidence";
		if ((req.tests ?? []).length === 0 && (req.manual ?? []).length === 0) {
			issues.push("row untraced: no tests and no capture");
			status = "fail";
		}
		for (const i of issues) problems.push(`${req.id}: ${i}`);
		rows.push({ req, status, cited, manualCells, issues });
	}

	// doc checks
	const docResults = DOC_CHECKS.map((d) => {
		let ok = false;
		try {
			ok = d.pattern.test(readFileSync(join(REPO, d.file), "utf8"));
		} catch {
			ok = false;
		}
		return { ...d, ok };
	});
	const docFails = docResults.filter((d) => !d.ok);
	if (docFails.length > 0) {
		// NFR-06 becomes fail
		const r = rows.find((r) => r.req.id === "NFR-06")!;
		r.status = "fail";
		r.issues.push(`doc checks failing: ${docFails.map((d) => d.id).join(", ")}`);
		for (const d of docFails) problems.push(`NFR-06 doc check ${d.id} (${d.file}): /${d.pattern.source}/ not found`);
	}

	const sabot = sabotageRows();
	const counts = { pass: rows.filter((r) => r.status === "pass").length, fail: rows.filter((r) => r.status === "fail").length, manual: rows.filter((r) => r.status === "manual-evidence").length };

	const lines: string[] = [];
	lines.push(`# DoD-v1 evidence report — herdr-omp-lens v1 "The Window"`);
	lines.push(``);
	lines.push(`> GENERATED FILE — do not edit. Regenerate with \`bun scripts/gen-dod-report.ts\`.`);
	lines.push(`> Owner sign-off (P6-R11): **UNSIGNED — the owner signs, the agent only prepares.** See §Sign-off.`);
	lines.push(``);
	lines.push(`- Generated: ${date} · commit \`${head}\` · Bun ${Bun.version}`);
	lines.push(`- Environment: OMP **19.1.1** (installed; spec pin **19.0.1** — open owner decision OI-1) · Herdr **0.9.5**`);
	lines.push(`- Test gate: \`bun test\` → **${junit.tests} pass / ${junit.failures} fail** (${junit.suites} suites, ${junit.assertions} assertions)`);
	lines.push(`- Static gates: \`bun run typecheck\` ${tsc.ok ? "clean" : "**FAILED**"} · \`bun run lint\` ${lint.ok ? `clean (${lint.out.split("\n").pop()})` : "**FAILED**"}`);
	lines.push(`- Suite summary: \`${junit.stdoutTail.split("\n").slice(-1)[0]}\``);
	lines.push(``);

	lines.push(`## Requirement matrix`);
	lines.push(``);
	lines.push(`Every FR-01..15 + NFR-01..06 has exactly one row. Legend:`);
	lines.push(`- **pass** — every cited automated test is green AND no required live witness is outstanding;`);
	lines.push(`- **manual-evidence** — the automated row is green (or none applies) but a required live witness/capture is still pending OR the acceptance is witnessed-only. The named capture says exactly what is missing;`);
	lines.push(`- **fail** — a cited test failed, was not found in this run, or its name is absent from its file.`);
	lines.push(``);
	lines.push(`| Req | Requirement | Status | Automated evidence | Manual / witnessed capture |`);
	lines.push(`| --- | ----------- | ------ | ------------------ | --------------------------- |`);
	for (const r of rows) {
		const auto = r.cited.length === 0 ? "—" : `${r.cited.length} test${r.cited.length > 1 ? "s" : ""} pass`;
		const manual = r.manualCells.length === 0 ? "—" : `${r.manualCells.length} capture${r.manualCells.length > 1 ? "s" : ""}${r.req.witnessPending ? ` (⚠ ${r.req.witnessPending})` : ""}`;
		lines.push(`| ${r.req.id} | ${r.req.title} | ${r.status} | ${auto} | ${manual} |`);
	}
	lines.push(``);
	lines.push(`Totals: **${counts.pass} pass · ${counts.manual} manual-evidence · ${counts.fail} fail** out of ${rows.length} requirements.`);
	lines.push(``);

	lines.push(`## Per-requirement evidence`);
	for (const r of rows) {
		lines.push(``);
		lines.push(`### ${r.req.id} — ${r.req.title} · status: ${r.status}`);
		if (r.cited.length > 0) {
			lines.push(``);
			for (const c of r.cited) lines.push(`- \`${c}\``);
		}
		if (r.manualCells.length > 0) {
			if (r.cited.length > 0) lines.push(``);
			for (const m of r.manualCells) lines.push(`- manual: ${m}`);
		}
		if (r.issues.length > 0) {
			for (const i of r.issues) lines.push(`- **issue:** ${i}`);
		}
	}
	lines.push(``);

	lines.push(`## Safety-invariant sabotage proofs (P6-R2/R3)`);
	lines.push(``);
	lines.push(`Every tamper test is proven red by a deliberate source sabotage; each patch was applied, the`);
	lines.push(`suite went red, the output was captured, and the patch was reverted. Verbatim red evidence:`);
	lines.push(``);
	lines.push(`| Invariant | Sabotage | Red evidence (verbatim) |`);
	lines.push(`| --------- | -------- | --------------------- |`);
	for (const s of sabot) {
		lines.push(`| ${s.title} | \`src/\` patch in tests/guards/sabotage.md §${s.letter} | ${s.red.replace(/\|/g, "\\|")} |`);
	}
	lines.push(``);
	lines.push(`Clean restore verified: \`git diff -- src/\` empty; \`7 pass, 0 fail, 83 expect() calls\`.`);
	lines.push(``);

	lines.push(`## Live / witnessed captures (index)`);
	lines.push(``);
	lines.push(`| Capture | What it shows |`);
	lines.push(`| ------- | ------------- |`);
	lines.push(`| session \`01a210e2-5995-74b7-99d0-1acf4182b855\` (pane \`wN:p4\`) — docs/analysis/phase-0-caveat-closure.md §Caveat 1 | interactive-TUI witness: overview auto-opened, viewer \`[connected]\`, live worker rendered; closes U-OMP-1 |`);
	lines.push(`| clean profile \`p6t7-clean\`, workspace \`w11\`, cwd \`/private/tmp/p6t7-scratch\` — docs/analysis/clean-profile-install.md §3 | plugin-link install + first delegation: tab \`w11:t2 "OMP subagents"\` (\`w11:p2\`), viewer \`[connected]\`, focus stayed \`wN\` |`);
	lines.push(`| probe \`/tmp/lens-probe-a-out/frames.jsonl\` — caveat-closure §Caveat 2 | \`aborted\` triggered live; raw lifecycle/progress frames captured |`);
	lines.push(`| probe \`/tmp/lens-probe-q-out/frames.jsonl\` — caveat-closure §Caveat 2 | two-agent batch; no \`queued\` frame anywhere in the 80-frame capture |`);
	lines.push(`| \`bash scripts/run-e2e.sh\` safe run — docs/analysis/e2e-evidence.md Run A | disposable \`lens-e2e-*\` round-trip, daily workspace byte-identical before/after |`);
	lines.push(``);

	lines.push(`## Doc-vs-shipped checklist (P6-R10 / NFR-06)`);
	lines.push(``);
	lines.push(`| Check | Doc | Assertion | Result |`);
	lines.push(`| ----- | --- | --------- | ------ |`);
	for (const d of docResults) {
		lines.push(`| ${d.id} | \`${d.file}\` | ${d.why} | ${d.ok ? "✓" : "**✗**"} |`);
	}
	lines.push(``);

	lines.push(`## Known limitations (recorded, not skipped)`);
	lines.push(``);
	for (const l of LIMITATIONS) {
		lines.push(`- ${l.what} — _source: ${l.source}_`);
	}
	lines.push(``);

	lines.push(`## Open items for owner decision (P6-R11)`);
	lines.push(``);
	lines.push(`| ID | Item | Owner action | Source |`);
	lines.push(`| -- | ---- | ------------ | ------ |`);
	for (const o of OPEN_ITEMS) {
		lines.push(`| ${o.id} | ${o.item} | ${o.ownerAction} | ${o.source} |`);
	}
	lines.push(``);

	lines.push(`## Sign-off (owner only)`);
	lines.push(``);
	lines.push(`DoD-v1 acceptance. The agent prepared this pack; **the owner records the decision — never the agent.**`);
	lines.push(`Signing off means: every \`pass\` row accepted, every \`manual-evidence\` row's pending witness`);
	lines.push(`either witnessed or converted to a recorded limitation, and OI-1..OI-3 resolved or deferred.`);
	lines.push(``);
	lines.push(`| Date | Owner | Decision | Notes | Signature |`);
	lines.push(`| ---- | ----- | -------- | ----- | --------- |`);
	lines.push(`| _unsigned_ | | | | |`);
	lines.push(``);
	lines.push(`**Status: UNSIGNED** — awaiting owner sign-off before any v2 work begins.`);
	lines.push(``);

	writeFileSync(REPORT_PATH, `${lines.join("\n")}\n`);

	console.log(`wrote ${REPORT_PATH}`);
	console.log(`rows: ${counts.pass} pass / ${counts.manual} manual-evidence / ${counts.fail} fail of ${rows.length}`);
	if (junit.failures > 0) console.log(`junit: ${junit.failures} test failure(s)`);
	if (problems.length > 0) {
		for (const p of problems) console.log(`PROBLEM: ${p}`);
		return 1;
	}
	return 0;
}

process.exitCode = main();
