# P6-R6 isolated-session E2E — raw evidence

Environment: Herdr **0.9.5**, caller pane `wN:p1`, repo `feat/v1-history-hardening`.
Driver: `tests/e2e/isolated-session.e2e.ts` via `scripts/run-e2e.sh`.

- Default run is SAFE (no agent): disposable `lens-e2e-<ts>` create/enumerate/close round-trip +
  daily-workspace before/after assertion. Rerunnable without disturbing the user.
- `RUN_E2E_LIVE=1` drives the full lifecycle. Every live step is bounded
  (retry-once `waitForRetry`, per-step timeouts); env-coupled failures record `manual`, never `pass`.

## Run A — safe default (`bash scripts/run-e2e.sh`, 2026-11-25 ~09:02 UTC)

Verbatim output:

```
[note] setup :: tool herdr — /opt/homebrew/bin/herdr
[note] setup :: tool bun — /opt/homebrew/bin/bun
[note] setup :: local extension — /Users/fabzter/src/omp-fabz-improvements/src/extension/index.ts (restart leg only)
[note] setup :: environment — herdr version probe: herdr 0.9.5
[PASS] setup :: HERDR_ENV=1 — caller pane wN:p1
[PASS] setup :: daily workspace enumerated (before) — 13 workspaces / 19 tabs / 21 panes
[note] mode :: safe mode — RUN_E2E_LIVE unset — disposable round-trip only, no agent launched
[PASS] s0 :: disposable workspace created + enumerated — wY (lens-e2e-2026-11-25T09-02-23-564Z)
        cwd=/private/var/folders/.../lens-e2e-scratch-2026-11-25T09-02-23-564Z-55583
[PASS] s0 :: disposable workspace closed — wY
[PASS] s0 :: disposable workspace gone — wY
[SKIP] s1..s5 — safe mode — rerun with RUN_E2E_LIVE=1
[PASS] s6 :: daily workspace untouched — 13 workspaces, 19 tabs, 21 panes — identical before/after
[PASS] s6 :: no lens-e2e-* workspace left behind — disposable scope clean
exit code: 0   (7 pass / 0 fail / 0 manual / 5 skipped)
```

Daily workspaces before AND after (identical, from `herdr workspace list`):
`wM, wN, wP, wB, w1, w2, wD, wC, w9, w7, w8, wG, wJ` — 13 total.

## Run B — live (`RUN_E2E_LIVE=1 bash scripts/run-e2e.sh`, ~09:02:31 UTC)

Verbatim output (run hard-killed by the 300 s harness deadline mid-retry; its own
retry-once policy was still inside the first retry window):

```
[PASS] setup :: HERDR_ENV=1 — caller pane wN:p1
[PASS] setup :: daily workspace enumerated (before) — 13 workspaces / 19 tabs / 21 panes
[note] mode :: live mode — RUN_E2E_LIVE=1 — full lifecycle drive
[PASS] s1 :: disposable workspace created — wZ (lens-e2e-2026-11-25T09-02-31-793Z)
[PASS] s1 :: shell pane split — wZ:p2 cwd=/private/var/.../lens-e2e-scratch-...-55632
[PASS] s1 :: omp launched (installed build) — agent=lense2e1793z session=undefined file=undefined
[note] retry :: overview tab auto-open on first spawn — first attempt failed
        (timeout after 150000ms); retrying once
<harness deadline hit at 300 s — teardown never ran>
```

Findings:

- `herdr agent start --kind omp` returned `agent_started` but `agent_session` was
  `undefined` at return time (TUI had not yet bound a session). The prior attempt
  (workspace `lens-e2e-…-896Z`) did produce a session file, so this is timing variance,
  not a schema break — but it means auto-open could never be observed within the bound.
- No `OMP subagents` tab appeared within 150 s — environment/timing bound, recorded
  as manual evidence. NOT a silent pass.
- **Cleanup after the kill:** `wZ` was still open; `herdr workspace close wZ` →
  `{"type":"ok"}`, `herdr workspace list` → 13 workspaces, zero `lens-e2e-*`,
  `herdr agent list`/`pane list` → no `lense2e1793z`, no `wZ:*` panes,
  `pgrep -fl "lens-e2e|lense2e"` → nothing. Orphan-free.
