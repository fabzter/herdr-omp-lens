# DoD-v1 evidence report — herdr-omp-lens v1 "The Window"

> GENERATED FILE — do not edit. Regenerate with `bun scripts/gen-dod-report.ts`.
> Owner sign-off (P6-R11): **UNSIGNED — the owner signs, the agent only prepares.** See §Sign-off.

- Generated: 2026-11-26 · commit `9f7141c` · Bun 1.3.14
- Environment: OMP **19.2.1** (installed == spec pin **19.2.1** — OI-1 + OI-4 resolved 2026-11-25: 19.0.1 → 19.1.1 → 19.2.1) · Herdr **0.9.5** (probed live: `omp --version` / `herdr --version`)
- Test gate: `bun test` → **501 pass / 0 fail** (166 suites, 1832 assertions)
- Static gates: `bun run typecheck` clean · `bun run lint` clean (Checked 68 files in 26ms. No fixes applied.)
- Suite summary: `Ran 501 tests across 36 files. [3.75s]`

## Requirement matrix

Every FR-01..15 + NFR-01..06 has exactly one row. Legend:
- **pass** — every cited automated test is green AND no required live witness is outstanding;
- **manual-evidence** — the automated row is green (or none applies) but a required live witness/capture is still pending OR the acceptance is witnessed-only. The named capture says exactly what is missing;
- **fail** — a cited test failed, was not found in this run, or its name is absent from its file.

| Req | Requirement | Status | Automated evidence | Manual / witnessed capture |
| --- | ----------- | ------ | ------------------ | --------------------------- |
| FR-01 | Herdr gate — activate only under HERDR_ENV=1 + full caller context | pass | 6 tests pass | 1 capture |
| FR-02 | Native observation — task:subagent:* bus → direct-worker roster | pass | 6 tests pass | 1 capture |
| FR-03 | Local bridge — unix-socket NDJSON, 0600 socket, versioned handshake | pass | 7 tests pass | — |
| FR-04 | Overview tab — one no-focus `OMP subagents` tab on first spawn | pass | 5 tests pass | 2 captures |
| FR-05 | Reopen after close — next spawn reopens exactly one tab | pass | 4 tests pass | 1 capture |
| FR-06 | Optional split — no-focus worker-scoped split, close ≠ cancel | manual-evidence | 6 tests pass | 1 capture (⚠ E2E s3 /lens split — typed-command input-clear + pane-list null-title bugs fixed; live witness pending post-E2) |
| FR-07 | OMP-like detail — roster fields, inspector, live transcript | pass | 5 tests pass | — |
| FR-08 | Finished visibility — completed workers stay listed, retained after reap (v1.2, owner decision) | pass | 6 tests pass | — |
| FR-09 | History — persisted transcripts after restart, marked not-live | manual-evidence | 6 tests pass | 1 capture (⚠ E2E s4 restart→history — env-coupled local-build session-bind gap in Runs C/D/E/E2) |
| FR-10 | Direct-only scope — nested and other-session workers excluded | pass | 3 tests pass | — |
| FR-11 | Read-only — no control frames, no control affordance | pass | 6 tests pass | 1 capture |
| FR-12 | Fail-soft — never blocks an OMP turn; degrade to one notice | pass | 6 tests pass | 1 capture |
| FR-13 | No focus theft — every topology op is no-focus | pass | 5 tests pass | 2 captures |
| FR-14 | Ownership invariants — view ops never spawn or remove workers | pass | 4 tests pass | 1 capture |
| FR-15 | Reusable package — omp plugin link/install, humane README+docs | pass | 4 tests pass | 1 capture |
| NFR-01 | Local-only — unix socket 0600/0700, no network, no secrets | pass | 6 tests pass | — |
| NFR-02 | Version discipline — pin OMP 19.2.1 / Herdr 0.9.5, fail soft on drift | pass | 4 tests pass | 1 capture |
| NFR-03 | Performance — coalesce ≤150 ms, bounded buffers, bounded tail | pass | 5 tests pass | 1 capture |
| NFR-04 | Safety — OMP sole owner; no agent start/report_agent; no focus:true | pass | 8 tests pass | 1 capture |
| NFR-05 | Testability — reducer/protocol/adapter units + isolated-session integration + tamper-proven | pass | 4 tests pass | 2 captures |
| NFR-06 | Docs reconcile — docs match shipped behavior exactly | pass | — | 2 captures |

Totals: **19 pass · 2 manual-evidence · 0 fail** out of 21 requirements.

## Per-requirement evidence

