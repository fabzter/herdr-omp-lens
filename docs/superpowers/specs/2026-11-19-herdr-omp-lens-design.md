# herdr-omp-lens — Software Design Document (SDD)

- Date: 2026-11-19
- Status: **Design approved by owner; Phase 0 probe pending (R-01).**
- Owner: Fabrizio Hernandez.
- Versions targeted: OMP **19.0.1**, Herdr **0.9.5** (protocol 22).
- Companion docs: `../../analysis/research-seams.md` (evidence), `../../adr/0001-observation-seam.md`
  (seam decision), `../../plans/00-master-plan.md` (long horizon, phases, DoD).

> Working name **herdr-omp-lens** — "a window into OMP's native subagents, from inside Herdr."
> Renameable (Q-01). This document is the source of truth the implementation plans argue from.

---

## 1. Problem & intent

OMP runs native task subagents headlessly inside an interactive TUI session. Inside Herdr, the user
wants a second screen — a tab and optional splits in the same workspace — that shows those workers
live, with detail close to OMP's own task view, without launching duplicate agents, stealing focus, or
sending anything over a network relay. OMP stays the sole owner of execution and results; Herdr is a
window, not a second host.

## 2. Goals / non-goals

**v1 goals**

- Observe the **direct native `task` workers of the current OMP session**, read-only.
- One no-focus overview tab in the caller workspace; optional worker splits.
- Auto-open on delegation while in Herdr; reopen on the **next subtask** after a manual close.
- Worker detail close to OMP's native task view (roster + inspector + live transcript).
- Finished workers collapsed by default; history accessible, including persisted history after restart.
- A reusable, well-documented package with personality.

**v1 non-goals**

- No steering, follow-up, revive, or cancellation from Herdr (read-only). Reserved for v2.
- No nested-worker tree, no workspace-wide multi-session board (v2 candidates).
- No hosted relay / Collab; no second OMP host; no upstream submission unless separately requested.
- No full Herdr-server-restart layout restore as a hard requirement (live-reopen priority; stretch).

## 3. Ratified decisions (owner, 2026-11-19)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Capability from Herdr | Read-only (A), architecture extensible to full interactive (C) |
| 2 | Placement | One overview tab in caller workspace + optional splits (A) |
| 3 | Opening | Always when in Herdr; next subtask reopens after manual close |
| 4 | Detail fidelity | Close to OMP's native task view |
| 5 | Finished workers | Collapse/hide by default (B); history accessible incl. after restart |
| 6 | Worker scope | Direct native task workers of current session only (A) |
| 7 | Packaging | Reusable local repo, humane personality, good docs |

## 4. Architecture

```
┌────────────────────────── OMP TUI process (owner) ──────────────────────────┐
│  native task workers (headless child sessions)                               │
│        │ task:subagent:{event,progress,lifecycle}  (parent event bus)        │
│        ▼                                                                     │
│  herdr-omp-lens EXTENSION                                                    │
│   • Herdr gate (HERDR_ENV=1 + ids)                                           │
│   • native-event subscriber (feature-detect, fail-soft)                      │
│   • session-scoped roster reducer (direct workers only)                      │
│   • bridge publisher (unix-socket NDJSON, observation-only v1)               │
│   • topology manager (herdr CLI/socket: tab/split, close-detect, reopen)     │
│   • persisted-history scanner (artifact tree)                                │
└───────────────┬───────────────────────────────────────────┬─────────────────┘
                │ local NDJSON bridge (unix socket, 0600)    │ herdr CLI / socket
                ▼                                            ▼
   ┌────────────────────────────┐               ┌────────────────────────────┐
   │ VIEWER CLI (ordinary pane) │               │ Herdr server               │
   │  roster + OMP-like detail  │               │  overview tab (no-focus)   │
   │  transcript via JSONL /    │               │  optional worker splits    │
   │  omp render / history://   │               │  events.subscribe          │
   │  read-only keyboard nav    │               └────────────────────────────┘
   └────────────────────────────┘
```

Components (one responsibility each):

1. **Extension** (`src/extension/`) — activation gate, observation, roster, bridge publisher, topology
   manager, history scanner. Loaded in the parent TUI; no-ops outside Herdr.
2. **Viewer CLI** (`src/viewer/`) — connects to the bridge, renders roster + selected worker transcript,
   read-only navigation, finished-collapse. An ordinary Herdr pane process.
3. **Bridge protocol** (`src/protocol/`) — versioned NDJSON message types; observation-only v1 with a
   reserved `control` namespace (unused in v1) so v2 can add control without a rewrite.