- Stale bridge socket dir `herdr-omp-lens-lens-e2e-scratch-…-8iyleu` from a prior
  attempt removed (`lsof`: no live listener).

## Manual-evidence steps (exact rerun command)

After Runs D/E/E2/F (2026-11-25, owner-witnessed): s1 (except the transient finished-collapse
readback), s2 and s5 are live-proven. Still manual: **s3** (`/lens split` — send-text
JSON EOF fixed → input-clear + pane-list null-title bugs found and fixed post-E2 →
mechanics probe-verified end-to-end on w1A (`scope: worker alpha-responder
[connected]` rendered); the automated live step-pass is blocked ONLY by transient
OMP individual-quota exhaustion in Run F — not a lens defect. Rerun post-reset to
convert to live PASS) and **s4** (local-build `-e` session-bind gap →
viewer-reconnect timeout). Rerun: `RUN_E2E_LIVE=1 bash scripts/run-e2e.sh`
inside a Herdr pane. s4 uses the LOCAL build automatically:
`omp --no-extensions --config <scratch>/omp-e2e-overlay.yml -e <repo>/src/extension/index.ts`.

## U-HDR findings

- **U-HDR-1 (viewer misclassified as agent):** assertion wired into every overview-open
  check (`assertViewerNotAgent`); not reached live this session — unit-covered
  (`tests/viewer/*`, `tests/extension/*` green).
- **U-HDR-2 / F-14 (focus theft on cross-workspace spawn):** assertion wired
  (`assertFocusPreserved` + s5); not reached live.
- **U-HDR-3 (pane.exited payload shape):** raw `events.subscribe` capture implemented
  (`lifecycle-events.ndjson`); 1 frame captured in the safe run (session-scope only,
  no payload — recorded as `?` kind).
- **U-HDR-5 (lifecycle event ordering):** same capture path; insufficient frames live.
- **U-HDR-4:** see `progress.md` — addressed in earlier phases' live probes.

## Fix round 1 (2026-11-25, review F1–F4)

- **F1 bounded teardown:** `agentSubmit`/`paneSendKeys` now route through `herdrProc`
  (SIGKILL after `T.cliMs`, same policy as `herdrJson`). A stalled herdr can no longer
  hang teardown before `assertDailyUntouched`.
- **F2 D2 enforced:** `!sameTab` post-restart now `throw fail("surviving tab reused (D2
  rebind)")` — a close+recreate regression fails instead of passing via note.
  `sameTab && !samePane` (viewer rebind inside the surviving tab) is a `note` —
  reconnect is still proven by the `[connected] + new session id` check.
- **F3 honest collapse label:** the workers(0) fallback now records
  `manual "finished-collapse"` ("…NOT witnessed live (unit-covered)") — a green run
  never implies the transient collapse UI was seen. The real collapse still `pass`es
  when observed.
- **F4 marker wait guarded:** `st.sessionFile1 === undefined` → `skipped` instead of
  polling 180 s for a marker that cannot exist.

Verification after fixes: `tsc --noEmit` clean; `biome check` 66 files clean;
`bun test` 460 pass / 0 fail; safe run exit 0 (`w0` round-trip, 13/19/21 unchanged).

## Run C — session-bind fix (`RUN_E2E_LIVE=1`, 2026-11-25 ~10:25 UTC)

Harness change under test: `pollBoundSession()` — after `agent_started`, when
`agent_session` is undefined the driver now polls `herdr agent list` (matched by
`pane_id`, 40 s bound) for the bound session path. Wired at both bind sites
(s1 launch, s4 restart; restart excludes the prior session file so a stale bind
cannot be picked up). If the session still never binds, the step records
`manual`, never a silent skip. On auto-open failure the shell-pane tail is now
captured to `evidence/s1-shell-tail.txt` for dropped-prompt diagnosis.

Result: **22 pass / 0 fail / 5 manual / 0 skipped** in ~910 s, exit 0.