### FR-01 — Herdr gate — activate only under HERDR_ENV=1 + full caller context · status: pass

- `tests/extension/gate.test.ts :: "registers nothing when HERDR_ENV is unset" (line 74, pass)`
- `tests/extension/gate.test.ts :: "registers nothing when HERDR_ENV=1 but a context var is missing" (line 85, pass)`
- `tests/extension/gate.test.ts :: "registers /lens and activates observation when the full Herdr env is present" (line 96, pass)`
- `tests/extension/observe-wiring.test.ts :: "outside Herdr the gate is a no-op: startObservation is never invoked" (line 374, pass)`
- `tests/guards/invariants.test.ts :: "(e) FR-01: HERDR_ENV unset — extension registers nothing, activates nothing" (line 460, pass)`
- `tests/herdr/context.test.ts :: "false when HERDR_ENV is not exactly '1'" (line 32, pass)`

- manual: tests/guards/sabotage.md §(e) — sabotage red — a fabricated caller context registers /lens and the suite fails

### FR-02 — Native observation — task:subagent:* bus → direct-worker roster · status: pass

- `tests/extension/observe-wiring.test.ts :: "subscribes the three task:subagent:* channels and before_subagent_spawn" (line 213, pass)`
- `tests/extension/observe-wiring.test.ts :: "spawn hook + frames feed the roster synchronously and broadcast (fire-and-forget)" (line 229, pass)`
- `tests/extension/roster.test.ts :: "a direct id joins the roster on its first lifecycle frame" (line 77, pass)`
- `tests/extension/roster.test.ts :: "lifecycle started maps to running" (line 93, pass)`
- `tests/extension/roster.test.ts :: "counters come from the nested .progress object, not the envelope" (line 193, pass)`
- `tests/extension/observe/schemas.test.ts :: "reads counters from nested .progress envelope" (line 74, pass)`

- manual: docs/analysis/phase-0-caveat-closure.md §Caveat 1 — interactive-TUI witness session 01a210e2-5995-74b7-99d0-1acf4182b855 — viewer rendered the live worker (closes U-OMP-1)

### FR-03 — Local bridge — unix-socket NDJSON, 0600 socket, versioned handshake · status: pass

- `tests/extension/bridge.test.ts :: "valid ClientMessage handshake gets hello{session,workers,history}" (line 208, pass)`
- `tests/extension/bridge.test.ts :: "spawn/change signals produce worker.upsert broadcasts" (line 297, pass)`
- `tests/extension/bridge.test.ts :: "default socketPath lives under a unique 0700 dir and the socket is 0600" (line 397, pass)`
- `tests/extension/bridge.test.ts :: "close() stops listening and unlinks the socket file" (line 421, pass)`
- `tests/extension/bridge.test.ts :: "F6: guard — bridge binds only a unix socket, never TCP (P2-R6)" (line 603, pass)`
- `tests/guards/fail-soft.test.ts :: "bridge socket: 0600 unix socket inside a 0700 per-session dir; no TCP listener" (line 379, pass)`
- `tests/extension/bridge.test.ts :: "SIGTERM unlinks the socket (real signal, child process)" (line 438, pass)`

### FR-04 — Overview tab — one no-focus `OMP subagents` tab on first spawn · status: pass

- `tests/extension/topology.test.ts :: "first spawn opens one no-focus overview tab and runs the viewer (P4-R2)" (line 182, pass)`
- `tests/extension/topology.test.ts :: "single-flight: parallel spawns create exactly one tab (P4-R4)" (line 200, pass)`
- `tests/extension/topology.test.ts :: "subscribes lifecycle before the first createOverviewTab (P4-R1)" (line 172, pass)`
- `tests/extension/topology-herdr.test.ts :: "runInPane sends the short viewer command verbatim into the root pane" (line 229, pass)`
- `tests/extension/topology.test.ts :: "onHistoryPresent auto-opens the overview with no spawn (D2)" (line 247, pass)`

- manual: docs/analysis/phase-0-caveat-closure.md §Caveat 1 — witnessed session 01a210e2-5995-74b7-99d0-1acf4182b855 — overview tab auto-opened on the history/spawn signal
- manual: docs/analysis/clean-profile-install.md §3 — clean-profile run — tab `w11:t2 "OMP subagents"` (pane `w11:p2`), focus stayed `wN`

### FR-05 — Reopen after close — next spawn reopens exactly one tab · status: pass

