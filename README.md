# herdr-omp-lens

> A window into OMP's native subagents, from inside Herdr.

When you delegate work in [OMP](https://omp.sh), it spins up native subagents — headless little
workers doing research, edits, and reviews in the background. They're powerful, but they live inside
one terminal pane. If you work in [Herdr](https://herdr.dev), you already think in tabs and panes.

**herdr-omp-lens** gives those workers a second screen: a tab in your workspace that shows who's
working, what they're doing, and what they found — without launching a single duplicate agent,
without stealing your focus, and without sending anything off your machine.

OMP stays the boss. It owns the workers and their results. This is just a window.

## Status

🪟 **v1 "The Window" is implemented; v1.1 gives it OMP's own look.** 469 tests across 36 files are green; `tsc --noEmit` and
`biome check` are clean. The evidence pack for the v1 Definition of Done lives in
[`docs/analysis/dod-v1-report.md`](docs/analysis/dod-v1-report.md) and is **awaiting owner
sign-off** — design, hardening and clean-profile install are complete, but the owner spot-witnesses
the live Herdr lifecycle steps listed in the report's open items before v1 is declared done.

- **v1 — "The Window" (this release):** read-only observation of the current session's direct task
  workers. One overview tab + optional splits, auto-open and reopen-on-next-subtask, OMP-like detail,
  finished workers tucked away, persisted history you can revisit.
- **v2 — "The Console" (horizon, not started):** safe interactive control — steer, follow up,
  revive, stop — routed back to the session that owns the worker.

## What you get

- **`OMP subagents`** — one tab in `$HERDR_WORKSPACE_ID`, opened with `--no-focus` the first time a
  direct worker spawns in your OMP session.
- **Reopen on the next subtask.** Close the tab and the *next* spawn reopens exactly one — never two,
  even under concurrent spawn events.
- **Worker split.** `/lens split <workerId>` pops that worker into a no-focus worker-scoped split.
  Closing the split never touches the worker.
- **OMP's own look, two columns (v1.1).** The roster is painted by OMP's own TUI component
  (`@oh-my-pi/pi-tui`'s `agent` painter, pinned to the installed OMP version) on the left; the
  selected worker's detail — status, agent, model, lineage, counters — and its live transcript
  (`omp render <sessionFile>`) fill the right. No second OMP instance: same pane process, same
  bridge. Narrow panes stack the columns; `LENS_PLAIN=1`/`--plain` restores the legacy text view.
- **Finished collapse.** Completed workers are tucked into a collapsed section by default;
  `e` expands them.
- **History that knows it's history.** After an OMP restart the saved transcripts are still there,
  labelled **not live** — the viewer never implies execution that isn't happening.
- **Degraded mode (D1).** If the native `task:subagent:*` bus is unavailable, you get one warn
  notice and workers are discovered by scanning the verified session-artifact directory instead.
  If Herdr or the bridge dies mid-turn, your OMP turn completes normally.

Keyboard, read-only by construction: `j`/`k` or `↑`/`↓` select, `e`/`Enter`/`Space` toggle the
finished section, `t` toggles thinking display (hidden by default), `r` refreshes, `q`/`Ctrl-C`
quits. There is no key that sends anything to a worker.

## Install

Requires a Herdr-managed pane for activation (`HERDR_ENV=1`); outside Herdr the extension is a no-op.

```sh
# from a clone of this repo
omp plugin link /path/to/herdr-omp-lens
```

> **Inside a Herdr pane, strip `HERDR_*` for the install command.** The link installer waits on
> subprocess handles that a running extension keeps open, so `plugin link` otherwise appears to hang
> (~1.5 s with the strip):
>
> ```sh
> env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
>     -u HERDR_SOCKET_PATH -u HERDR_BIN_PATH \
>     omp plugin link /path/to/herdr-omp-lens
> ```
>
> This is install-time only; runtime inside Herdr is unaffected. To keep a daily profile untouched,
> link into a disposable profile instead: `omp --profile=<name> plugin link <path>` (the `--profile`
> flag must come *before* the subcommand).

## Use

Open the overview any time with the read-only slash command:

| Command | Effect |
| --- | --- |
| `/lens` | Open the overview (no-op if already open; never moves focus). Unknown arguments behave like `/lens`. |
| `/lens split <workerId>` | Open a no-focus, worker-scoped split for that worker. `/lens split` with no id does nothing. |

Both are no-ops until OMP has handed the extension a session id (the first `session_start`), and
both are read-only: v1 has no steer/revive/cancel affordance, and the bridge rejects every
`control.*` frame at the handshake boundary.

**Scope:** v1 shows the **direct** `task` workers of the **current** OMP session. Nested children and
other sessions' workers are excluded by design. Workers that were already running before the
extension activated are not retroactively observed (there is no registry snapshot to read — see
limitations).

## How it works

An in-process OMP extension subscribes to `task:subagent:{event,progress,lifecycle}` through
`pi.events`, keeps a direct-worker roster, and publishes it over a **local unix-socket NDJSON
bridge** (per-session `0700` dir, socket `0600`, unlinked on exit). A small viewer CLI — launched by
the extension into the Herdr tab through the guarded, no-focus adapter — connects, receives a
`hello` snapshot plus deltas, and renders roster + transcript. Nothing is spawned by the viewer and
nothing leaves the machine.

See [`docs/architecture.md`](docs/architecture.md) for the component map, data flow, invariants and
degraded-mode behavior, and the [SDD](docs/superpowers/specs/2026-11-19-herdr-omp-lens-design.md) for
the full design.

## Requirements

- **OMP 19.2.1** — the design pin (19.0.1 → 19.1.1 per OI-1 → 19.2.1 per OI-4, owner decisions
  2026-11-25), matching the installed binary; spec and gate agree. pi-tui/pi-wire are pinned to the
  same 19.2.1 (the TUI library OMP embeds). See
  [`docs/analysis/clean-profile-install.md`](docs/analysis/clean-profile-install.md) §1.
- **Herdr 0.9.5** (the version probed against).
- macOS or Linux, [Bun](https://bun.sh) on `PATH` (the viewer runs under `bun`), and a Herdr-managed
  pane (`HERDR_ENV=1`).

## Verified commands

Every command below was executed on 2026-11-25 at commit `c21b3cf` (OMP 19.2.1 / Herdr 0.9.5 — OI-4 re-pin) and
its output is quoted verbatim; the install/plugin-list captures are from the earlier 19.1.1 run
(version-stamped in the linked evidence doc). Regenerate the evidence report with `bun scripts/gen-dod-report.ts`.

```console
$ bun test
 469 pass
 0 fail
 1706 expect() calls
Ran 469 tests across 36 files. [3.72s]

$ bun run typecheck          # tsc --noEmit — clean, no output

$ bun run lint
$ biome check src tests
Checked 68 files in 22ms. No fixes applied.

$ bun src/viewer/cli.ts      # no LENS_* env — usage error, exit 2, no connection
usage: bun src/viewer/cli.ts [--worker <id>] [--plain] (env: LENS_SOCKET_PATH, LENS_SESSION[, LENS_WORKER_ID])

$ env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
      -u HERDR_SOCKET_PATH -u HERDR_BIN_PATH \
      omp --profile=p6t7-clean plugin link /Users/fabzter/src/omp-fabz-improvements
✔ Linked herdr-omp-lens from /Users/fabzter/src/omp-fabz-improvements

$ omp --profile=p6t7-clean plugin list --json
{ "npm": [ { "name": "herdr-omp-lens", "version": "0.1.0", "path":
  ".../profiles/p6t7-clean/plugins/node_modules/herdr-omp-lens",
  "manifest": { "extensions": ["./src/extension/index.ts"], "version": "0.1.0" },
  "enabled": true } ], "marketplace": [] }

_Above JSON is abridged for readability — the verbatim, unabridged output is recorded in
[docs/analysis/clean-profile-install.md](docs/analysis/clean-profile-install.md) §2._

$ bash scripts/run-e2e.sh    # recorded run, verbatim summary — docs/analysis/e2e-evidence.md Run A
exit code: 0   (7 pass / 0 fail / 0 manual / 5 skipped)  # live runs: Run C + owner-witnessed Run D, same doc
```

The slash commands cannot be typed from a shell (they run inside the OMP TUI). Their dispatch and
no-op semantics are pinned by `tests/extension/lens-commands.test.ts`; their live effect was
witnessed in an interactive TUI session:
`herdr pane read` → `omp lens — session 01a210e2-5995-74b7-99d0-1acf4182b855 [connected]`
(see [`docs/analysis/phase-0-caveat-closure.md`](docs/analysis/phase-0-caveat-closure.md) §Caveat 1)
and in the clean-profile run (`OMP subagents` tab `w11:t2`, viewer `w11:p2`, focus held in `wN` —
[`docs/analysis/clean-profile-install.md`](docs/analysis/clean-profile-install.md) §3). The live E2E
step that drives `/lens split` (s3) is still pending a clean live witness — Run D (owner-witnessed)
recorded the pane-get JSON EOF flake on it; s1/s2 are now live-proven — see
[`docs/analysis/dod-v1-report.md`](docs/analysis/dod-v1-report.md) §Open items.

## Limitations

Recorded known limitations. Each is either a deliberate v1 boundary or an honest gap with a named
capture; none is a silent pass.

1. **History caveat (R-04): live counters are not reconstructable.** Persisted JSONL carries the
   roster fields and terminal status, but not the live `counters` stream. Historical rows show
   `counters` absent and are labelled *not live*; a restart shows what happened, not live usage.
2. **`queued`, `idle`, `parked` transitions.** These statuses are mapped verbatim if OMP emits them,
   but no reachable trigger was found on 19.1.1: a parallel two-agent `task` batch emits `queued`
   nowhere, and completed agents are reaped without a `parked` frame. Recorded in
   [`docs/analysis/phase-0-caveat-closure.md`](docs/analysis/phase-0-caveat-closure.md) §Caveat 2.
3. **TUI `detached` variance.** The `detached` flag is present on every lifecycle/progress frame and
   is deliberately unconsumed, so TUI async-spawn variance is harmless — but unverified.
4. **Pre-activation workers (U-OMP-5).** There is no registry snapshot for extensions; a worker that
   started before the extension activated never appears.
5. **Transient finished-collapse.** The collapsed section is a live UI state: reaping can be faster
   than a readback, so a green E2E run does not imply it was *seen* — it is unit-covered and reported
   as such, never as a witnessed pass.
6. **Herdr-restart restore is out of scope for v1.** A surviving *OMP* viewer tab is reused and
   rebound to the new bridge socket on restart; restoring the viewer layout after a *Herdr* server
   restart is a v2 horizon item.
7. ~~Version drift~~ **Resolved (OI-1 + OI-4, 2026-11-25).** The owner approved re-pinning the spec
   19.0.1 → 19.1.1 (OI-1), then → 19.2.1 (OI-4) when the installed binary upgraded; spec and gate
   agree. Earlier evidence runs stay version-stamped (19.1.1 / Herdr 0.9.5).
8. **Owner live-witness — partially resolved (OI-2, 2026-11-25).** Owner-witnessed Run D live-proved
   s1 and s2 (auto-open, close→reopen, no focus theft, U-HDR-1); s3 (`/lens split`), s4
   (restart→history) and s5 (cross-workspace focus) remain `manual-evidence` for env-coupled
   reasons (pane-get JSON EOF flake; local-build session-bind gap; correlated spawn timeout) —
   recorded in [`docs/analysis/e2e-evidence.md`](docs/analysis/e2e-evidence.md) §Run D, never as
   silent passes.
9. **Deferred review minors.** Small, non-blocking follow-ups recorded across the hardening reviews
   (list in the DoD report §Open items, OI-3) remain for triage; each has a sibling assertion or a
   bounded failure mode.

## Documentation

- [DoD-v1 evidence report](docs/analysis/dod-v1-report.md) — the generated requirement matrix and sign-off block.
- [Architecture notes](docs/architecture.md) — components, data flow, invariants, degraded mode.
- [Software Design Document](docs/superpowers/specs/2026-11-19-herdr-omp-lens-design.md) — the source of truth.
- [Master plan](docs/plans/00-master-plan.md) — v1/v2 horizon, phases, Definition of Done.
- [Phase 0 caveat closure](docs/analysis/phase-0-caveat-closure.md) — what the bus really emits, with captures.
- [Isolated-session E2E evidence](docs/analysis/e2e-evidence.md) — runs, findings, pending live steps.
- [Clean-profile install + version discipline](docs/analysis/clean-profile-install.md) — FR-15/NFR-02 evidence.
- [Seam research](docs/analysis/research-seams.md) — cited evidence for what OMP and Herdr expose.
- [ADR-0001](docs/adr/0001-observation-seam.md) — why an in-process extension + local bridge.
- [Contributing](CONTRIBUTING.md) — dev setup, tests, review gates.

## License

[MIT](LICENSE) © 2026 Fabrizio Hernandez.

---

Built with care for people who live in their terminal. Be kind to your workers; they're doing their best.
