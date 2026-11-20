# Phase P4 — Topology lifecycle (spec)

- Version: v1 "The Window"
- Status: **Draft for owner review.**
- Depends on: P1 (protocol + Herdr adapter + gate), P2 (roster events → "a worker spawned"),
  P3 (viewer command the topology manager launches).
- Produces interfaces for: P5 (history/restart — topology state outlives live workers), P6 (isolated-session E2E).
- Source of truth: `../../superpowers/specs/2026-11-19-herdr-omp-lens-design.md` (§8 lifecycle, FR-04..06, FR-13..14, NFR-04).

> This is a phase **spec** (requirements + interfaces + acceptance), not a subplan. Per the long-horizon
> process, all v1 phase specs settle before any code subplan is written.

## Goal

Implement the **topology manager**: the state machine that owns the viewer's place in Herdr —
one no-focus overview tab in the caller workspace, optional per-worker splits, close detection,
reopen-on-next-subtask, and authoritative reconciliation — while preserving every safety invariant
(SDD §10). De-risks R-03 (agent auto-detect), R-06 (`layout.apply` hazard), R-07 (non-durable events).

## Scope

In scope:
- `src/extension/topology.ts` — the topology state machine (closed → opening → open → closed; degraded).
- Orchestration of P1 Herdr-adapter calls: `subscribeLifecycle` **before** `createOverviewTab`,
  `runInPane` for the viewer command, `splitPane`, `getPane`/`snapshot` reconcile, `reportMetadata`.
- Manual-close semantics: user close is respected; the **next** worker spawn reopens exactly one view.
- Liveness tracking across `tab.closed`/`pane.closed`/`pane.exited`/`pane.moved`/`workspace.closed`,
  incl. stored-id rewrite on `pane.moved` and `events_lost` recovery (resubscribe + snapshot).
- `topology` bridge messages on open/close state transitions (SDD §7).
- Isolated named-Herdr-session integration tests; the U-HDR-1..5 live-test checklist.

Out of scope: roster reduction (P2), viewer rendering (P3), persisted history scan (P5), any worker
control (v2), workspace-wide board (v2), Herdr-server-restart layout restore (stretch, P10).

## Requirements & acceptance criteria

- **P4-R1 Subscribe-before-create ordering.** `subscribeLifecycle` resolves before the first
  `createOverviewTab`; lifecycle handlers are registered before any mutation call (SDD §8.1, V-HDR-2/4).
  *Accept:* a mocked-adapter test asserts call order; a tamper test that reorders them fails.
- **P4-R2 Auto-open no-focus overview tab.** On the first worker-spawn signal while gated in Herdr,
  create exactly one tab labeled `OMP subagents` in `callerContext.workspaceId` via `createOverviewTab`,
  then `runInPane` the viewer command in its root pane (FR-04).
  *Accept:* mocked adapter records `createOverviewTab` once with the caller workspace id; isolated
  session shows the tab exists and OMP's pane retains focus.