- `tests/extension/topology.test.ts :: "manual close is respected; next spawn reopens exactly once (P4-R3)" (line 256, pass)`
- `tests/extension/topology.test.ts :: "final F2: overview pane.exited marks the view dead; next spawn relaunches in the same pane" (line 530, pass)`
- `tests/extension/topology.test.ts :: "F2: a split moved out of the tab does not block tab.closed confirm (FR-05)" (line 483, pass)`
- `tests/extension/topology.test.ts :: "tab.closed while pane still present in snapshot does NOT mark closed (moved race)" (line 282, pass)`

- manual: docs/analysis/e2e-evidence.md §Run D — E2E step s2 (close → next spawn → exactly one tab w17:t3, FR-14 worker survives) — LIVE-WITNESSED in Run D 2026-11-25 (owner-witnessed, w17)

### FR-06 — Optional split — no-focus worker-scoped split, close ≠ cancel · status: manual-evidence

- `tests/extension/topology.test.ts :: "openWorkerSplit creates a no-focus worker-scoped split (P4-R7)" (line 359, pass)`
- `tests/extension/topology.test.ts :: "one split per worker: repeat call returns the live pane (Q-P4-3)" (line 379, pass)`
- `tests/extension/topology.test.ts :: "closing a split emits topology, never worker.removed (P4-R8/FR-14)" (line 404, pass)`
- `tests/extension/lens-commands.test.ts :: "/lens split <id> dispatches through the lens handler to openWorkerSplit" (line 325, pass)`
- `tests/extension/lens-commands.test.ts :: "/lens split without an id does nothing" (line 335, pass)`
- `tests/viewer/cli.test.ts :: "worker-scoped launch filters the screen to the scoped id only" (line 401, pass)`

- manual: docs/analysis/e2e-evidence.md §Manual-evidence steps — E2E step s3 (/lens split live) — STILL manual after owner-witnessed Runs D/E/E2 2026-11-25: Run D/E pane send-text JSON EOF flake (fixed: send-text → herdrProc, read retry); Run E2 uncovered the input-clear bug (/lens/lens split typed → submitted as prompt) — ctrl+u fix + scope-content detection landed, verified by live manual probe (w1A:t4 scoped pane rendered 'scope: worker alpha-responder [connected]'), full live witness still outstanding

### FR-07 — OMP-like detail — roster fields, inspector, live transcript · status: pass

- `tests/viewer/render.test.ts :: "renders detail lines incl. model/role/thinking/session (FR-07)" (line 85, pass)`
- `tests/viewer/render.test.ts :: "selected worker gets inspector + transcript block" (line 181, pass)`
- `tests/viewer/render.test.ts :: "renders all present counters; empty when none" (line 35, pass)`
- `tests/viewer/transcript.test.ts :: "spawns `omp render <sessionFile> --plain` by default; never history://" (line 89, pass)`
- `tests/viewer/transcript.test.ts :: "real `omp render` on a synthetic fixture exits 0 and hides thinking by default" (line 199, pass)`

### FR-08 — Finished visibility — completed workers stay listed, retained after reap (v1.2, owner decision) · status: pass

- `tests/viewer/render.test.ts :: "finished visible by default (v1.2 owner decision); collapse on demand hides rows" (line 148, pass)`
- `tests/viewer/render.test.ts :: "finished workers selectable by default (v1.2); hidden while collapsed on demand" (line 118, pass)`
- `tests/viewer/state.test.ts :: "removed keeps a finished row visible with its terminal status; selection + ref survive (v1.2)" (line 144, pass)`
- `tests/viewer/state.test.ts :: "retention is bounded: oldest non-live rows evicted past 100; live rows never evicted (v1.2, NFR-03)" (line 168, pass)`
- `tests/viewer/cli.test.ts :: "navigation includes finished by default (v1.2); collapsing hides them from selection" (line 155, pass)`
- `tests/viewer/tui.test.ts :: "zero workers still renders BOTH columns with the empty-state hint" (line 125, pass)`

### FR-09 — History — persisted transcripts after restart, marked not-live · status: manual-evidence

- `tests/extension/history/scan.test.ts :: "maps direct workers, excludes nested and foreign" (line 37, pass)`
- `tests/extension/history/status.test.ts :: "completed transcript maps completed, counters absent, historical" (line 65, pass)`
- `tests/extension/history/wiring.test.ts :: "hello.history carries scanned workers on connect AND reconnect" (line 233, pass)`
- `tests/extension/history/restart.test.ts :: "new activation surfaces prior workers: not-live, transcript.ref, no spawn, no live copy" (line 164, pass)`
- `tests/viewer/render.test.ts :: "history section renders with not-live label (P3-R9)" (line 163, pass)`
- `tests/viewer/state.test.ts :: "live upsert wins over a historical entry for the same id (RC-3)" (line 106, pass)`

