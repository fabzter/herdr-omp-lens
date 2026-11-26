# Phase P3 — Viewer rendering (spec)

- Version: v1 "The Window"
- Status: **Draft for owner review.**
- Depends on: P1 (protocol + herdr adapter + gate), P2 (bridge publisher emitting the v1 message
  stream). Runs in parallel with P2 once P1's protocol contract is fixed (master plan §4).
- Produces interfaces for: P4 (topology launches/locates the viewer process; `/lens split <id>`
  targets the worker-scoped mode), P5 (transcript source reused for persisted-history scan —
  `omp render <sessionFile>` is confirmed host-less).
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
- **Roster view**: one row per worker using the locked `WorkerSnapshot` shape verbatim —
  `id`, `name?`, `agent`, `status` (`"queued" | "running" | "idle" | "parked" | "completed" |
  "failed" | "aborted"`), `model?`, `activity?`, `sessionFile?`, `counters{tokens?,cost?,requests?,
  toolCount?,durationMs?}`, `parentToolCallId?`, `index?`, `modelRole?`, `thinkingLevel?`,
  `assignment?`, `historical?`, `updatedAt`.
- **Inspector**: selected-worker's model role + resolved model, thinking level, assignment,
  counters, current tool/activity, lineage (`parentToolCallId`/`index`), session-file ref.
- **Historical entries** (RC-3): `hello.history` and `worker.upsert` frames carrying
  `historical:true` render with a **not-live** label; a live `worker.upsert` for the same id replaces
  the historical entry (live-wins dedupe is performed upstream by P5; the viewer just renders what
  the stream reports).
- **Live transcript**: tail `transcript.ref`'s `sessionFile` JSONL and/or stream-rendered deltas;
  prefer the production pipeline (`omp render <sessionFile>`) for faithful display (SDD §9; probe
  caveat 4). New probe evidence (2026-11-24): `omp render <sessionFile>` exits 0 **host-less**;
  `omp read history://<id>` fails without the owning live session registry, so the viewer **never**
  uses `history://` URIs.
- **Thinking visibility** (D4): a viewer-side **toggle**, default **hidden** — there is no
  documented OMP API to read the host's thinking-display setting, so the viewer owns this state.
- **Worker-scoped mode** (D3): `omp lens --worker <id>` / `LENS_WORKER_ID` renders a single worker's
  inspector + transcript directly; this is the view the read-only `/lens split <id>` flow launches
  (the slash command and the pane-split mechanics themselves are P4).
- **Finished-collapse** (FR-08) and read-only keyboard navigation (select, expand, scroll, thinking
  toggle, quit).
- **`src/transcript/`** live-tail + render helpers consumed by P5's history scan; persisted workers
  resolve under `~/.omp/agent/sessions/<encoded-cwd>/<ts>_<session-id>/<worker-id>.jsonl` (observed
  2026-11-24; the earlier `$TMPDIR` path was a `--no-session` artifact).
- Fail-soft disconnect/reconnect/degraded rendering (FR-12), bounded buffers (NFR-03).

Out of scope (other phases): creating/placing tabs or splits, close/reopen orchestration, focus
behavior, the `/lens` slash-command registration and split mechanics (P4); the persisted-artifact
history scan, merge, and `historical` marking itself (P5 produces them — P3 only renders the
not-live label); any `control.*` send path (v2, forbidden in v1); nested-worker tree and
multi-session board (v2).

## Requirements & acceptance criteria

- **P3-R1 Bridge handshake + snapshot.** On connect the viewer sends the `ClientMessage`
  `{v:1, role:"viewer", session:<id>}` and applies the `hello` roster (plus `hello.history`, RC-3)
  verbatim; subsequent `worker.upsert`/`worker.removed`/`transcript.ref`/`topology`/`notice` frames
  update state. *Accept:* a scripted fake bridge emitting the six P1 message types produces the
  expected rendered roster; malformed or wrong-`v` lines are rejected via `decodeMessage` without
  crashing the UI.
- **P3-R2 Roster fidelity (FR-07).** Rows show status (including `queued`), agent, model,
  age/counters when present — matching the documented Agent Hub field set to the extent the stream
  exposes it (V-OMP-9). *Accept:* given a `WorkerSnapshot` fixture carrying all optional fields, the
  rendered row shows status/model/durationMs/tokens/cost/requests/toolCount; absent optionals
  degrade to blanks, not `undefined`/crashes.
- **P3-R3 Inspector fidelity (FR-07).** Selecting a worker shows `assignment`, current
  tool/activity, counters, `modelRole` + resolved `model`, `thinkingLevel`, and lineage
  (`parentToolCallId`/`index`) when surfaced. *Accept:* fixture with `activity`/`counters`/model/
  lineage fields renders them; a worker missing them renders a valid inspector.
- **P3-R4 Live transcript (FR-07, §9).** `transcript.ref` frames make the viewer tail/render that
  worker's `sessionFile`; streaming text/toolcall deltas render close to OMP's native task view.
  Transcript rendering for persisted files uses `omp render <sessionFile>` (verified host-less,
  exit 0 — never `history://<id>`, which requires the owning live registry). *Accept:* pointing the
  viewer at a real probe `sessionFile` (Phase 0 artifact) renders message/tool-execution entries in
  order.