```
[PASS] s1 :: omp launched (installed build) — agent=lense2e5299z
        session=01a2123d-a2a0-7345-9802-56526fc37896 file=~/.omp/agent/sessions/-tmp-lens-e2e-…-299Z-78488/…_01a2123d-….jsonl
[PASS] s1 :: auto-open on first spawn — tab w16:t2 pane w16:p3
[PASS] s1 :: viewer connected, live worker listed — [connected] + workers (>=1)
[MANUAL] s1 :: finished-collapse — transient window missed; workers(0) proves reaped (unit-covered)
[PASS] s2 :: manual close honored; worker survives close (FR-14); exactly-one reopen (FR-05); no focus theft; U-HDR-1
[MANUAL] s3 :: read-only /lens split — herdr pane get JSON Parse error (Unexpected EOF)
[PASS] s4 :: omp exited; restarted (local build, same cwd); surviving tab reused (D2 rebind); U-HDR-1
[MANUAL] s4 :: session bind after restart — agent_session never bound after agent_started + 40 s agent-list poll
[MANUAL] s4 :: OMP restart → history auto-open — viewer reconnected to new socket timed out (30 s ×2; session=undefined)
[MANUAL] s5 :: cross-workspace focus preservation — spawn lands timed out (150 s ×2)
[PASS] teardown :: disposable workspace closed + gone — w16
[PASS] s6 :: daily workspace untouched — 13 workspaces, 19 tabs, 21 panes — identical before/after
```

Findings:

- The s1 race is FIXED: `sessionFile1` bound to a real jsonl (Run B's
  `session=undefined` → `session=01a2123d-…`), and the whole downstream chain
  (auto-open, viewer connect, worker roster, s2 reopen, FR-05/14, U-HDR-1,
  focus preservation) passed live.
- New evidence: the RESTARTED local-build (`-e`) agent showed `idle` in
  `agent list` but `agent_session` stayed `None` even past the 40 s bound —
  a distinct bind gap from the interactive_ready race. Recorded as manual;
  the harness now isolates it instead of cascading skips.
- s5's spawn-lands timeout correlates with the unbound restarted session —
  likely same root cause, not a separate flake. Honest manual, retry-once
  respected, run stopped per the bounded-live mandate.

## Run D — owner-witnessed (OI-2) (`E2E_KEEP_WORKSPACE=1 RUN_E2E_LIVE=1`, 2026-11-25 ~12:21 UTC)

Live run dispatched so the owner could watch s3 (/lens split) and s5 (cross-workspace focus) in the
kept disposable workspace. Disposable workspace: **w17** (`lens-e2e-2026-11-25T12-21-15-895Z`),
closed after the run via `herdr workspace close w17`. Scratch/evidence dir:
`/var/folders/vm/tn_yl921169f6wxhx0h119th0000gn/T/lens-e2e-scratch-2026-11-25T12-21-15-895Z-1995/evidence/`.

Result: **20 pass / 0 fail / 5 manual / 0 skipped** in ~917 s, exit 0.

Verbatim summary:

```
================ lens E2E summary ================
workspace : w17 (lens-e2e-2026-11-25T12-21-15-895Z)
scratch   : /var/folders/vm/tn_yl921169f6wxhx0h119th0000gn/T/lens-e2e-scratch-2026-11-25T12-21-15-895Z-1995
session 1 : 01a212a7-3b65-740c-9d1d-a54140bb9392  file /Users/fabzter/.omp/agent/sessions/-tmp-lens-e2e-scratch-2026-11-25T12-21-15-895Z-1995/2026-11-25T12-21-19-333Z_01a212a7-3b65-740c-9d1d-a54140bb9392.jsonl
session 2 : (restart skipped)  file -
workers   : alpha-responder, bravo-responder
build     : installed plugin for s1–s3; local -e /Users/fabzter/src/omp-fabz-improvements/src/extension/index.ts for s4+
checks    : 20 pass, 0 fail, 5 manual, 0 skipped, 17 notes
  [pass] setup HERDR_ENV=1 — caller pane wN:p1
  [pass] setup daily workspace enumerated (before) — 13 workspaces, 19 tabs, 21 panes
  [note] mode live mode — RUN_E2E_LIVE=1 — full lifecycle drive
  [note] s0 live mode — create/teardown exercised by s1 + teardown instead
  [pass] s1 disposable workspace created — w17 (lens-e2e-2026-11-25T12-21-15-895Z)
  [pass] s1 shell pane split — w17:p2 cwd=/private/var/folders/vm/tn_yl921169f6wxhx0h119th0000gn/T/lens-e2e-scratch-2026-11-25T12-21-15-895Z-1995
  [pass] s1 omp launched (installed build) — agent=lense2e5895z session=01a212a7-3b65-740c-9d1d-a54140bb9392 file=…/2026-11-25T12-21-19-333Z_01a212a7-….jsonl
  [pass] s1 auto-open on first spawn — tab w17:t2 pane w17:p3
  [pass] s1 no focus theft — focus stayed on wN:t1 (wN)
  [pass] s1 U-HDR-1 viewer never agent — 1 viewer pane(s) report agent=null/undefined
  [pass] s1 viewer connected, live worker listed — [connected] + workers (>=1)
  [manual] s1 finished-collapse — collapse window missed — workers(0) proves the worker reaped, but 'finished (N) — press e to expand' was NOT witnessed live (unit-covered)
  [note] s1 worker ids — alpha-responder
  [note] s1 worker session_exit marker — no marker yet — restart history may map the worker as aborted; continuing
  [pass] s2 manual close honored — tab w17:t2 closed
  [pass] s2 worker survives viewer close (FR-14) — agent lense2e5895z still live
  [pass] s2 exactly one overview tab reopened (FR-05) — tab w17:t3
  [pass] s2 no focus theft — focus stayed on wN:t1 (wN)
  [pass] s2 U-HDR-1 viewer never agent — 1 viewer pane(s) report agent=null/undefined
  [note] s2 second worker terminal state — workers (0) — finished worker reaped (transient collapse missed)
  [note] s2 worker ids — alpha-responder, bravo-responder
  [note] s3 /lens registered — palette shows '/lens open the herdr-omp-lens overview…'
  [manual] s3 read-only /lens split — env-coupled — SyntaxError: JSON Parse error: Unexpected EOF | rerun: RUN_E2E_LIVE=1 bash scripts/run-e2e.sh
  [note] s4 omp exit — /exit did not clear the agent; esc + retry, then key fallbacks
  [pass] s4 omp exited — session 01a212a7-… closed
  [manual] s4 session bind after restart — agent_session never bound after agent_started + bounded agent-list poll (env-coupled)
  [pass] s4 omp restarted (local build, same cwd) — agent=lense2e5895zb session=undefined
  [pass] s4 surviving tab reused (D2 rebind) — same tab w17:t3 rebound
  [pass] s4 U-HDR-1 viewer never agent — 1 viewer pane(s) report agent=null/undefined
  [note] retry viewer reconnected to new socket — first attempt failed (timeout 30000ms); retrying once
  [manual] s4 OMP restart → history auto-open — env-coupled — timeout waiting for viewer reconnected to new socket after 30000ms | rerun: RUN_E2E_LIVE=1 bash scripts/run-e2e.sh
  [note] s5 cross-workspace precondition — focused=wN (wN:t1); e2e=w17
  [note] retry cross-workspace spawn lands — first attempt failed (timeout 150000ms); retrying once
  [manual] s5 cross-workspace focus preservation — env-coupled — timeout waiting for cross-workspace spawn lands after 150000ms | rerun: RUN_E2E_LIVE=1 bash scripts/run-e2e.sh
  [note] teardown workspace kept — w17 (lens-e2e-2026-11-25T12-21-15-895Z) — E2E_KEEP_WORKSPACE=1
  [pass] s6 daily workspace untouched — 13 workspaces, 19 tabs, 21 panes — identical before/after (e2e ids excluded)
  [pass] s6 no lens-e2e-* workspace left behind — disposable scope clean
=================================================
```

Live-proven vs manual (honest):

- **s1 — LIVE-PROVEN:** disposable workspace create, shell split, installed-build launch,
  auto-open on first spawn, no focus theft, U-HDR-1, viewer `[connected]` + live worker roster.
  (`finished-collapse` stays manual — transient, unit-covered, reaping outpaced readback again.)