- **P4-R3 Manual close respected; reopen on next spawn only.** A `tab.closed`/`pane.closed` matching
  stored ids (either order = gone, V-HDR-3) transitions to `closed` **without** immediate reopen; the
  next spawn signal recreates exactly one view (FR-05, ratified #3).
  *Accept:* close → no topology call until next spawn; reopen emits exactly one `createOverviewTab`.
- **P4-R4 Double-create dedupe via authoritative read.** Before creating, reconcile `snapshot()`/
  `getPane` for an existing owned tab/pane (covers close-before-subscribe race and U-HDR-4); concurrent
  spawn signals never double-create (V-HDR-4).
  *Accept:* two near-simultaneous spawn signals → exactly one tab; injected stale event → no duplicate.
- **P4-R5 No-focus on every mutation (FR-13).** All adapter calls use the no-focus paths; the manager
  never requests focus.
  *Accept:* isolated session — focus stays in the caller pane across open/split/reopen; a guard test
  fails if a focusing adapter call is introduced (extends P1-R5).
- **P4-R6 Forbidden-call tamper guards (NFR-04, R-06).** The manager never invokes `layout.apply`
  with `tab_id`, never `agent start`, never `pane.report_agent`, never `agent.view.set` for the viewer.
  *Accept:* adapter-facade tests assert these are unreachable from topology code; a tamper test
  injecting such a call fails.
- **P4-R7 Optional per-worker split (FR-06).** A `openWorkerSplit(workerId)` action creates a no-focus
  `splitPane` (default `"right"`) running a worker-scoped viewer; splits are tracked separately from
  the overview tab.
  *Accept:* split created with no focus change; roster shows the split bound to that worker id.
- **P4-R8 Closing any view never touches the worker (FR-14).** Closing the overview tab or a
  worker split emits only `topology`/`notice` bridge messages — never `worker.removed` (the worker is
  still alive in the roster) and zero worker-side effects.
  *Accept:* tamper test — after overview + split close, the native worker still completes and no
  second worker was spawned.
- **P4-R9 Liveness & id tracking.** `pane.moved` rewrites stored ids (V-HDR-3); `pane.exited`
  distinguishes viewer-process crash from user close (U-HDR-3); `workspace.closed` tears down cleanly.
  *Accept:* mocked event feed: move → subsequent close matches new id; exit → `notice` emitted, no
  auto-reopen; workspace close → manager inert.
- **P4-R10 `events_lost` recovery.** On `events_lost`, resubscribe, await `subscription_started`,
  `snapshot()`, reconcile owned ids, then resume (V-HDR-4). Viewer liveness is always
  authoritative-read verifiable, never purely event-derived.
  *Accept:* forced `events_lost` → subscription re-established and stored state matches snapshot.
- **P4-R11 Fail-soft degradation (FR-12).** Any adapter error → `notice` + `degraded` state; the OMP
  turn is never blocked or delayed by topology work (all calls async, bounded timeouts).
  *Accept:* adapter throwing on every call → `notice` emitted once, spawn signals still flow to P2/P3.
- **P4-R12 `topology` messages.** Every open/closed transition emits `{v:1,type:"topology",tabId?,
  paneIds:[…],state:"open"|"closed"}` on the bridge (SDD §7).
  *Accept:* bridge spy receives `topology` on open, close, and reopen with correct `paneIds`.
- **P4-R13 Friendly metadata, never agent semantics.** `reportMetadata` sets a title/state label on
  owned panes (V-HDR-7); the viewer stays an ordinary pane occupant.
  *Accept:* mocked adapter records `reportMetadata` with title only; U-HDR-1 live check — the pane
  does not appear in Herdr's Agents view.

## Interfaces produced / consumed

```ts
// src/extension/topology.ts — produced
export type TopologyState = "closed" | "opening" | "open" | "degraded";
export interface TopologyManager {
  // fed by P2's Roster.onRosterSignal("roster.spawned") — auto-open / reopen-on-next-subtask
  onWorkerSpawned(): Promise<void>;
  onWorkerFinished(workerId: string): void;  // drop worker-split binding only; never worker effects
  openWorkerSplit(workerId: string, dir?: "right" | "down"): Promise<{ paneId: string }>;
  state(): TopologyState;
  stop(): Promise<void>;                     // end subscription + tracking; owned pane policy = Q-01
}
export function createTopologyManager(
  ctx: CallerContext, viewerCommand: string,
  emit: (m: Message) => void,                // bridge publisher: "topology" + "notice"
): TopologyManager;
```

Consumed (unchanged, from P1): `CallerContext`, `isHerdrEnv`/`callerContext` (gate already active),
`createOverviewTab`, `splitPane`, `runInPane`, `subscribeLifecycle` (with the concrete
`LifecycleHandlers` now defined in P1: `tab.closed`, `pane.closed`, `pane.exited`, `pane.moved`,
`workspace.closed`, `layout.updated`, `events_lost`), `getPane`, `snapshot`, `reportMetadata`,
`Message`/`encodeMessage`. From P2: the per-worker `RosterSignal` — `worker.spawned` →
`onWorkerSpawned`, `worker.finished` → `onWorkerFinished`, `roster.empty` (P2 provides these
dedicated signals; topology does **not** re-derive finish from `roster.onChange`). `roster.onChange`
remains the general snapshot stream for P3/P5. From P3: `viewerCommand` — the CLI invocation string.
P4 launches the viewer with `env = { LENS_SOCKET_PATH: CallerContext.socketPath, LENS_SESSION:
<session id> }` via the P1 `createOverviewTab`/`splitPane` `env` argument; P3's `connectBridge` reads
those env vars (ratified in `00-reconciliation.md`).

## Risks

- **R-03 / U-HDR-1** viewer pane auto-detected as an agent → P4 live test + `reportMetadata`-only
  presentation (P4-R13).
- **R-06** `layout.apply` with `tab_id` kills the tab and emits an indistinguishable `tab.closed`
  → guarded by P4-R6 + P1-R5 adapter ban.
- **R-07 / V-HDR-4** events not durable, ordering only per-subscription-entry → P4-R9/R10;
  reconcile is authoritative, events are hints.
- **U-HDR-2..5** (focus in non-focused workspace, `pane.exited` payload, double-create race,
  `events.wait` coexistence) → resolved by the isolated-session live tests before DoD sign-off.

## Open questions (phase-specific)

- **Q-P4-1** `stop()` / extension unload: leave the user's viewer panes open or close them? *(recommend:
  leave them — closing the view is the user's prerogative; worker-close invariant symmetric.)*
- **Q-P4-2** Viewer process crash (`pane.exited` without close): emit `notice` only, or also auto-relaunch
  the viewer process in the surviving pane? *(recommend: notice only in v1 — a crashed view is not
  worth a surprising respawn.)*
- **Q-P4-3** Split policy: one split per worker, cap concurrent splits? *(recommend: cap = workers in
  roster, one split per worker id.)*

## Milestone (testable software at this gate)

In an **isolated named Herdr session** (never the daily workspace): spawn → no-focus `OMP subagents`
tab + viewer; close → next spawn reopens exactly once; split → no-focus worker split; kill Herdr
socket → OMP turns unaffected; tamper suite green (no duplicate workers, worker survives viewer close,
no forbidden calls, no focus theft). U-HDR-1..5 checklist answered with recorded evidence.