- **P3-R5 Thinking toggle (D4).** Thinking deltas render only when the viewer toggle is on;
  **default hidden**. The toggle is a viewer-local keybinding/state, never fetched from OMP (no
  documented API) — it must not dump raw thinking by default (probe caveat 4). *Accept:* a fixture
  containing `thinking_*` deltas renders no thinking text at default; after toggling, the same
  fixture shows it; state survives worker re-selection.
- **P3-R6 Finished visibility (FR-08, amended v1.2 — owner UX decision 2026-11-25).** Workers in
  `completed`/`failed`/`aborted` render in a `finished (N):` section BY DEFAULT and persist after
  `worker.removed` (retention ≤100); `e` collapses on demand. *Accept:* a roster fixture with
  finished workers renders their rows without any keypress; collapse hides them; a removed finished
  worker stays listed. *(Original v1: collapsed by default; expanding revealed results.)*
- **P3-R7 Read-only (FR-11).** The viewer exposes **no** control affordance and never emits any
  `control.*` frame or any other outbound frame besides the `ClientMessage` handshake. The
  `/lens split <id>` command is itself read-only — it launches a scoped view, it does not steer,
  revive, or cancel a worker (D3). *Accept:* tamper test records all outbound bytes across a
  scripted session and asserts none match `control`/steer/revive/cancel; a keyboard-map audit test
  fails if a control binding is introduced.
- **P3-R8 Direct-only display (FR-10).** The viewer renders exactly the workers the stream reports —
  it never fabricates rows or merges other sessions. *Accept:* reducer test: unknown-id
  `transcript.ref`/`worker.removed` create no phantom rows; a second-session `hello` replaces state,
  it does not merge.
- **P3-R9 Historical / not-live label (RC-3).** Entries with `historical:true` — from
  `hello.history` or `worker.upsert` — render a **not-live** badge and cannot be selected into the
  live-transcript path; a later live `worker.upsert` for the same id clears the badge. *Accept:*
  fixture `hello{workers:[live], history:[historical]}` renders both sections with the label; a
  follow-up upsert for a historical id replaces the badge with live state.
- **P3-R10 Fail-soft + degraded (FR-12, NFR-02, D1).** Disconnect, sequence gaps, or decode
  failures degrade to a `notice` + reconnect-with-`hello` resync; when P2 reports bus-degraded
  operation via `notice`/`hello`-only history, the viewer renders a **degraded** banner and the
  not-live roster rather than promising live counters (D1 relaxes FR-02/04/10 live guarantees in
  that mode). The viewer never panics and never blocks the bridge. *Accept:* killing the fake
  bridge mid-stream shows a disconnected notice, then a clean resynced roster on restart; a
  `notice{level:"warn"}` + history-only `hello` renders the degraded banner.
- **P3-R11 Bounded resources (NFR-03, D5).** Transcript tailing and the activity buffer are capped
  (rotate/snapshot); progress deltas are coalesced (≤150ms native coalescing already upstream).
  Verification is a **deterministic frame-volume test**, not a wall-clock soak: replay e.g. 50k
  transcript frames / `worker.upsert`s and assert bounded heap + bounded retained lines. *Accept:*
  a >cap synthetic JSONL tail and a 50k-frame replay keep memory/line-count bounded; coalescing
  test batches rapid `worker.upsert`s into bounded redraws.
- **P3-R12 No-focus, ordinary pane, no Herdr calls (RC-7, NFR-04, V-HDR-6).** The viewer is a plain
  CLI process; it performs **no** Herdr calls itself — not `reportMetadata`, not `agent start`,
  never `report_agent`, never `layout.apply`/`agent.view.set` (all presentation reporting is
  P4-driven; the viewer is never reported as an agent). *Accept:* guard test on `src/viewer/` fails
  if any `agent.start`/`report_agent`/`report_metadata`/`layout.apply`/`agent.view.set` call or
  focusing flag appears in viewer code.
- **P3-R13 Worker-scoped mode (D3).** Launched with `--worker <id>` or `LENS_WORKER_ID`, the viewer
  renders only that worker's inspector + transcript (no roster); an unknown/gone id renders a
  not-found notice, not a crash. Still fully read-only. *Accept:* fixture stream with multiple
  workers renders only the scoped id; unknown id renders the notice.
- **P3-R14 Viewer state machine is pure.** Roster/selection/collapse/thinking-toggle state is a
  reducer over `Message` — unit-testable without a TTY or bridge. *Accept:* `applyMessage` unit
  tests cover all six message types plus `historical` entries plus unknown/rejected input,
  deterministically.

## Interfaces produced / consumed