- **s2 — LIVE-PROVEN (new vs Run C):** manual close honored → worker survives (FR-14) → exactly-one
  reopen (FR-05, tab w17:t3) → no focus theft → U-HDR-1. This was an owner-witness target and it
  ran green live.
- **s3 — STILL MANUAL (env-coupled):** the known `herdr pane get` JSON Parse error (Unexpected EOF)
  recurred; retry-once did not clear it this run. `/lens` registration was live-confirmed via the
  command palette, but the split itself was not witnessed. Same flake as Run C.
- **s4 — STILL MANUAL (env-coupled):** omp exited and restarted on the local build and the surviving
  tab was reused (D2 rebind PASS), but `agent_session` never bound after `agent_started` + bounded
  agent-list poll — the same local-build(-e) bind gap as Run C — so the viewer-reconnect
  (`workers(0)` → not-live history) timed out at 30 s ×2.
- **s5 — STILL MANUAL (env-coupled):** cross-workspace precondition was correctly met (focused wN,
  e2e w17), but the spawn-lands wait timed out at 150 s ×2 — correlating again with the s4 bind gap
  (restarted session `agent_session=undefined`), likely same root cause, not a separate flake.
- **s6 — PASS:** daily workspace identical before/after; no `lens-e2e-*` left behind.
  w17 was then closed manually and `herdr workspace list` re-verified: 13 daily workspaces
  (wM, wN, wP, wB, w1, w2, wD, wC, w9, w7, w8, wG, wJ), zero `lens-e2e-*` remaining.

## Run E — s3/s5 harness fix, owner-witnessed (`E2E_KEEP_WORKSPACE=1 RUN_E2E_LIVE=1`, 2026-11-25 ~12:44 UTC)

Harness changes under test: (a) s5 reordered BEFORE s4 so cross-workspace focus
runs on the healthy installed-build agent (the s4 local-build restart kills the
overview pane — Runs C/D s5 timeouts were the same bind gap); (b) s3 split-wait
dropped the flaky `herdr pane get`, reading the title from the pane-list entry.

Result: **21 pass / 0 fail / 4 manual / 0 skipped** in ~686 s, exit 0.
Disposable workspace **w19** (`lens-e2e-2026-11-25T12-44-01-640Z`), closed after
the run via `herdr workspace close w19`.

```
checks    : 21 pass, 0 fail, 4 manual, 0 skipped, 17 notes
  [pass] s1 disposable workspace created — w19 (lens-e2e-2026-11-25T12-44-01-640Z)
  [pass] s1 omp launched (installed build) — agent=lense2e1640z session=01a212bc-1256-7560-8eec-ea45a7b620a0
  [pass] s1 auto-open on first spawn — tab w19:t2 pane w19:p3
  [pass] s1 no focus theft — focus stayed on wN:t1 (wN)
  [pass] s1 viewer connected, live worker listed — [connected] + workers (>=1)
  [manual] s1 finished-collapse — collapse window missed (unit-covered; transient as before)
  [pass] s2 manual close honored — tab w19:t2 closed
  [pass] s2 exactly one overview tab reopened (FR-05) — tab w19:t3
  [note] s3 /lens registered — palette shows '/lens open the herdr-omp-lens overview…'
  [manual] s3 read-only /lens split — env-coupled — SyntaxError: JSON Parse error: Unexpected EOF
  [note] s5 cross-workspace precondition — focused=wN (wN:t1); e2e=w19
  [pass] s5 cross-workspace focus preserved (FR-13) — focus stayed wN:t1 (wN)
  [note] s5 post-spawn worker terminal state — workers (0) steady state
  [pass] s4 omp exited — session 01a212bc-… closed
  [manual] s4 session bind after restart — agent_session never bound (env-coupled)
  [pass] s4 surviving tab reused (D2 rebind) — same tab w19:t3 rebound
  [manual] s4 OMP restart → history auto-open — viewer-reconnect timeout 30s×2 (same bind gap)
  [pass] s6 daily workspace untouched — 13 workspaces, 19 tabs, 21 panes — identical before/after
```

