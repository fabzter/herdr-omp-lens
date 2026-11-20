# Phase P2 — Extension observation (spec)

- Version: v1 "The Window"
- Status: **Draft for owner review.**
- Depends on: P0 (done — bus confirmed, `../../analysis/phase-0-probe-report.md`), P1 (foundation:
  protocol types, Herdr adapter, activation gate).
- Produces interfaces for: P3 (viewer — bridge socket + `worker.upsert`/`transcript.ref` stream),
  P4 (topology — per-worker spawn/finish signals for auto-open/reopen), P5 (history — `sessionFile`
  refs + live roster for merge).
- Source of truth: `../../superpowers/specs/2026-11-19-herdr-omp-lens-design.md` (FR-02, FR-03,
  FR-07, FR-10, FR-11, FR-12; NFR-01..03; §7 protocol; §10 invariants).

> Phase spec: requirements + interfaces + acceptance, not a subplan. All v1 phase specs settle before
> any code subplan.

## Goal

Inside the gated extension (P1's `lensExtension` activates only in Herdr), subscribe to the native
`task:subagent:*` bus, reduce frames into a **direct-workers-only roster**, and publish it over the
local unix-socket NDJSON bridge — feature-detected, fail-soft, read-only. No viewer rendering (P3)
and no tab/pane orchestration (P4) here.

## Scope

In scope:
- `src/extension/observe/` — `pi.events.on` subscriptions to `task:subagent:event|progress|lifecycle`
  plus the `before_subagent_spawn` hook; feature-detection of `pi.events` and payload shapes.
- `src/extension/roster/` — session-scoped reducer: bus frames → `WorkerSnapshot[]` with the status
  mapping below; direct-only filter; activity summaries from `recentTools`/`recentOutput`; per-worker
  signals for P4.
- `src/extension/bridge/` — unix-socket server (0600, `$TMPDIR`-scoped path), versioned handshake,
  `hello` snapshot then `worker.upsert`/`worker.removed`/`transcript.ref`/`notice` deltas; bounded
  buffers; progress coalescing (≤150 ms, NFR-03).
- Fallback path — bus absent or shape drift → degrade to artifact polling of `sessionFile` JSONL +
  one `notice` (SDD §10); never throw into an OMP turn.
- Confirmation probes (acceptance): real interactive-TUI run; `idle`/`parked`/`aborted` transitions
  exercised where reachable and the observed vocabulary recorded.

Out of scope: viewer CLI/rendering (P3), tab/split creation, close-detect, reopen (P4), restart
history scan (P5), tamper-test suite + release (P6), any `control.*` handling beyond rejection (v2).

## Requirements & acceptance criteria

- **P2-R1 Bus subscription (FR-02).** On activation, subscribe via `pi.events.on` to all three
  `task:subagent:*` channels and `pi.on("before_subagent_spawn")`. Feature-detect first: if
  `pi.events` or a channel is absent, degrade per P2-R8 instead of throwing.
  *Accept:* integration test spawns a task worker; frames arrive on all three channels with the
  observed field names (`id`, `parentToolCallId`, `sessionFile`, `status`; `progress.{recentTools,
  recentOutput,toolCount,requests,tokens,cost,durationMs,modelRole,resolvedModelIdentity}`;
  `event.type` union).
- **P2-R2 Interactive-TUI confirmation (probe caveat 1).** Repeat the P0 check in a real TUI session,
  not print mode. *Accept:* extension loaded in an interactive session inside an isolated named Herdr
  session observes frames for a spawned worker; findings appended to the probe report.
- **P2-R3 Direct-only scope (FR-10, ratified #6).** A worker joins the roster only if it is a direct
  `task` worker of the current session: its `lifecycle.parentToolCallId` matches a `task` tool call in
  the parent session (correlated via `before_subagent_spawn.spawnKey`/`parentToolCallId` tracking).
  Nested workers (depth ≥ 2, V-OMP-4) and other sessions' workers are excluded.
  *Accept:* unit tests feed nested/foreign frames → absent from roster; integration test with a worker
  that itself delegates shows only the direct child.
- **P2-R4 Roster reducer + status mapping (FR-02/FR-07).** Frames reduce to `WorkerSnapshot` per P1.
  Mapping: `lifecycle.started`→`running` (or `queued` if a pre-start frame is later observed);
  `progress.status` is authoritative while live (`running`→`running`, `completed`→`completed`);
  terminal `lifecycle` status wins (`completed`/`failed`/`aborted`); `idle`/`parked` map verbatim
  when observed. Unrecognized status strings keep the last known status and emit a `notice`.
  `counters` map verbatim from `progress` (`tokens`, `cost`, `requests`, `toolCount`, `durationMs`);
  `model` from `resolvedModelIdentity` (+`resolvedThinkingLevel` when set); `activity` from latest
  `recentTools`/`recentOutput`. *Accept:* reducer unit tests cover each transition, counter mapping,
  and unknown-status passthrough.
- **P2-R5 Unexercised transitions (probe caveat 2).** Attempt to drive `idle`, `parked`, `aborted`
  (e.g. idle-TTL parking, parent abort) and record the actual emitted vocabulary.
  *Accept:* evidence appended to the probe report; any newly observed status names are added to the
  mapping table; unreachable transitions are marked provisional in docs, not guessed.
- **P2-R6 Bridge publisher (FR-03, NFR-01).** Unix socket only (0600), no network interface. On
  viewer connect + valid `{v:1, role:"viewer", session}` handshake: send `hello` with the current
  roster, then deltas. `transcript.ref` fires once `lifecycle` delivers `sessionFile`. Progress
  frames coalesce to ≤150 ms; outbound buffers bounded; slow viewers are dropped with a `notice`,
  never allowed to stall the bus handler. *Accept:* socket-permission and no-listener-on-network
  tests; handshake, snapshot-then-delta, coalescing, and slow-consumer tests pass.
- **P2-R7 Read-only + no side effects (FR-11/FR-14, NFR-04).** The extension never emits `control.*`,
  never writes to `agent://`, never calls Herdr mutating commands, and its subscribers never mutate
  OMP state. *Accept:* guard test scans the extension source for forbidden calls and fails if any
  appear; bridge rejects an injected `control.steer` frame (P1-R4 path) and the worker is unaffected.
- **P2-R8 Fail-soft (FR-12, NFR-02).** Missing bus, shape drift, socket errors, or subscriber throws
  degrade to a single `notice` (+ artifact-polling fallback for roster liveness) and never propagate
  into the OMP turn loop. *Accept:* fault-injection tests (no `pi.events`, malformed frames, dead
  socket) leave a spawned task running to completion.
- **P2-R9 Late-attach behavior (U-OMP-5).** Workers already running when the extension activates are
  adopted from their next `progress`/`event` frame if `parentToolCallId` correlates; otherwise
  excluded and documented. *Accept:* test activates mid-run and asserts the documented outcome
  either way; the limitation is written into the spec/notes.
- **P2-R10 Worker signals for topology (P4 seam).** The roster emits a typed signal on **every**
  worker add (`worker.spawned`, carrying the snapshot — P4's `onWorkerSpawned` needs every spawn for
  reopen-on-next-subtask, not just the first), on terminal transition (`worker.finished`, carrying id
  + final snapshot → P4's `onWorkerFinished`), and on drain (`roster.empty`). Observation only; no
  Herdr calls from P2. *Accept:* unit test — two spawns emit two `worker.spawned` signals (incl.
  non-empty→non-empty); a terminal status emits `worker.finished`; last removal emits `roster.empty`.

## Interfaces produced (consumed by later phases)

```ts
// src/extension/observe — raw bus intake (validated at the boundary, Zod)
export interface SubagentLifecycle { id: string; agent: string; parentToolCallId: string;
  detached?: boolean; agentSource?: string; status: string; sessionFile?: string; index?: number }
export interface SubagentProgress { id: string; status: string;
  recentTools?: { tool: string; isError?: boolean; endMs?: number }[]; recentOutput?: string[];
  toolCount?: number; requests?: number; tokens?: number; cost?: number; durationMs?: number;
  modelOverride?: string[]; modelRole?: string; contextWindow?: number;
  resolvedModelIdentity?: string; resolvedThinkingLevel?: string }
export interface SubagentEvent { id: string; event: { type: string; [k: string]: unknown } }

// src/extension/roster — reducer + signal surface
export type RosterSignal =
  | { type: "worker.spawned"; worker: WorkerSnapshot }
  | { type: "worker.finished"; id: string; worker: WorkerSnapshot }
  | { type: "roster.empty" };
export interface Roster {
  applyLifecycle(f: SubagentLifecycle): void;
  applyProgress(f: SubagentProgress): void;
  applyEvent(f: SubagentEvent): void;           // activity only; no transcript bytes on the bridge
  snapshot(): WorkerSnapshot[];                 // P1 type (live only; P5 merges history)
  onChange(cb: (w: WorkerSnapshot) => void): void;
  onSignal(cb: (s: RosterSignal) => void): void;                // feeds P4 TopologyManager
}

// src/extension/bridge — publisher
export interface BridgeHandle { socketPath: string; broadcast(m: Message): void;
  close(): Promise<void> }
export function startBridge(roster: Roster, opts: { socketPath: string }): Promise<BridgeHandle>;
```

Consumed from P1: `PROTOCOL_VERSION`, `WorkerStatus`, `WorkerSnapshot`, `Message`,
`encodeMessage`/`decodeMessage`, `lensExtension` gate, `isHerdrEnv`/`callerContext`. Consumed by P3:
the bridge socket + message stream (`connectBridge(socketPath)`); by P4: `RosterSignal` →
`onWorkerSpawned`/`onWorkerFinished`, plus `broadcast` as its `emit` for `topology`; by P5:
`snapshot()` + `WorkerSnapshot.sessionFile` refs.

## Risks

- **Status vocabulary drift** (observed only `started`/`running`/`completed`): mitigated by P2-R5
  probing, unknown-status passthrough, and `notice` — never a crash (NFR-02).
- **TUI/print divergence** (probe caveat 3, `detached:true`): P2-R2 acceptance before P3/P4 rely on
  the stream.
- **`pi.events` is undocumented upstream**: feature-detect + fail-soft per R-01 fallback; version-pin
  OMP 19.0.1.
- **Nested-frame bleed** (V-OMP-4: depth ≥ 2 frames ride the same bus): P2-R3 filter is tamper-tested.
- **Bridge backpressure**: bounded buffers + drop-slow-viewer (NFR-03) so a stalled viewer can't block
  an OMP turn (FR-12).

## Open questions (settle before subplan)

- Does `progress.status` alone carry `idle`/`parked`, or only `lifecycle`? (Resolved empirically by
  P2-R5; mapping table is the artifact.)
- Socket path convention: `$HERDR_SOCKET_PATH`-adjacent vs own `$TMPDIR` path handed to the viewer via
  env/argv? *(recommend: own path; P4 passes it via `runInPane` env — matches P3's launch-env
  assumption)*
- Coalescing window fixed at 150 ms or configurable? *(recommend: constant per NFR-03)*

## Milestone (testable software at this gate)

`bun test` green: reducer transitions + direct-only filter, bridge handshake/snapshot/delta/
coalescing/slow-consumer, fail-soft fault injection, and the read-only source guard. TUI
confirmation (P2-R2) and transition probes (P2-R5) recorded in the probe report. A throwaway script
can connect to the bridge in an isolated session and print roster JSON as a worker runs — no view,
no topology yet.