- manual: docs/analysis/e2e-evidence.md §Manual-evidence steps — E2E step s4 (OMP restart → auto-open + not-live history) — STILL manual after owner-witnessed Runs D/E/E2 2026-11-25: local-build (-e) session-bind gap (agent_session never bound) → viewer-reconnect timeout 30s×2; tab reuse/rebind DID pass live in every run

### FR-10 — Direct-only scope — nested and other-session workers excluded · status: pass

- `tests/extension/roster.test.ts :: "frames for ids that were never spawned are excluded (nested/other-session filter)" (line 66, pass)`
- `tests/extension/observe-wiring.test.ts :: "frames for ids outside the direct-id set never enter the roster" (line 269, pass)`
- `tests/extension/history/scan.test.ts :: "maps direct workers, excludes nested and foreign" (line 37, pass)`

### FR-11 — Read-only — no control frames, no control affordance · status: pass

- `tests/protocol/codec.test.ts :: "extra control.* field -> {ok:false} (strict boundary)" (line 128, pass)`
- `tests/guards/invariants.test.ts :: "(d) FR-11: control.* frames are rejected at decodeClientMessage" (line 444, pass)`
- `tests/guards/fail-soft.test.ts :: "decodeClientMessage rejects malformed/truncated/wrong-v/control.* — no throw" (line 493, pass)`
- `tests/viewer/cli.test.ts :: "the only outbound frame is the handshake: no other socket write exists" (line 227, pass)`
- `tests/viewer/cli.test.ts :: "no viewer source contains a steering frame type" (line 239, pass)`
- `tests/viewer/cli.test.ts :: "keyFor maps every bound key to a declared read-only action" (line 94, pass)`

- manual: tests/guards/sabotage.md §(d) — sabotage red — relaxing the strict client schema to `.object()` makes a `control` field pass

### FR-12 — Fail-soft — never blocks an OMP turn; degrade to one notice · status: pass

- `tests/guards/fail-soft.test.ts :: "no pi.events → bus-unavailable notice; workers still discovered via artifact scan" (line 677, pass)`
- `tests/guards/fail-soft.test.ts :: "adapter death mid-transition: turn completes, one notice, roster intact" (line 759, pass)`
- `tests/guards/fail-soft.test.ts :: "circuit-break: adapter over a stalled socket degrades the topology with one notice" (line 633, pass)`
- `tests/guards/invariants.test.ts :: "(f) FR-12: handlers never throw when bridge + Herdr are dead" (line 486, pass)`
- `tests/extension/topology.test.ts :: "adapter failure degrades + notice, spawn signals still flow (P4-R11)" (line 431, pass)`
- `tests/viewer/render.test.ts :: "degraded and offline states are surfaced (FR-12, D1)" (line 170, pass)`

- manual: tests/guards/sabotage.md §(f) — sabotage red — an unguarded notice subscriber throws "dead bridge" into the handler

### FR-13 — No focus theft — every topology op is no-focus · status: pass

- `tests/guards/invariants.test.ts :: "(c) FR-13: every adapter create/split/run is no-focus; guard still throws" (line 388, pass)`
- `tests/extension/topology-herdr.test.ts :: "no-focus surface: topology never emits focus/ forbidden calls (P4-R5/R6 tamper)" (line 242, pass)`
- `tests/herdr/adapter.test.ts :: "sends tab.create with workspace_id, label, focus:false and env passthrough" (line 69, pass)`
- `tests/herdr/guards.test.ts :: "tab.create with focus:true throws (focus theft)" (line 29, pass)`
- `tests/herdr/adapter.test.ts :: "sends pane.split with target_pane_id, direction, focus:false, env passthrough" (line 111, pass)`

- manual: docs/analysis/clean-profile-install.md §3 — clean-profile run — focused workspace stayed `wN` before/during/after (live, not cross-workspace spawn)
- manual: docs/analysis/e2e-evidence.md §Manual-evidence steps — E2E step s5 (cross-workspace spawn focus) — LIVE-WITNESSED in owner-witnessed Run E 2026-11-25 (w19): spawn landed while focus on wN, 'focus stayed wN:t1 (wN)' (FR-13). Run E2 re-run env-coupled (OMP quota exhausted mid-run — spawn prompt never dispatched)

### FR-14 — Ownership invariants — view ops never spawn or remove workers · status: pass