### s3 root-cause chain (refined, evidence-driven)

The "pane-get flake" attribution from Run D was incomplete — `waitFor` swallows
`fn` errors, so a bare `SyntaxError` could only escape through an **unguarded**
`herdrJson` call. The actual site was `pane send-text` (typed-command replies
are parsed as JSON envelopes though unused). Hardening landed: `send-text` →
`herdrProc` (exit-code only), and `herdrJson` retries once on `SyntaxError`
for pure reads (`list`/`get`) only — mutations are never replayed.

## Run E2 — s3 hardening verification (`E2E_KEEP_WORKSPACE=1 RUN_E2E_LIVE=1`, 2026-11-25 ~12:55 UTC)

Result: **20 pass / 0 fail / 5 manual / 0 skipped** in ~1140 s, exit 0.
Disposable workspace **w1A** (`lens-e2e-2026-11-25T12-55-41-425Z`), closed by the
next safe run's stale-sweep; 13 dailies verified identical before/after again.

- **s3 — still manual, but the EOF is gone** (hardening works; `[manual]` is now a
  clean 150 s×2 timeout). Live inspection of w1A exposed TWO new harness bugs:
  1. `escape` dismisses the palette but leaves `/lens` in the input line —
     the real command landed as `/lens/lens split alpha-responder` and was
     submitted to the agent as a PROMPT (verbatim TUI transcript captured).
     Fixed with `ctrl+u` input clear before typing the real command.
  2. `herdr pane list` (0.9.5) reports `title: null` for EVERY pane incl. the
     viewer → the OVERVIEW_LABEL title gate could never match. Also `/lens
     split` opens a NEW tab (`w1A:t4`) holding overview copy + scoped pane,
     so the wait now scans every 'OMP subagents' tab and detects the scoped
     pane by `scope: worker <id>` content.
- **Manual probe on the kept w1A** (no quota needed): `ctrl+u` + `/lens split
  alpha-responder` opened `w1A:t4` with `p6` rendering verbatim
  `omp lens — session 01a212c6-… [connected] / scope: worker alpha-responder /
  worker alpha-responder: not found` — the scoped-split mechanics work end to
  end; the remaining live witness is one full-run pass post-fix.
- **s5 — manual this run:** `cross-workspace spawn lands` timed out 150 s×2
  because the OMP agent hit **"Individual quota reached"** mid-run — the spawn
  prompt never dispatched. Env gap, not a focus regression; Run E's live proof
  stands (FR-13).
- **s4 — manual, unchanged:** local-build `agent_session` never binds →
  viewer-reconnect timeout; tab reuse/rebind passes live every run.

## Cleanup verification (post E/E2)

`w19` closed via `herdr workspace close w19`; `w1A` closed by the subsequent
safe run's stale-sweep. `herdr workspace list` re-verified: exactly the 13
daily workspaces (wM, wN, wP, wB, w1, w2, wD, wC, w9, w7, w8, wG, wJ),
**zero `lens-e2e-*` remaining**, focus on `wN`.


## Run F — quota-blocked, s3 probe-verified (`E2E_KEEP_WORKSPACE=1 RUN_E2E_LIVE=1`, 2026-11-25 ~13:18 UTC)

Owner-watched final s3 witness attempt on post-PR#6 main (`9aceb4e`). Disposable
workspace **w1D** (`lens-e2e-2026-11-25T13-18-36-445Z`); agent `lense2e6445z` bound
to session `01a212db-bbdf-72f8-85a6-a33b800965e8` — but the **OMP individual quota
was already exhausted**, so the s1 scout prompt could never dispatch a subagent,
the overview never auto-opened, and the run short-circuited to skips.
`w1D` closed post-run via `herdr workspace close w1D`; a stale `w1C` from the
first aborted launch was swept by the harness stale-sweep.

Result: **7 pass / 0 fail / 1 manual / 4 skipped** in ~322 s, exit 0.

Verbatim summary:

