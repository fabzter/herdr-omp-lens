# Phase P3 — Viewer rendering (spec)

- Version: v1 "The Window"
- Status: **Draft for owner review.**
- Depends on: P1 (protocol + herdr adapter + gate), P2 (bridge publisher emitting the v1 message
  stream). Runs in parallel with P2 once P1's protocol contract is fixed (master plan §4).
- Produces interfaces for: P4 (topology launches/locates the viewer process), P5 (transcript source
  reused for persisted-history scan).
- Source of truth: `../../superpowers/specs/2026-11-19-herdr-omp-lens-design.md` (SDD §4, §5, §7, §9,
  §10, §11).

> This is a phase **spec** (requirements + interfaces + acceptance), not a subplan. Per the
> long-horizon process, all v1 phase specs settle before any code subplan is written.

## Goal

Deliver the **Viewer CLI** (`src/viewer/`, SDD §4 component 2): an ordinary Herdr pane process that
connects to the local bridge, renders the session roster plus an OMP-like per-worker inspector and
live transcript, and offers read-only keyboard navigation — detail "close to OMP's native task view"
(ratified decision 4) while staying strictly read-only and bounded.

## Scope

In scope:
- Bridge **client**: versioned handshake `{v:1, role:"viewer", session:<id>}`, `hello` snapshot then
  delta application, boundary-validated decode (`decodeMessage`), reconnect with authoritative
  re-snapshot on gap.
- **Roster view**: one row per worker using `WorkerSnapshot` fields exactly (id, name?, agent, status,
  model?, activity?, counters{tokens,cost,requests,toolCount,durationMs}, updatedAt).
- **Inspector**: selected-worker's model identity, counters, current tool/activity, lineage (via
  `parentToolCallId`/`index` when surfaced), session file ref.
- **Live transcript**: tail `transcript.ref`'s `sessionFile` JSONL and/or stream-rendered deltas;
  prefer the production pipeline (`omp render`) for faithful display (SDD §9; probe caveat 4).
- **Finished-collapse** (FR-08) and read-only keyboard navigation (select, expand, scroll, quit).
- **`src/transcript/`** live-tail + render helpers consumed by P5's history scan.
- Fail-soft disconnect/reconnect/degraded rendering (FR-12), bounded buffers (NFR-03).

Out of scope (other phases): creating/placing tabs or splits, close/reopen orchestration, focus
behavior (P4); persisted-artifact history scan and not-live marking after restart (P5); any
`control.*` send path (v2, forbidden in v1); nested-worker tree and multi-session board (v2).

## Requirements & acceptance criteria

- **P3-R1 Bridge handshake + snapshot.** On connect the viewer sends `{v:1, role:"viewer",
  session:<id>}` and applies the `hello` roster verbatim; subsequent `worker.upsert`/
  `worker.removed`/`transcript.ref`/`topology`/`notice` frames update state. *Accept:* a scripted
  fake bridge emitting the six P1 message types produces the expected rendered roster; malformed or
  wrong-`v` lines are rejected via `decodeMessage` without crashing the UI.
- **P3-R2 Roster fidelity (FR-07).** Rows show status, agent, model, age/counters when present —
  matching the documented Agent Hub field set to the extent the stream exposes it (V-OMP-9).
  *Accept:* given a `WorkerSnapshot` fixture carrying all optional fields, the rendered row shows
  status/model/durationMs/tokens/cost/requests/toolCount; absent optionals degrade to blanks, not
  `undefined`/crashes.
- **P3-R3 Inspector fidelity (FR-07).** Selecting a worker shows current tool/activity, counters,
  model role + resolved model, and lineage fields when surfaced. *Accept:* fixture with
  `activity`/`counters`/model fields renders them; a worker missing them renders a valid inspector.
- **P3-R4 Live transcript (FR-07, §9).** `transcript.ref` frames make the viewer tail/render that
  worker's `sessionFile`; streaming text/thinking/toolcall deltas render close to OMP's native task
  view. *Accept:* pointing the viewer at a real probe `sessionFile` (Phase 0 artifact) renders
  message/tool-execution entries in order; **thinking visibility mirrors OMP's display setting**
  rather than dumping raw thinking (probe caveat 4).
- **P3-R5 Finished collapse (FR-08).** Workers in `completed`/`failed`/`aborted` collapse into a
  finished section by default; expanding reveals the worker + its result transcript. *Accept:* a
  roster fixture with finished workers renders them collapsed; expand reveals result content.
- **P3-R6 Read-only (FR-11).** The viewer exposes **no** control affordance and never emits any
  `control.*` frame or any other outbound frame besides the `hello` handshake. *Accept:* tamper test
  records all outbound bytes across a scripted session and asserts none match `control`/steer/
  revive/cancel; a keyboard-map audit test fails if a control binding is introduced.
