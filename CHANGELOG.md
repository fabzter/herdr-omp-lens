# Changelog

All notable changes to herdr-omp-lens are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-11-26

First public release — **"The Window"**: read-only observation of OMP's native subagents from
inside Herdr, rendered with OMP's own TUI components.

### Added

- **Native observation** of the current session's direct `task` workers via the
  `task:subagent:{event,progress,lifecycle}` bus; direct-only scope, unknown-status passthrough.
- **Local unix-socket NDJSON bridge** — per-session `0700` dir, `0600` socket, versioned handshake,
  coalesced deltas (≤150 ms), bounded buffers; `control.*` frames rejected at the boundary.
- **One `OMP subagents` tab per OMP session** in the caller workspace, opened `--no-focus` on first
  delegation; close → next subtask reopens exactly one; survivor rebind after OMP restart (D2).
  Multi-session ownership via session-suffixed labels + viewer argv0 token (`lens:<suffix>:<pid>`),
  never hijacking another live session's tab.
- **Worker split** — `/lens split <workerId>` opens a no-focus worker-scoped view; closing it never
  touches the worker.
- **OMP-look two-column viewer** built on `@oh-my-pi/pi-tui` (pinned to the installed OMP version):
  `agent` painter roster, `kv` detail grid, live transcript via `omp render`. Fixed full-viewport
  frame — statusLineBg header/footer bars, borderMuted T-junction rules, disclosure section headers,
  accent `❯` + selectedBg selection, footer locked to the bottom row, resize-aware.
- **Persistent finished rows** — completed workers stay listed after OMP reaps them; `e` collapses
  on demand; non-terminal reaps demote to `[not-live]` history; bounded retention (100).
- **Transcript scrolling** — `J`/`K` line, `PgDn`/`PgUp` page, `g` top, `G` live-follow, and the
  **mouse wheel** (SGR 64/65); `↑ N earlier lines` / `↓ N more lines` indicators; view-local only.
- **History after restart** — persisted transcripts marked `[not-live]`, never implying live execution.
- **Degraded mode (D1)** — absent bus → one warn notice + artifact-scan discovery; Herdr/bridge death
  never blocks an OMP turn.
- **Showcase recordings** — real asciinema→agg captures of the actual viewer (`docs/assets/`),
  reproducible via `scripts/showcase/driver.ts`.

### Quality

- 501 tests / 0 fail across 36 files; `tsc --noEmit` and `biome check` clean.
- Tamper-proven safety invariants (no duplicate workers, worker survives viewer close, no focus
  theft, read-only keyboard map, no `control.*`).
- Isolated-session E2E in disposable Herdr workspaces; daily workspaces proven untouched.
- Evidence pack: `docs/analysis/dod-v1-report.md` (19 pass / 2 manual-evidence / 0 fail).

### Known limitations

See the [README §Limitations](README.md#limitations) and the DoD report — history counters are not
reconstructable; `queued`/`idle`/`parked` have no reachable trigger on the pinned build;
pre-activation workers are not observed; Herdr-server-restart layout restore is a v2 horizon item.

[1.0.0]: https://github.com/fabzter/herdr-omp-lens/releases/tag/v1.0.0