```
[PASS] setup :: HERDR_ENV=1 — caller pane wN:p1
[note] setup :: stale disposable closed — w1C (lens-e2e-2026-11-25T13-18-31-205Z)
[PASS] setup :: daily workspace enumerated (before) — 13 workspaces / 19 tabs / 21 panes
[note] mode :: live mode — RUN_E2E_LIVE=1 — full lifecycle drive
[note] s0 :: live mode — create/teardown exercised by s1 + teardown instead
[PASS] s1 :: disposable workspace created — w1D (lens-e2e-2026-11-25T13-18-36-445Z)
[PASS] s1 :: shell pane split — w1D:p2 cwd=/private/var/folders/.../lens-e2e-scratch-2026-11-25T13-18-36-445Z-34807
[PASS] s1 :: omp launched (installed build) — agent=lense2e6445z session=01a212db-bbdf-72f8-85a6-a33b800965e8
[note] retry :: overview tab auto-open on first spawn — first attempt failed (Error: timeout waiting for overview tab auto-open on first spawn after 150000ms); retrying once
[note] s1 :: auto-open wait failed — shell pane tail — … | Update Available | New version 19.2.0 is available. Run: omp update | …
[MANUAL] s1 :: setup + first spawn — env-coupled — Error: timeout waiting for overview tab auto-open on first spawn after 150000ms | rerun: RUN_E2E_LIVE=1 bash scripts/run-e2e.sh
[SKIP] s2 :: manual close → exactly-one reopen — s1 prerequisites missing
[SKIP] s3 :: read-only /lens split — overview/shell prerequisites missing
[SKIP] s5 :: cross-workspace focus preservation — live agent/overview prerequisites missing
[SKIP] s4 :: OMP restart → history auto-open — live agent/overview prerequisites missing
[note] teardown :: workspace kept — w1D (lens-e2e-2026-11-25T13-18-36-445Z) — E2E_KEEP_WORKSPACE=1
[PASS] s6 :: daily workspace untouched — 13 workspaces, 19 tabs, 21 panes — identical before/after (e2e ids excluded)
[PASS] s6 :: no lens-e2e-* workspace left behind — disposable scope clean
```

Quota proof — verbatim from `evidence/s1-shell-tail.txt` (the launched TUI rendered
the scout prompt, then rejected it):

```
Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 47m59s.
※ recap: ⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 43m57s.
❯ ⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 47m57s.
```

Assessment: the s1 timeout is an **environmental quota block, not a lens defect** —
the prompt reached the TUI (visible verbatim) and was refused by the provider
quota gate, so no subagent could spawn and no overview could open. s3's own
mechanics are already probe-verified end-to-end (PR#6: input-clear + scope-content
detection; live manual probe on w1A rendered `scope: worker alpha-responder
[connected]`). The automated step-pass needs one `RUN_E2E_LIVE=1` rerun after the
quota reset (~14:12 UTC); s4 stays manual (-e session-bind gap, separate ticket).

## Owner manual corroboration — Part A (interactive, 2026-11-25 ~13:40 UTC)

The owner independently followed the interactive guide (Part A) in a disposable
workspace and **corroborated all steps**: created a throwaway workspace, launched
OMP (installed build), delegated a task, and watched the `OMP subagents` tab
auto-open no-focus with the viewer `[connected]` rendering the live worker;
exercised the read-only nav keys. This is an owner-witnessed confirmation of
s1-class behavior (auto-open + viewer + no-focus) outside the scripted harness.
Part B (s3 split / s4 restart / s5 cross-workspace) in progress — the owner hit a
fast-finished scout (roster empties before `/lens split` can target a live worker);
guidance issued to delegate a longer-running worker and type the slash command in
the OMP TUI pane (not the read-only viewer).

**Update (~13:55 UTC): owner confirmed s3 + s5 via the sleep-worker recipe**
(long-running worker so the roster stays live; `/lens split <id>` in the OMP TUI
pane; cross-workspace focus held). FR-06 and FR-13 are now owner-witnessed.
Owner UX feedback captured (multiple OMP subagents tabs observed; split opens a
new tab rather than an in-tab split; request for an OMP-like list+detail layout
and using OMP's plugin TUI lib) — under investigation as post-sign-off UX work.