- `tests/guards/invariants.test.ts :: "(a) FR-14: closing the overview and a split never removes the worker" (line 298, pass)`
- `tests/guards/invariants.test.ts :: "(b) FR-14: open/split/close/reopen never spawns a duplicate worker" (line 338, pass)`
- `tests/extension/topology.test.ts :: "onWorkerFinished drops the split binding only — never worker effects (P4-R8)" (line 390, pass)`
- `tests/extension/topology.test.ts :: "closing a split emits topology, never worker.removed (P4-R8/FR-14)" (line 404, pass)`

- manual: tests/guards/sabotage.md §(a)/§(b) — sabotage red — split-close → worker.removed and view-op re-spawn both fail the suite

### FR-15 — Reusable package — omp plugin link/install, humane README+docs · status: pass

- `tests/extension/resolve.test.ts :: "returns a runnable `bun <abs path to src/viewer/cli.ts>` invocation" (line 10, pass)`
- `tests/extension/resolve.test.ts :: "is independent of process.cwd()" (line 22, pass)`
- `tests/viewer/cli.test.ts :: "resolveViewerCommand resolves to the real cli.ts behind a runnable `bun` word" (line 85, pass)`
- `tests/extension/topology-herdr.test.ts :: "the production viewer command word is a runnable `bun <cli.ts>` invocation" (line 474, pass)`

- manual: docs/analysis/clean-profile-install.md §2–§3 — clean-profile `p6t7-clean` link + live delegation from `/private/tmp/p6t7-scratch`: viewer `[connected]`, argv rooted at installed package

### NFR-01 — Local-only — unix socket 0600/0700, no network, no secrets · status: pass

- `tests/guards/fail-soft.test.ts :: "bridge socket: 0600 unix socket inside a 0700 per-session dir; no TCP listener" (line 379, pass)`
- `tests/guards/fail-soft.test.ts :: "a second session in the same workspace binds a DISTINCT socket" (line 479, pass)`
- `tests/guards/fail-soft.test.ts :: "close() unlinks the socket and removes the per-session dir" (line 452, pass)`
- `tests/extension/history/guards.test.ts :: "scan under Bun.spawn/listen/connect/serve recorders: no spawn, no socket, no forbidden argv" (line 311, pass)`
- `tests/extension/history/guards.test.ts :: "scans the real history sources (non-vacuous: scan.ts is present)" (line 263, pass)`
- `tests/extension/bridge.test.ts :: "two bridges in the same session get unique socket paths" (line 407, pass)`

### NFR-02 — Version discipline — pin OMP 19.2.1 / Herdr 0.9.5, fail soft on drift · status: pass

- `tests/extension/observe-wiring.test.ts :: "absent pi.events degrades: one warn notice is broadcast after bridge start" (line 355, pass)`
- `tests/extension/roster.test.ts :: "unknown status keeps the last known status and emits a notice" (line 160, pass)`
- `tests/extension/observe/schemas.test.ts :: "tolerates extra event keys (message_end carries a message)" (line 109, pass)`
- `tests/guards/fail-soft.test.ts :: "per-call timeout defaults are 2s connect / 5s request (source pin)" (line 609, pass)`

- manual: docs/analysis/clean-profile-install.md §1 — installed `omp/19.2.1` (self-reported) + `herdr 0.9.5` == re-pinned spec — OI-1 + OI-4 resolved 2026-11-25 (owner approved re-pins 19.0.1 → 19.1.1 → 19.2.1)

### NFR-03 — Performance — coalesce ≤150 ms, bounded buffers, bounded tail · status: pass

- `tests/guards/perf-bounds.test.ts :: "100-frame burst emits exactly 1 coalesced upsert per 150ms window, latest-wins" (line 89, pass)`
- `tests/guards/perf-bounds.test.ts :: "50k frames through encode/decode/roster/viewer: bounded heap, bounded lines" (line 133, pass)`
- `tests/guards/perf-bounds.test.ts :: "50k decodes on a mixed junk corpus stays flat" (line 192, pass)`
- `tests/extension/bridge.test.ts :: "rapid progress changes coalesce into a single upsert carrying the latest state" (line 358, pass)`
- `tests/viewer/cli.test.ts :: "stamp-only upserts single-flight renders and keep last good text (P3-R11 bound)" (line 455, pass)`

- manual: .superpowers/sdd/2026-11-24-v1-hardening/progress.md (P6-4 completion line) — measured: 50k-frame heap delta 0.48MiB, junk 0.32MiB; 100-frame burst → 1 coalesced upsert