4. **Herdr adapter** (`src/herdr/`) — wraps `herdr` CLI/socket for additive no-focus tab/split,
   `events.subscribe`, authoritative reconcile (`pane.get`/`session.snapshot`), `report_metadata`.
5. **Transcript source** (`src/transcript/`) — artifact-tree JSONL tailing + `omp render`/`omp read
   history://` for faithful rendering; parked/history enumeration.
6. **Docs & tests** — README, architecture, limitations, CONTRIBUTING; unit + isolated-session tests.

## 5. Functional requirements (v1)

- **FR-01 Herdr gate.** Activate only when `HERDR_ENV=1` and caller ids are present; otherwise no-op.
  *Accept:* outside Herdr, no tab/pane/socket is created and no native handler effects occur.
- **FR-02 Native observation.** Subscribe to `task:subagent:event/progress/lifecycle` via `pi.events`
  (feature-detect; fail soft). Maintain a roster of **direct** task workers of the current session.
  *Accept:* a spawned worker appears with id/name/agent/status; status transitions reflect native events.
- **FR-03 Local bridge.** Publish roster + transcript references over a unix-socket NDJSON bridge,
  socket mode 0600, versioned handshake. *Accept:* viewer connects, receives a snapshot then deltas;
  no network interface is bound.
- **FR-04 Overview tab.** On first spawn, create one tab labeled `OMP subagents` in
  `$HERDR_WORKSPACE_ID` with `--no-focus`, run the viewer in its root pane. *Accept:* tab exists, focus
  unchanged, viewer rendering.
- **FR-05 Reopen after close.** If the user closes the view, the **next** subtask reopens it; dedupe via
  authoritative read so concurrent events never double-create. *Accept:* close → next spawn → exactly
  one viewer tab.
- **FR-06 Optional split.** Provide an action to pop a worker into a no-focus split. *Accept:* split
  created without focus change; closing it never affects the worker.
- **FR-07 OMP-like detail.** Roster fields (status, model, age, usage/counters when available) +
  inspector (current tool/activity, lineage) + live transcript. *Accept:* detail matches the documented
  Agent Hub field set to the extent the bus/artifacts expose it (R-01 bounded).
- **FR-08 Finished collapse.** Finished workers collapse by default; expandable on demand. *Accept:*
  completed batch shows a collapsed finished section; expanding reveals results.
- **FR-09 History.** Persisted transcripts are accessible; after OMP restart, show saved history marked
  **not live**. *Accept:* a parked worker's transcript renders from disk; restart shows history without
  implying live execution.
- **FR-10 Direct-only scope.** Exclude nested workers and other sessions' workers in v1. *Accept:* a
  nested child does not appear as a top-level row; a second OMP session's workers are absent.
- **FR-11 Read-only.** No control messages in v1; the viewer cannot steer/revive/cancel. *Accept:* the
  bridge rejects/ignores any `control` frame; viewer has no control affordance.
- **FR-12 Fail-soft.** Extension never blocks an OMP turn; bridge/Herdr failures degrade gracefully with
  a single notification. *Accept:* killing Herdr or the bridge leaves OMP turns unaffected.
- **FR-13 No focus theft.** All topology operations use no-focus. *Accept:* focus stays in the caller
  pane across open/split/reopen (live-verified).
- **FR-14 Ownership invariants.** No duplicate workers; closing a view never cancels a worker.
  *Accept:* tamper tests prove worker survives viewer close and no second worker is spawned.
- **FR-15 Reusable package.** Installable via `omp plugin link`/`install`; humane README + docs.
  *Accept:* clean-profile install loads the extension and opens the view on delegation.

## 6. Non-functional requirements

- **NFR-01 Local-only.** No network relay; bridge is a local unix socket (0600). No secrets beyond what
  the OMP view itself shows are emitted.
- **NFR-02 Version discipline.** Pin to OMP 19.0.1 / Herdr 0.9.5; feature-detect undocumented surfaces;
  fail soft rather than crash on shape drift.
- **NFR-03 Performance.** Coalesce progress (native ≤150ms); bounded bridge buffers; viewer tailing must
  not grow unbounded (rotate/snapshot).
- **NFR-04 Safety.** OMP sole owner; read-only v1; no `agent start`/`report_agent` for the viewer; no
  `layout.apply` with `tab_id`; no `agent.view.set`.
- **NFR-05 Testability.** Unit tests for reducer/protocol/adapter; isolated named-Herdr-session
  integration; tamper tests that fail on broken behavior.
- **NFR-06 Docs reconcile.** Docs match shipped behavior at each milestone.

## 7. Bridge protocol (v1)

NDJSON over a unix socket. Handshake: viewer sends `{v:1, role:"viewer", session:<id>}`; extension
replies `{v:1, type:"hello", session, workers:[…]}` then streams deltas.

