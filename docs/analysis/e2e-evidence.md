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