### NFR-04 — Safety — OMP sole owner; no agent start/report_agent; no focus:true · status: pass

- `tests/guards/herdr-source-scan.test.ts :: "no findings over real src/**/*.ts" (line 25, pass)`
- `tests/guards/herdr-source-scan.test.ts :: "every fixture produces at least one finding (no silent pass)" (line 169, pass)`
- `tests/guards/herdr-source-scan.test.ts :: "a guards.ts missing denylist entries is flagged (requireDenylist)" (line 207, pass)`
- `tests/herdr/guards.test.ts :: "String.fromCharCode composition cannot evade the denylist" (line 86, pass)`
- `tests/herdr/guards.test.ts :: "computed params keys cannot smuggle focus or tab_id" (line 91, pass)`
- `tests/extension/topology.test.ts :: "owned panes are reported with source, never as an agent (P4-R13)" (line 234, pass)`
- `tests/viewer/cli.test.ts :: "no viewer file calls any forbidden pane/agent API or imports the pane adapter" (line 203, pass)`
- `tests/guards/invariants.test.ts :: "(g) F-15: every pi.on / pi.events.on / command handler is synchronous" (line 520, pass)`

- manual: tests/guards/sabotage.md §(c)/§(g) — sabotage red — focus:true flips and async handlers both fail at the guarded boundary

### NFR-05 — Testability — reducer/protocol/adapter units + isolated-session integration + tamper-proven · status: pass

- `tests/guards/lifecycle-reconcile.test.ts :: "events_lost: exactly one live subscription, transparent resubscribe, snapshot reconcile, no duplicate viewer" (line 411, pass)`
- `tests/guards/shutdown.test.ts :: "session_shutdown is idempotent — a second emit stops nothing twice" (line 256, pass)`
- `tests/guards/fail-soft.test.ts :: "stalled (not refused) socket trips the request timeout; refused fails fast" (line 582, pass)`
- `tests/extension/history/restart.test.ts :: "new activation surfaces prior workers: not-live, transcript.ref, no spawn, no live copy" (line 164, pass)`

- manual: docs/analysis/e2e-evidence.md Run A — safe E2E `bash scripts/run-e2e.sh` → exit 0 (7 pass / 0 fail / 5 skipped), daily workspace byte-identical
- manual: tests/guards/sabotage.md — 7/7 invariant sabotage patches produced red suite output before revert

### NFR-06 — Docs reconcile — docs match shipped behavior exactly · status: pass
- manual: this report §Doc-vs-shipped checklist (DC-1..DC-21) — machine-asserted README/CONTRIBUTING/architecture sections contain shipped-truth content
- manual: README.md §Verified commands — every documented command executed 2026-11-26 at commit a994629, output quoted verbatim

## Safety-invariant sabotage proofs (P6-R2/R3)

Every tamper test is proven red by a deliberate source sabotage; each patch was applied, the
suite went red, the output was captured, and the patch was reverted. Verbatim red evidence:

| Invariant | Sabotage | Red evidence (verbatim) |
| --------- | -------- | --------------------- |
| (a) FR-14 — worker survives viewer close | `src/` patch in tests/guards/sabotage.md §a | error: expect(received).toHaveLength(expected) · (fail) P6-R2 invariant tamper tests > (a) FR-14: closing the overview and a split never removes the worker |
| (b) FR-14 — no duplicate worker spawned by any view operation | `src/` patch in tests/guards/sabotage.md §b | (fail) P6-R2 invariant tamper tests > (b) FR-14: open/split/close/reopen never spawns a duplicate worker [682.85ms] · (fail) P6-R2 invariant tamper tests > (b) FR-14: open/split/close/reopen never spawns a duplicate work |
| (c) FR-13 — no focus theft across open/split/reopen | `src/` patch in tests/guards/sabotage.md §c | HerdrForbiddenError: forbidden herdr request: tab.create with focus:true (adapter is no-focus) · (fail) P6-R2 invariant tamper tests > (c) FR-13: every adapter create/split/run is no-focus; guard still throws |
| (d) FR-11 — `control.*` frames rejected at the handshake boundary | `src/` patch in tests/guards/sabotage.md §d | error: expect(received).toBe(expected) · (fail) P6-R2 invariant tamper tests > (d) FR-11: control.* frames are rejected at decodeClientMessage |
| (e) FR-01 — extension is a no-op outside Herdr | `src/` patch in tests/guards/sabotage.md §e | error: expect(received).toBe(expected) · (fail) P6-R2 invariant tamper tests > (e) FR-01: HERDR_ENV unset — extension registers nothing, activates nothing |
| (f) FR-12 — OMP turn completes with Herdr/bridge dead | `src/` patch in tests/guards/sabotage.md §f | error: expect(received).not.toThrow() · (fail) P6-R2 invariant tamper tests > (f) FR-12: handlers never throw when bridge + Herdr are dead |
| (g) F-15 — all `pi.on` / `pi.events.on` handlers enqueue synchronously, never await I/O | `src/` patch in tests/guards/sabotage.md §g | error: expect(received).toBeUndefined() · (fail) P6-R2 invariant tamper tests > (g) F-15: every pi.on / pi.events.on / command handler is synchronous |