- **P3-R7 Direct-only display (FR-10).** The viewer renders exactly the workers the stream reports —
  it never fabricates rows or merges other sessions. *Accept:* reducer test: unknown-id
  `transcript.ref`/`worker.removed` create no phantom rows; a second-session `hello` replaces state,
  it does not merge.
- **P3-R8 Fail-soft (FR-12, NFR-02).** Disconnect, `events_lost`-style gaps, or decode failures
  degrade to a `notice` + reconnect-with-`hello` resync; the viewer never panics and never blocks the
  bridge. *Accept:* killing the fake bridge mid-stream shows a disconnected notice, then a clean
  resynced roster on restart.
- **P3-R9 Bounded resources (NFR-03).** Transcript tailing and the activity buffer are capped
  (rotate/snapshot); progress deltas are coalesced (≤150ms native coalescing already upstream).
  *Accept:* a >cap synthetic JSONL tail keeps memory/line-count bounded; coalescing test batches
  rapid `worker.upsert`s into bounded redraws.
- **P3-R10 No-focus, ordinary pane.** The viewer is a plain CLI process; it performs no Herdr calls
  itself and is never launched via `agent start` nor reported via `report_agent` (NFR-04, V-HDR-6).
  Optional presence metadata, if any, goes through `reportMetadata` only. *Accept:* guard test on
  `src/viewer/` fails if any `agent.start`/`report_agent`/`layout.apply`/`agent.view.set` call or
  focusing flag appears in viewer code.
- **P3-R11 Viewer state machine is pure.** Roster/selection/collapse state is a reducer over
  `Message` — unit-testable without a TTY or bridge. *Accept:* `applyMessage` unit tests cover all
  six message types plus unknown/rejected input, deterministically.

## Interfaces produced / consumed

```ts
// src/viewer/state.ts — produced (P4/P5 may reuse)
export interface ViewerState {
  session?: string;
  workers: Map<string, WorkerSnapshot>;
  finishedCollapsed: boolean;              // default true (FR-08)
  selectedId?: string;
  notices: { level: "info" | "warn" | "error"; message: string }[];
  live: boolean;                           // false after disconnect until re-hello
}
export function applyMessage(s: ViewerState, m: Message): ViewerState;  // pure

// src/viewer/bridge.ts — produced
export function connectBridge(socketPath: string): Promise<BridgeClient>;
export interface BridgeClient {
  onMessage(cb: (m: Message) => void): void;
  onStatus(cb: (s: "connected" | "reconnecting" | "closed") => void): void;
  close(): Promise<void>;                  // never sends control.* (P3-R6)
}

// src/transcript — produced here, consumed by P5
export function tailSessionFile(path: string, fromByte?: number): AsyncIterable<TranscriptEntry>;
export function renderWorkerTranscript(ref: { sessionFile: string; artifactDir?: string }): Promise<string>; // omp render path
```

Consumed (P1 names, unchanged): `PROTOCOL_VERSION`, `WorkerSnapshot`, `WorkerStatus`, `Message`,
`encodeMessage`/`decodeMessage`; `CallerContext.socketPath` (from P4's launch env); `reportMetadata`
(P4-driven only). Field names mirror observed payloads: `status` ∈ running|idle|parked|completed|
failed|aborted, `counters` ← `progress.{tokens,cost,requests,toolCount,durationMs}`,
model ← `resolvedModelIdentity`/`modelRole`, activity ← `recentTools`/`recentOutput`.

## Risks

- **Transcript rendering parity (R-04-adjacent):** `omp render` fidelity vs. per-delta rendering —
  mitigated by preferring the production pipeline and accepting `omp render` output as the fidelity
  bar (SDD §9).
- **Thinking leakage:** raw thinking deltas must honor OMP's display visibility (probe caveat 4) —
  acceptance in P3-R4.
- **Pane mis-detection (R-03/U-HDR-1):** viewer content could pattern-match Herdr's agent detection —
  P4 live-tests; P3 keeps the viewer out of `agent.*` entirely (P3-R10).
- **Backpressure:** a burst of transcript deltas flooding the bridge — bounded buffers + coalescing
  (P3-R9, NFR-03).

## Open questions (phase-specific)

- **Q-P3-1** Render strategy per worker: incremental delta rendering vs. periodic `omp render`
  refresh for the selected worker? *(recommend: deltas live + `omp render` on selection/reopen)*
- **Q-P3-2** Keyboard-map parity target: mirror OMP task-view bindings where reasonable, or minimal
  set (select/expand/scroll/quit)? *(recommend: minimal set in v1)*

## Milestone (testable software at this gate)

`bun test` green for reducer, bridge-client, transcript-tail, finished-collapse, and the
read-only/no-focus tamper tests; `bun run typecheck`/`lint` green; a demo run against a **fake
bridge** (or P2 publisher) plus a real probe `sessionFile` renders roster + inspector + transcript
with correct collapse and a clean disconnect/resync — without creating any Herdr layout itself.
