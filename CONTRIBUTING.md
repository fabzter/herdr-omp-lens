# Contributing to herdr-omp-lens

Thanks for helping build a kinder window into OMP's workers. This project is design-led and
evidence-grounded: we agree the shape before we build it, and we prove behavior before we claim it.

## The documents come first

Read these before changing code:

1. [SDD](docs/superpowers/specs/2026-11-19-herdr-omp-lens-design.md) — requirements (FR/NFR), architecture, protocol.
2. [Master plan](docs/plans/00-master-plan.md) — phases, Definition of Done, global constraints.
3. [Seam research](docs/analysis/research-seams.md) — what OMP/Herdr actually expose, with citations.
4. [ADR-0001](docs/adr/0001-observation-seam.md) — the observation-seam decision.

The plan hierarchy is `master plan → phase specs → subplans`. Phase specs are reviewed one at a time;
all specs settle before subplans are written. **The owner closes review gates** — don't merge past a
gate on your own say-so.

## Non-negotiable invariants

- OMP owns execution and results. Never spawn duplicate workers.
- Closing a view never cancels a worker.
- No focus theft; every Herdr topology op is no-focus.
- Local only: unix-socket bridge (0600), no network relay.
- Fail soft; never block an OMP turn; no-op outside Herdr.
- v1 is read-only and scoped to the current session's direct task workers.
- Don't read OMP implementation source to fill API gaps — probe empirically and cite official docs.

## Development setup

Toolchain: [Bun](https://bun.sh). OMP runs TypeScript directly, so a build step is optional.

```sh
bun install
bun test            # unit + tamper tests
bun run typecheck   # tsc --noEmit
bun run lint        # biome check src tests
```

**DoD-v1 report.** Regenerate the requirement→evidence matrix — runs the suite and asserts every
cited test exists and passes:

```sh
bun scripts/gen-dod-report.ts   # writes docs/analysis/dod-v1-report.md
```

Load the extension into a throwaway OMP session for manual checks:

```sh
omp --extension ./src/extension/index.ts        # print mode
```

Integration tests run in a **disposable named Herdr session** so they never touch your daily
workspace. The default run is safe (create/enumerate/close + daily-workspace diff); set
`RUN_E2E_LIVE=1` for the full lifecycle drive inside a Herdr pane:

```sh
bash scripts/run-e2e.sh                  # safe disposable round-trip
RUN_E2E_LIVE=1 bash scripts/run-e2e.sh   # full lifecycle (owner-witnessed step set)
```

Evidence and results are recorded in `docs/analysis/e2e-evidence.md`.

Install-time quirk: `omp plugin link` inside a Herdr pane hangs on the loaded extension's socket
handles. Strip `HERDR_*` first (runtime is unaffected):

```sh
env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
    -u HERDR_SOCKET_PATH -u HERDR_BIN_PATH \
    omp plugin link <path>
```

## Testing rules

- **Failing test first.** Write the test, watch it fail, implement, watch it pass. Quote the output.
- **Tamper tests** must fail on the broken state (e.g. worker survives viewer close; no duplicate
  worker; no focus theft; `control` frames rejected in v1). A guard test that can't fail is worthless.
  Proven red runs are recorded in `tests/guards/sabotage.md`.
- **Isolated-session E2E** for anything touching Herdr topology. Never mutate the user's real
  session; the disposable `lens-e2e-*` workspace is the proof surface.

## Commits & reviews

- One commit per task; use the eval `commit` namespace so only your lines are staged.
- Routine delegation runs on lighter models; stronger models do the review.
- Update docs in the same change as behavior. Docs that drift from reality are bugs.

## Questions

Open questions live in the master plan (§10) and are settled one at a time with the owner. If you find
a new goal-steering choice, raise it — don't decide it silently.