Clean restore: `git diff -- src/` empty; clean re-run `7 pass, 0 fail, 83 expect() calls` (parsed from tests/guards/sabotage.md).

## Live / witnessed captures (index)

| Capture | What it shows |
| ------- | ------------- |
| session `01a210e2-5995-74b7-99d0-1acf4182b855` (pane `wN:p4`) — docs/analysis/phase-0-caveat-closure.md §Caveat 1 | interactive-TUI witness: overview auto-opened, viewer `[connected]`, live worker rendered; closes U-OMP-1 |
| clean profile `p6t7-clean`, workspace `w11`, cwd `/private/tmp/p6t7-scratch` — docs/analysis/clean-profile-install.md §3 | plugin-link install + first delegation: tab `w11:t2 "OMP subagents"` (`w11:p2`), viewer `[connected]`, focus stayed `wN` |
| probe `/tmp/lens-probe-a-out/frames.jsonl` — caveat-closure §Caveat 2 | `aborted` triggered live; raw lifecycle/progress frames captured |
| probe `/tmp/lens-probe-q-out/frames.jsonl` — caveat-closure §Caveat 2 | two-agent batch; no `queued` frame anywhere in the 80-frame capture |
| `bash scripts/run-e2e.sh` safe run — docs/analysis/e2e-evidence.md Run A | disposable `lens-e2e-*` round-trip, daily workspace byte-identical before/after |

## Doc-vs-shipped checklist (P6-R10 / NFR-06)

| Check | Doc | Assertion | Result |
| ----- | --- | --------- | ------ |
| DC-1 | `README.md` | v1 read-only is stated | ✓ |
| DC-2 | `README.md` | scope is direct workers only | ✓ |
| DC-3 | `README.md` | reopen-on-next-subtask semantics | ✓ |
| DC-4 | `README.md` | degraded-mode behavior documented | ✓ |
| DC-5 | `README.md` | history caveat R-04 recorded | ✓ |
| DC-6 | `README.md` | spec pin recorded (re-pinned to 19.2.1 per OI-4) | ✓ |
| DC-7 | `README.md` | re-pin provenance from the earlier 19.0.1 pin recorded | ✓ |
| DC-8 | `README.md` | Herdr version recorded | ✓ |
| DC-9 | `README.md` | worker split command documented | ✓ |
| DC-10 | `README.md` | recorded-limitations section exists | ✓ |
| DC-11 | `README.md` | install command documented | ✓ |
| DC-12 | `README.md` | overview tab name shipped-truth | ✓ |
| DC-13 | `README.md` | untriggered transitions recorded | ✓ |
| DC-14 | `README.md` | no worker control boundary stated | ✓ |
| DC-15 | `CONTRIBUTING.md` | DoD regeneration documented | ✓ |
| DC-16 | `CONTRIBUTING.md` | E2E command documented | ✓ |
| DC-17 | `CONTRIBUTING.md` | tamper-discipline documented | ✓ |
| DC-18 | `docs/architecture.md` | socket mode documented | ✓ |
| DC-19 | `docs/architecture.md` | viewer env handoff documented | ✓ |
| DC-20 | `docs/architecture.md` | degraded-mode behavior documented | ✓ |
| DC-21 | `docs/architecture.md` | subscribe-before-create documented | ✓ |

## Known limitations (recorded, not skipped)

