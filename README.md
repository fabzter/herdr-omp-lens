<div align="center">

# 🪟 herdr-omp-lens

**A window into OMP's native subagents — from inside Herdr.**

[![Release](https://img.shields.io/github/v/release/fabzter/herdr-omp-lens?color=89d281&label=release)](https://github.com/fabzter/herdr-omp-lens/releases)
[![Tests](https://img.shields.io/badge/tests-501%20passing-89d281)](docs/analysis/dod-v1-report.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![OMP](https://img.shields.io/badge/OMP-19.2.1-febc38)](https://omp.sh)
[![Herdr](https://img.shields.io/badge/Herdr-0.9.5-7aa2f7)](https://herdr.dev)

When you delegate work in [OMP](https://omp.sh), it spins up native subagents — headless workers
doing research, edits, and reviews in the background. They live inside one terminal pane.
If you work in [Herdr](https://herdr.dev), you already think in tabs and panes.

**herdr-omp-lens gives those workers a second screen**: a tab in your workspace showing who's
working, what they're doing, and what they found — rendered with **OMP's own TUI components**.
No duplicate agents. No focus theft. Nothing leaves your machine.

OMP stays the boss. It owns the workers and their results. This is just a window.

![Overview — live roster, finished workers retained, OMP-look detail](docs/assets/overview.gif)

</div>

---

## ✨ What you get

- **`OMP subagents`** — one tab per OMP session in `$HERDR_WORKSPACE_ID`, opened with `--no-focus`
  the first time a direct worker spawns. Run several OMP sessions in one workspace and each gets its
  own tab (`OMP subagents · <id>` for the additional ones) — never a shared or hijacked view.
- **Reopen on the next subtask.** Close the tab and the *next* spawn reopens exactly one — never two,
  even under concurrent spawn events.
- **Worker split.** `/lens split <workerId>` pops that worker into a no-focus worker-scoped split.
  Closing the split never touches the worker.
- **OMP's own look, two columns (v1.1).** The roster is painted by OMP's own TUI component
  (`@oh-my-pi/pi-tui`'s `agent` painter, pinned to the installed OMP version) on the left; the
  selected worker's detail — status, agent, model, lineage, counters — and its live transcript
  (`omp render <sessionFile>`) fill the right. No second OMP instance: same pane process, same
  bridge. Narrow panes stack the columns; `LENS_PLAIN=1`/`--plain` restores the legacy text view.
- **Finished workers stay visible (v1.2).** Completed workers remain listed in a `finished (N):`
  section — OMP-hub style — even after OMP reaps them; `e` collapses them on demand. Both columns
  stay open at all times, including before the first delegation.
- **History that knows it's history.** After an OMP restart the saved transcripts are still there,
  labelled **not live** — the viewer never implies execution that isn't happening.
- **Degraded mode (D1).** If the native `task:subagent:*` bus is unavailable, you get one warn
  notice and workers are discovered by scanning the verified session-artifact directory instead.
  If Herdr or the bridge dies mid-turn, your OMP turn completes normally.

### Scroll the transcript — keys or wheel

![Transcript scrolling with keys and mouse wheel](docs/assets/scroll.gif)

### Two OMP sessions, two tabs, zero hijack

```sh
# from a clone of this repo
omp plugin link /path/to/herdr-omp-lens
```

> **Inside a Herdr pane, strip `HERDR_*` for the install command** — the installer otherwise waits
> on handles a running extension keeps open (install-time only; runtime is unaffected):
>
> ```sh
> env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
>     -u HERDR_SOCKET_PATH -u HERDR_BIN_PATH \
>     omp plugin link /path/to/herdr-omp-lens
> ```
>
> To keep a daily profile untouched, link into a disposable profile instead:
> `omp --profile=<name> plugin link <path>` (the `--profile` flag comes *before* the subcommand).

Then **restart your OMP session** and delegate a task — the `OMP subagents` tab opens by itself.

## 🚀 Use

Delegate anything in OMP (`task` tool). The overview opens on the first spawn.

| Command | Effect |
| --- | --- |
| `/lens` | Open the overview (no-op if already open; never moves focus). |
| `/lens split <workerId>` | Open a no-focus, worker-scoped split for that worker. Closing it never touches the worker. |

### Keyboard (read-only by construction)

| Key | Action |
| --- | --- |
| `j` / `k` or `↑` / `↓` | Select an agent |
| `J` / `K` | Scroll transcript down / up |
| `PgDn` / `PgUp` | Scroll a page |
| `g` / `G` | Transcript top / back to live-follow |
| **mouse wheel** | Scroll transcript (Herdr forwards it) |
| `e` / `Enter` / `Space` | Collapse / expand the finished section |
| `t` | Toggle thinking display (hidden by default) |
| `r` | Refresh |
| `q` / `Ctrl-C` | Quit the viewer (never the worker) |

There is no key that sends anything to a worker.

**Scope:** v1 shows the **direct** `task` workers of the **current** OMP session. Nested children
and other sessions' workers are excluded by design; workers started before the extension activated
are not retroactively observed (see [limitations](#-limitations)).

## 🔍 How it works

An in-process OMP extension subscribes to `task:subagent:{event,progress,lifecycle}` through
`pi.events`, keeps a direct-worker roster, and publishes it over a **local unix-socket NDJSON
bridge** (per-session `0700` dir, socket `0600`, unlinked on exit). A small viewer CLI — launched
into the Herdr tab through a guarded, no-focus adapter — connects, receives a `hello` snapshot plus
deltas, and renders with OMP's own `pi-tui` components. Nothing is spawned by the viewer; nothing
leaves the machine.

```
OMP session ──pi.events──▶ extension ──unix socket──▶ viewer (Herdr pane)
   owns workers            roster + bridge            pi-tui render, read-only
```

See [`docs/architecture.md`](docs/architecture.md) for the component map, data flow, invariants and
degraded-mode behavior, and the [SDD](docs/superpowers/specs/2026-11-19-herdr-omp-lens-design.md)
for the full design.

## ✅ Quality

- **501 tests / 0 fail** across 36 files; `tsc --noEmit` and `biome check` clean.
- **Tamper-proven invariants**: no duplicate workers, worker survives viewer close, no focus theft,
  no `control.*` frames, read-only keyboard map — each guard test fails on a deliberate sabotage.
- **Isolated-session E2E** in disposable Herdr workspaces; daily workspaces proven byte-identical
  before/after every run.
- Evidence pack: [DoD-v1 report](docs/analysis/dod-v1-report.md) ·
  [E2E evidence](docs/analysis/e2e-evidence.md) ·
  [clean-profile install](docs/analysis/clean-profile-install.md).

Regenerate the evidence report with `bun scripts/gen-dod-report.ts`.

Every command below was executed on 2026-11-25 at commit `c21b3cf` (OMP 19.2.1 / Herdr 0.9.5 — OI-4 re-pin) and
its output is quoted verbatim; the install/plugin-list captures are from the earlier 19.1.1 run
(version-stamped in the linked evidence doc). Regenerate the evidence report with `bun scripts/gen-dod-report.ts`.

Recorded known limitations — each a deliberate v1 boundary or an honest gap with a named capture:

1. **History counters are not reconstructable.** Persisted JSONL carries roster fields and terminal
   status, not the live `counters` stream; historical rows show counters absent, labelled *not live*.
2. **`queued` / `idle` / `parked` transitions** are mapped verbatim if OMP emits them, but no
   reachable trigger was found on the pinned build (see
   [caveat closure](docs/analysis/phase-0-caveat-closure.md)).
3. **Pre-activation workers** are not observed — there is no registry snapshot for extensions.
4. **Herdr-server-restart layout restore** is a v2 horizon item; an *OMP* restart reuses and rebinds
   the surviving tab.
5. **TUI `detached` variance** is unconsumed (harmless but unverified).

Full list with evidence: [DoD report §Known limitations](docs/analysis/dod-v1-report.md).

## 🗺️ Roadmap

- **v1 — "The Window" (this release):** read-only observation, OMP-look two-column frame,
  persistent finished rows, transcript scroll (keys + wheel), one tab per session.
- **v2 — "The Console" (horizon):** safe interactive control — steer, follow up, revive, stop —
  routed back to the session that owns the worker.

## 📚 Documentation

- [Architecture notes](docs/architecture.md) — components, data flow, invariants, degraded mode.
- [Software Design Document](docs/superpowers/specs/2026-11-19-herdr-omp-lens-design.md) — source of truth.
- [DoD-v1 evidence report](docs/analysis/dod-v1-report.md) — requirement matrix and sign-off block.
- [Isolated-session E2E evidence](docs/analysis/e2e-evidence.md) — runs, findings, live witnesses.
- [Clean-profile install + version discipline](docs/analysis/clean-profile-install.md).
- [Phase 0 caveat closure](docs/analysis/phase-0-caveat-closure.md) — what the bus really emits.
- [Seam research](docs/analysis/research-seams.md) · [ADR-0001](docs/adr/0001-observation-seam.md).
- [Contributing](CONTRIBUTING.md) — dev setup, tests, review gates.

## 🎬 Showcase recordings

The GIFs above are **real recordings of the actual viewer** (asciinema → agg), reproducible from
this repo: `bun scripts/showcase/driver.ts <overview|scroll>` drives the real `runViewer` against a
scripted local bridge with demo data; the multi-session capture runs two real OMP agents in a
disposable Herdr workspace. Sources: [`scripts/showcase/`](scripts/showcase/),
[`docs/assets/`](docs/assets/) (`.cast` + `.gif`).

## License

[MIT](LICENSE) © 2026 Fabrizio Hernandez.

---

<div align="center">

Built with care for people who live in their terminal.
Be kind to your workers; they're doing their best. 🪟

</div>