Message types (observation-only):

- `hello` — initial roster snapshot.
- `worker.upsert` — `{id, name, agent, status, model?, activity?, counters?, sessionFile?, updatedAt}`.
- `worker.removed` — `{id}`.
- `transcript.ref` — `{id, sessionFile, artifactDir}` so the viewer can tail/render via the transcript
  source (the bridge carries references + activity, not full transcript bytes, to stay bounded).
- `topology` — `{tabId?, paneIds:[…], state:"open"|"closed"}` (informational).
- `notice` — `{level, message}` for fail-soft degradation.

Reserved (v2, **not implemented in v1**): `control.*` namespace (`steer`, `follow_up`, `revive`,
`cancel`) with an explicit confirmation handshake. v1 viewers must not send these; the extension
ignores/rejects them (FR-11).

> Exact field names are finalized after Phase 0 confirms native payload shapes (R-01). The protocol is
> versioned so shape drift is a negotiated concern, not a crash.

## 8. Herdr topology lifecycle

1. **Subscribe first.** Open one `events.subscribe` connection (session-wide `tab.closed`,
   `pane.closed`, `pane.exited`, `pane.moved`, `workspace.closed`, `layout.updated`) **before** creating
   the viewer (V-HDR-2/4).
2. **Create additively.** `tab create --workspace $HERDR_WORKSPACE_ID --label "OMP subagents"
   --no-focus`, then `pane run <root> "<viewer cmd>"`. Optional split via `pane split --no-focus`.
   Never `layout.apply` with `tab_id` (V-HDR-5).
3. **Track liveness.** Match stored `tabId`/`paneId` against close events (either order = gone);
   `pane.exited` distinguishes crash from user close; `pane.moved` updates the stored id. Always
   reconcile via `pane.get`/`session.snapshot`; on `events_lost`, resubscribe + snapshot (V-HDR-3/4).
4. **Reopen.** On the next native spawn after a close, recreate exactly one viewer (authoritative-read
   dedupe). Manual close is respected until the next subtask (ratified #3).
5. **Presentation.** Optionally `pane.report_metadata` for a friendly title/state label; never
   `report_agent` (V-HDR-6/7).

## 9. Transcript fidelity & history

- Live activity/status from the native bus (R-01 bounded). Transcript bytes from the documented
  artifact-tree JSONL (V-OMP-8) and `omp render` / `omp read history://<id>` (V-OMP-6/7) — the
  production pipeline, host-less, no lease acquired.
- Finished workers collapse (FR-08); results render from `<id>.md` / JSONL.
- After OMP restart, scan the persisted artifact tree (as Agent Hub does) and show saved history marked
  **not live** (FR-09). Exact live counters are not reconstructable; label them as historical.

## 10. Error handling & safety invariants

- Outside Herdr → no-op (FR-01). Bus absent/shape drift → degrade to artifact polling + `omp render`,
  one `notice` (FR-12, R-01 fallback). Herdr/bridge failure → OMP turns unaffected (FR-12).
- **Invariants (tamper-tested):** no duplicate workers; closing a view never cancels a worker; no focus
  theft; no network relay; OMP sole owner of execution/results.

## 11. Testing strategy

- **Unit:** roster reducer (status transitions, direct-only filter, finished collapse), protocol
  encode/decode + version handshake, Herdr adapter (mocked CLI/socket), close/reopen state machine.
- **Tamper/regression:** assert worker survives viewer close; assert no second worker spawned; assert
  no-focus; assert `control` frames rejected in v1. Each must fail on the broken state.
- **Integration (isolated named Herdr session):** open/reopen/split/close, finished collapse, history
  after restart, focus preservation — never touching the daily workspace.
- **Phase 0 probe:** empirical bus confirmation on 19.0.1 (see master plan P0).

## 12. Limitations & open risks

- **R-01** undocumented bus contract gates live fidelity (Phase 0). Fallback documented.
- **R-02** no public attach to a live TUI; mitigated by the in-process extension (ADR-0001).
- **R-03** Herdr may auto-detect the viewer pane as an agent (U-HDR-1; P4 live test).
- **R-04** restart history is reconstructable but not exact live counters (FR-09).
- **R-05** v2 interactive control likely needs an upstream OMP API (P7 research).
- **R-06/R-07** Herdr `layout.apply` hazard and non-durable events (honored in §8).

## 13. References

See `../../analysis/research-seams.md` for the full cited evidence (V-OMP-*, V-HDR-*, U-*, R-01) and
`../../adr/0001-observation-seam.md` for the seam decision and rejected alternatives.