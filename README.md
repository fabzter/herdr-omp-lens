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

🚧 **Design phase.** The architecture is approved and the long-horizon plan is written. We're about
to run a small probe (Phase 0) to confirm OMP's live event surface before building. Nothing is
installed yet.

- **v1 — "The Window":** read-only observation. One overview tab + optional splits, auto-open and
  reopen-on-next-subtask, OMP-like detail, finished workers tucked away, history you can revisit.
- **v2 — "The Console" (horizon):** safe interactive control — steer, follow up, revive, stop —
  routed back to the session that owns the worker.

## What it will feel like

You ask OMP to parallelize a job. A quiet `OMP subagents` tab appears in your workspace — your cursor
never moves. You glance over: three workers running, one already done. You pop the interesting one
into a split, read its transcript like you would in OMP's own Agent Hub, then close the split. The
worker keeps going. Closing a window never stops the work.

## Principles

- **OMP owns execution.** We observe; we never duplicate or hijack workers.
- **Closing a view never cancels a worker.** A window is not a leash.
- **No focus theft.** Everything opens in the background.
- **Local only.** A unix socket on your machine. No relay, no cloud.
- **Fail soft.** If Herdr or the bridge hiccups, OMP keeps working.
- **Read-only first.** Control comes later, carefully, with confirmation.

## Documentation

- [Software Design Document](docs/superpowers/specs/2026-11-19-herdr-omp-lens-design.md) — the source of truth.
- [Master plan](docs/plans/00-master-plan.md) — v1/v2 horizon, phases, Definition of Done.
- [Seam research](docs/analysis/research-seams.md) — cited evidence for what OMP and Herdr expose.
- [ADR-0001](docs/adr/0001-observation-seam.md) — why an in-process extension + local bridge.
- [Contributing](CONTRIBUTING.md) — dev setup, tests, and review gates.

## Requirements

- OMP 19.0.1 and Herdr 0.9.5 (the versions this design is pinned to and probed against).
- macOS or Linux; a Herdr-managed pane (`HERDR_ENV=1`). Outside Herdr, the extension does nothing.

## License

To be confirmed (proposed MIT — see open question Q-02 in the master plan).

---

Built with care for people who live in their terminal. Be kind to your workers; they're doing their best.