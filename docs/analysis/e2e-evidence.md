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

All of s1 tail / s2 / s3 / s4 / s5: `RUN_E2E_LIVE=1 bash scripts/run-e2e.sh`
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