```ts
// src/viewer/state.ts — produced (P4/P5 may reuse)
export interface ViewerState {
  session?: string;
  workers: Map<string, WorkerSnapshot>;     // includes historical entries; flag carries the label
  finishedCollapsed: boolean;               // default false since v1.2 (FR-08 amended, owner decision)
  thinkingVisible: boolean;                 // default false — viewer toggle (D4)
  selectedId?: string;
  scope?: { workerId?: string };            // worker-scoped mode (D3); set from LENS_WORKER_ID/--worker
  degraded: boolean;                        // set by warn notice / history-only hello (D1)
  notices: { level: "info" | "warn" | "error"; message: string }[];
  live: boolean;                            // false after disconnect until re-hello
}
export function applyMessage(s: ViewerState, m: Message): ViewerState;  // pure

// src/viewer/env.ts — produced; the F-01 handoff
// P4 launches the viewer with env = { LENS_SOCKET_PATH: <BridgeHandle.socketPath — the BRIDGE
// socket>, LENS_SESSION: <OMP session id>, LENS_WORKER_ID?: <scoped worker> }.
// NEVER CallerContext.socketPath (that is HERDR's server socket) (F-01).
export interface ViewerEnv { socketPath: string; session: string; workerId?: string }
export function viewerEnv(env?: NodeJS.ProcessEnv): ViewerEnv | null;   // reads LENS_* vars

// src/viewer/bridge.ts — produced
export function connectBridge(v: ViewerEnv): Promise<BridgeClient>;
export interface BridgeClient {
  onMessage(cb: (m: Message) => void): void;
  onStatus(cb: (s: "connected" | "reconnecting" | "closed") => void): void;
  close(): Promise<void>;                  // never sends control.* (P3-R7)
}

// src/transcript — produced here, consumed by P5
export function tailSessionFile(path: string, fromByte?: number): AsyncIterable<TranscriptEntry>;
export function renderWorkerTranscript(ref: { id?: string; sessionFile: string; artifactDir?: string }): Promise<string>;
// ^ shells to `omp render <sessionFile>` — confirmed host-less (exit 0). NEVER `history://<id>`:
// it resolves only inside the owning live session registry.
```

Consumed (P1 names, unchanged): `PROTOCOL_VERSION`, `WorkerSnapshot`, `WorkerStatus` (incl.
`"queued"`), `Message` (incl. `hello.history?` and `transcript.ref{id, sessionFile, artifactDir?}`),
`ClientMessage` (`{v:1, role:"viewer", session}` — the only outbound frame), `encodeMessage`/
`decodeMessage`. Launch env is `LENS_SOCKET_PATH` (= `BridgeHandle.socketPath`) + `LENS_SESSION` +
optional `LENS_WORKER_ID` (F-01; **never** `CallerContext.socketPath`). The viewer entry point is
resolved by P1 `resolveViewerCommand()` against the package root (F-16). `reportMetadata` is **not**
consumed — reporting orchestration is P4-only (RC-7). Field names mirror observed payloads:
`status` ∈ queued|running|idle|parked|completed|failed|aborted, `counters` ← the **nested**
`task:subagent:progress.progress.{tokens,cost,requests,toolCount,durationMs}` (F-02), model ←
`progress.{modelRole,resolvedModelIdentity,resolvedThinkingLevel}`, activity ←
`recentTools`/`recentOutput`.

## Risks

- **Transcript rendering parity (R-04-adjacent):** `omp render` fidelity vs. per-delta rendering —
  mitigated by preferring the production pipeline and accepting `omp render` output as the fidelity
  bar (SDD §9). Host-less `omp render <sessionFile>` is probe-verified (exit 0).
- **Thinking leakage:** there is no documented OMP API for the host's thinking-display setting —
  D4 makes it a viewer toggle default-hidden instead of mirroring; acceptance in P3-R5.
- **Pane mis-detection (R-03/U-HDR-1):** viewer content could pattern-match Herdr's agent detection —
  P4 live-tests; P3 keeps the viewer out of `agent.*`/`report_metadata` entirely (P3-R12).
- **Backpressure:** a burst of transcript deltas flooding the bridge — bounded buffers + coalescing
  + the deterministic volume test (P3-R11, D5), not a 10-minute soak.
- **Degraded bus (D1):** without the native bus there is no live discovery/counters — the viewer
  must present history + notices honestly (degraded banner, not-live labels) rather than implying
  liveness.

## Open questions (phase-specific)

- **Q-P3-1** Render strategy per worker: incremental delta rendering vs. periodic `omp render`
  refresh for the selected worker? *(recommend: deltas live + `omp render` on selection/reopen —
  `omp render` is now confirmed host-less)*
- **Q-P3-2** Keyboard-map parity target: mirror OMP task-view bindings where reasonable, or minimal
  set (select/expand/scroll/thinking-toggle/quit)? *(recommend: minimal set in v1)*

## Milestone (testable software at this gate)

`bun test` green for reducer (incl. historical/degraded paths), bridge-client, transcript-tail,
thinking-toggle, worker-scoped mode, finished-collapse, the 50k-frame boundedness test, and the
read-only/no-focus tamper tests; `bun run typecheck`/`lint` green; a demo run against a **fake
bridge** (or P2 publisher) plus a real probe `sessionFile` renders roster + inspector + transcript
with correct collapse and a clean disconnect/resync — without creating any Herdr layout itself.