- `queued` not emitted by a parallel two-agent `task` batch on v19.1.1; no reachable trigger — _source: docs/analysis/phase-0-caveat-closure.md §Recorded limitations 1_
- `idle` / `parked` have no deterministic trigger in print-mode `task` usage on this build — _source: docs/analysis/phase-0-caveat-closure.md §Recorded limitations 2_
- `detached` semantics for TUI async spawns is unverified (field `optional()`, unconsumed — harmless but unverified) — _source: docs/analysis/phase-0-caveat-closure.md §Recorded limitations 3_
- pre-activation workers are not observed — no registry snapshot exists for extensions (U-OMP-5) — _source: docs/analysis/phase-0-caveat-closure.md §U-OMP unknowns_
- history caveat (R-04): live `counters` are not reconstructable from persisted JSONL — historical rows show `counters` absent + not-live badge — _source: docs/superpowers/specs/2026-11-19-herdr-omp-lens-design.md §12 R-04_
- v1.2 (owner UX decision 2026-11-25): finished rows persist after reap (FR-08 amended) — the old transient-collapse limitation is superseded; rows reaped without a terminal upsert demote to [not-live] history — _source: docs/superpowers/specs/2026-11-19-herdr-omp-lens-design.md §5 FR-08 (v1.2 amendment)_
- Herdr-restart viewer-layout restore is out of scope for v1 (v2 horizon) — _source: docs/plans/00-master-plan.md §2 v2 horizon_
- spec re-pinned 19.0.1 → 19.1.1 (OI-1) → 19.2.1 (OI-4), owner decisions 2026-11-25: installed binary upgraded to 19.2.1; earlier evidence stays version-stamped (19.1.1); observed bus shapes unchanged from the 19.0.1 Phase-0 probe; pi-tui/pi-wire pinned to the same 19.2.1 — _source: docs/analysis/clean-profile-install.md §1_
- E2E live steps s3–s5 (/lens split, restart→history, cross-workspace focus) remain manual after owner-witnessed Run D 2026-11-25 — env-coupled: s3 pane-get JSON EOF flake; s4 local-build session-bind gap → viewer-reconnect timeout; s5 spawn-lands timeout (correlated). s1/s2 live-proven in Run D (w17) — _source: docs/analysis/e2e-evidence.md §Manual-evidence steps_

## Open items for owner decision (P6-R11)

| ID | Item | Owner action | Source |
| -- | ---- | ------------ | ------ |
| OI-1 | Version drift — installed OMP 19.1.1 vs spec pin 19.0.1 | RESOLVED 2026-11-25 — owner approved re-pin to 19.1.1; forward-looking pins moved, evidence stays valid (produced on the now-pinned version) | docs/analysis/clean-profile-install.md §1; .superpowers/sdd/2026-11-24-v1-hardening/progress.md (P6-5 OPEN OWNER DECISION) |
| OI-4 | Version drift — installed OMP upgraded 19.1.1 → 19.2.1 (2026-11-25) vs spec pin 19.1.1 | RESOLVED 2026-11-25 — owner approved re-pin to 19.2.1 (matches the pi-tui/pi-wire pin = the TUI library the installed OMP embeds); forward-looking pins moved, earlier evidence stays version-stamped on 19.1.1 | docs/analysis/clean-profile-install.md §1 (OI-4 addendum) |
| OI-2 | E2E live lifecycle steps s2–s5 (close→reopen, /lens split, restart→history, cross-workspace focus) | PARTIALLY RESOLVED 2026-11-25 — owner-witnessed Runs D/E/E2 + Part A live-proved s1/s2/s3/s5 (FR-05 + FR-06 + FR-13 cleared); Run G (v1.1 installed build) re-proved s1/s2 + all TUI token assertions, its s3/s5/s4 blocked by an env-coupled SIGHUP agent death mid-run (evidence §Run G); s4 local-build bind gap remains (FR-09, post-v1 ticket) — rerun `RUN_E2E_LIVE=1 bash scripts/run-e2e.sh` with the Herdr session idle, or convert to recorded limitations at sign-off | docs/analysis/e2e-evidence.md §Manual-evidence steps; progress.md (P6-6 CONDITION) |
| OI-3 | Deferred review minors (non-blocking follow-ups from P6 reviews) | triage at final review; each already has a sibling assertion or bounded failure mode | progress.md deferred-minor lines: invariants (f) h.errors check; scan-herdr-calls errorCtx exemption; e2e unbounded `herdr --version` preflight + stale pre-restart ids; clean-profile scratch teardown; P5 roll-up minors |

## Sign-off (owner only)

DoD-v1 acceptance. The agent prepared this pack; **the owner records the decision — never the agent.**
Signing off means: every `pass` row accepted, every `manual-evidence` row's pending witness
either witnessed or converted to a recorded limitation, and OI-1..OI-4 resolved or deferred.

| Date | Owner | Decision | Notes | Signature |
| ---- | ----- | -------- | ----- | --------- |
| _unsigned_ | | | | |

**Status: UNSIGNED** — awaiting owner sign-off before any v2 work begins.

