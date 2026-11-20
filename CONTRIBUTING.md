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
bun run lint
```

Load the extension into a throwaway OMP session for manual checks:

```sh
omp --extension ./src/extension/index.ts
```

Integration tests run in an **isolated named Herdr session** so they never touch your daily workspace:

```sh
herdr --session lens-test   # create/attach a scratch session
# run the integration suite against it, then stop it
herdr session stop lens-test
```

## Testing rules

- **Failing test first.** Write the test, watch it fail, implement, watch it pass. Quote the output.
- **Tamper tests** must fail on the broken state (e.g. worker survives viewer close; no duplicate
  worker; no focus theft; `control` frames rejected in v1). A guard test that can't fail is worthless.
- **Isolated-session E2E** for anything touching Herdr topology. Never mutate the user's real session.

## Commits & reviews

- One commit per task; use the eval `commit` namespace so only your lines are staged.
- Routine delegation runs on lighter models; stronger models do the review.
- Update docs in the same change as behavior. Docs that drift from reality are bugs.

## Questions

Open questions live in the master plan (§10) and are settled one at a time with the owner. If you find
a new goal-steering choice, raise it — don't decide it silently.