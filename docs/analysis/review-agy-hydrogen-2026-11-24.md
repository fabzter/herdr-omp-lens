# Adversarial Design Review: `herdr-omp-lens` (v1 "The Window")

Reviewed documents:
- SDD: `docs/superpowers/specs/2026-11-19-herdr-omp-lens-design.md`
- Master Plan: `docs/plans/00-master-plan.md`
- Cross-spec Reconciliation: `docs/plans/specs/00-reconciliation.md`
- Phase 0 Probe Report: `docs/analysis/phase-0-probe-report.md`
- Seam Research: `docs/analysis/research-seams.md`
- ADR-0001: `docs/adr/0001-observation-seam.md`
- Phase Specs P1–P6: `docs/plans/specs/phase-01-foundation-spec.md` … `phase-06-hardening-spec.md`

## Brief Assessment of What Is Solid

- **Core architecture (`ADR-0001`):** In-process OMP extension + local `0600` unix-socket NDJSON bridge + ordinary-pane viewer is the right local-only seam given no TUI `attach` API (`U-OMP-9`) and avoids hosted relays and worker duplication.
- **Herdr hazard awareness:** Avoiding `layout.apply` with `tab_id` (`V-HDR-5`), avoiding `agent start`/`report_agent`/`agent.view.set` (`V-HDR-6/7`), subscribing before creating, and treating `events.subscribe` as non-durable hints backed by `snapshot()`/`getPane()` (`V-HDR-4`) are all sound design choices—provided the implementation bugs and cross-spec contradictions below are fixed before subplans.

---

## Findings (18)

### F-01: `LENS_SOCKET_PATH` conflates Herdr's socket with the bridge socket, and `TopologyManager` never receives the bridge socket or session ID
- **severity:** critical
- **type:** cross-spec-contradiction / broken-interface
- **location:** `docs/plans/specs/phase-04-topology-spec.md` (§"Interfaces produced / consumed", lines 102–118); `docs/plans/specs/phase-03-viewer-spec.md` (§"Interfaces produced / consumed", line 118); `docs/plans/specs/00-reconciliation.md` (RC-4, lines 38–43); `docs/plans/specs/phase-01-foundation-spec.md` (`CallerContext`, line 82)
- **issue:** RC-4 requires P4 to launch the viewer with `env = { LENS_SOCKET_PATH: <bridge socket>, LENS_SESSION: <session id> }`. However, P4 (line 116) specifies `LENS_SOCKET_PATH: CallerContext.socketPath`, and P3 (line 118) repeats `CallerContext.socketPath (from P4's launch env)`. In P1 (`line 82`), `CallerContext.socketPath` is `$HERDR_SOCKET_PATH` (the **Herdr** server socket, `V-HDR-1`), not the OMP extension's bridge socket (`BridgeHandle.socketPath` from P2). Furthermore, `createTopologyManager(ctx: CallerContext, viewerCommand: string, emit)` (`phase-04-topology-spec.md:102–105`) has no parameter to receive either the bridge socket path or the OMP session ID.
- **why_it_matters:** The viewer will call `connectBridge(process.env.LENS_SOCKET_PATH)` against the Herdr daemon socket instead of the extension's NDJSON bridge, failing the handshake and completely breaking v1 observation.
- **suggested_fix:** Change `createTopologyManager` to accept `{ bridgeSocketPath: string; sessionId: string }` explicitly, replace `CallerContext.socketPath` with `bridgeSocketPath` in P4 line 116 and `BridgeHandle.socketPath` in P3 line 118, and add a unit/integration assertion that `LENS_SOCKET_PATH !== ctx.socketPath`.

### F-02: `SubagentProgress` flattens the observed nested `progress` object, breaking Zod validation on 100% of real frames
- **severity:** critical
- **type:** undocumented-api-mismatch / schema-bug
- **location:** `docs/plans/specs/phase-02-observation-spec.md` (§"Interfaces produced", lines 104–108); `docs/analysis/phase-0-probe-report.md` (§"Observed payload shapes", lines 61–69); `docs/plans/specs/phase-01-foundation-spec.md` (lines 111–113)
- **issue:** Phase 0 observed `task:subagent:progress` as `{"index":0,"agent":"scout","parentToolCallId":"...","detached":true,"assignment":"...","progress":{"id":"LensProbe","status":"running","recentTools":[...],"tokens":14114,...}}`. P2 defines `SubagentProgress` with `id`, `status`, `recentTools`, `tokens`, etc. at the top level instead of nested inside `.progress`.
- **why_it_matters:** P1 mandates Zod v4 boundary validation (`phase-01-foundation-spec.md:112–113`). A schema matching `SubagentProgress` as written in P2 will reject every real `task:subagent:progress` frame from OMP 19.0.1 and immediately trigger shape-drift degradation (`notice` + fallback) on the first spawn.
- **suggested_fix:** Update `SubagentProgress` in P2 to model the observed envelope `{ index?: number; agent?: string; agentSource?: string; parentToolCallId?: string; detached?: boolean; assignment?: string; progress: { id: string; status: string; recentTools?: ...; ... } }`, and add a P2 unit test running the Zod parser against raw frames captured from `probes/out/frames.jsonl`.

### F-03: `pi.events` TUI behavior and `idle`/`parked`/`aborted`/nested frames are unverified, and P2-R3's `before_subagent_spawn` correlation contradicts observed fields
- **severity:** critical
- **type:** unverified-assumption / broken-correlation
- **location:** `docs/analysis/phase-0-probe-report.md` (lines 21–31, 46–50, 96–108); `docs/plans/specs/phase-02-observation-spec.md` (P2-R3, lines 54–59); `docs/analysis/research-seams.md` (V-OMP-3, V-OMP-4, lines 27–36)
- **issue:** Phase 0 only ran print mode (`omp -p`, `detached:true`) with one `started→completed` scout. Interactive TUI mode, `idle`/`parked`/`aborted`/`failed` transitions, and nested depth-2 subagent frames were never captured. More concretely, P2-R3 (`lines 55–56`) claims direct workers are identified because `lifecycle.parentToolCallId` is "correlated via `before_subagent_spawn.spawnKey`/`parentToolCallId` tracking"—yet the observed `before_subagent_spawn` payload (`phase-0-probe-report.md:48–50`) has **no `parentToolCallId` field**, and `spawnKey` is `"LensProbe"` (which equals `lifecycle.id`, not `parentToolCallId`).
- **why_it_matters:** (1) `V-OMP-3` notes `subagentEventBus` is a UI-host embedding surface not explicitly contracted for `ExtensionAPI.pi.events`, so TUI mode could differ from print mode. (2) Without `parentToolCallId` on `before_subagent_spawn`—and without knowing whether `before_subagent_spawn` or `pi.on("tool_execution_start")` fires for depth-2 workers too—P2-R3 cannot reliably filter out nested workers (`FR-10`).
- **suggested_fix:** Run a bounded TUI + nested-subagent + abort/idle probe before writing P2 subplans to capture real TUI frames, nested `parentToolCallId` values, and whether `pi.on("tool_execution_start")` is parent-session-only; rewrite P2-R3 around the empirically verified correlation key.

### F-04: Fail-soft fallback ("artifact polling of `sessionFile` JSONL") cannot discover workers without the bus and rests on an unverified path assumption
- **severity:** high
- **type:** under-specified-fallback / unverified-claim
- **location:** `docs/superpowers/specs/2026-11-19-herdr-omp-lens-design.md` (§10, lines 195–196); `docs/plans/specs/phase-02-observation-spec.md` (lines 34–35, P2-R8 lines 83–86); `docs/analysis/phase-0-probe-report.md` (line 56); `docs/analysis/research-seams.md` (U-OMP-6, lines 79–80, 176)
- **issue:** When `pi.events` is absent or shape-drifts, SDD §10 and P2 fall back to "artifact polling of `sessionFile` JSONL". But `sessionFile` comes **from** `task:subagent:lifecycle`! Without the bus, there is no `sessionFile` to poll. Meanwhile, `phase-0-probe-report.md:56` observed `sessionFile` at `/var/folders/…/omp-task-15d5200b7f8a9636/LensProbe.jsonl` (`$TMPDIR`), not `~/.omp/agent/sessions/<encoded-cwd>/` (`V-OMP-8`, `P5-R1`), likely due to `--no-session`. `research-seams.md:176` marked `U-OMP-6` resolved solely because `lifecycle.sessionFile` was present, leaving directory-scanning path conventions unresolved.
- **why_it_matters:** If the undocumented bus fails, P2 has no specified discovery root, no polling interval, no direct-only filter (`FR-10`), and no P2-R8 acceptance test showing the fallback actually surfaces workers.
- **suggested_fix:** Probe where OMP 19.0.1 writes subagent JSONL files in a normal persisted TUI session (without `--no-session`), specify exact fallback directory scanning/polling/scoping in P2 + test it in P2-R8, or explicitly relax FR-02/FR-04/FR-10 when operating in degraded fallback mode.

### F-05: `Roster` signal method name, signal name, and callback signature mismatch across RC-1, P2, and P4
- **severity:** high
- **type:** cross-spec-contradiction
- **location:** `docs/plans/specs/00-reconciliation.md` (RC-1, lines 13–20); `docs/plans/specs/phase-02-observation-spec.md` (lines 112–123); `docs/plans/specs/phase-04-topology-spec.md` (lines 94–98, 112–115)
- **issue:** RC-1 defines `Roster.onRosterSignal` emitting `worker.spawned`, `worker.finished`, `roster.empty`. P2 (`line 122`) names the method `onSignal(cb: (s: RosterSignal) => void): void` instead of `onRosterSignal`. P4 (`line 95`) writes `Roster.onRosterSignal("roster.spawned")` (wrong signal name `"roster.spawned"` vs `"worker.spawned"`, and implies a string-filtered subscription signature), while `onWorkerSpawned(): Promise<void>` drops the worker snapshot and `onWorkerFinished(workerId: string)` expects a bare string ID.
- **why_it_matters:** P2 and P4 have incompatible TypeScript interfaces and event names; the coordinator's own reconciliation doc (`00-reconciliation.md`) disagrees with both P2 and P4.
- **suggested_fix:** Standardize on `onSignal(cb: (s: RosterSignal) => void): () => void` with `worker.spawned` / `worker.finished` / `roster.empty` across `00-reconciliation.md`, P2, and P4, and explicitly show the wiring function in P4.

### F-06: `WorkerSnapshot` omits lineage (`parentToolCallId`, `index`) and `modelRole` required by FR-07 and P3-R3
- **severity:** high
- **type:** cross-spec-contradiction / requirements-gap
- **location:** `docs/plans/specs/phase-01-foundation-spec.md` (`WorkerSnapshot`, lines 63–69); `docs/superpowers/specs/2026-11-19-herdr-omp-lens-design.md` (FR-07, lines 111–113); `docs/plans/specs/phase-03-viewer-spec.md` (lines 28–31, P3-R3 lines 54–56)
- **issue:** SDD FR-07 requires the inspector to show "current tool/activity, **lineage**", and P3-R3 explicitly states: "Selecting a worker shows current tool/activity, counters, **model role** + resolved model, and **lineage fields** when surfaced" (`parentToolCallId`/`index` on `line 30–31`). However, P1's `WorkerSnapshot` contains only `{ id, name?, agent, status, model?, activity?, sessionFile?, counters?, historical?, updatedAt }`—there are no `parentToolCallId`, `index`, `modelRole`, `resolvedThinkingLevel`, or `assignment` fields anywhere in `Message`.
- **why_it_matters:** P3 cannot implement or test P3-R3 ("lineage fields" and "model role") from the v1 protocol without violating P1's locked schema.
- **suggested_fix:** Add `parentToolCallId?: string`, `index?: number`, `modelRole?: string`, `thinkingLevel?: string`, and `assignment?: string` to `WorkerSnapshot` in P1 and populate them in P2's reducer.

### F-07: Client-to-server handshake is missing from P1's `Message` / `decodeMessage`, and `connectBridge` omits `session`
- **severity:** high
- **type:** orphaned-interface / cross-spec-gap
- **location:** `docs/plans/specs/phase-01-foundation-spec.md` (lines 70–79, P1-R3); `docs/plans/specs/phase-03-viewer-spec.md` (P3-R1 lines 44–48, `connectBridge` line 105); `docs/superpowers/specs/2026-11-19-herdr-omp-lens-design.md` (§7, lines 148–149)
- **issue:** The viewer must send `{ v: 1, role: "viewer", session: <id> }` on connect (`SDD §7`, `P3-R1`). Yet `phase-01-foundation-spec.md:70–76` defines `Message` exclusively with the 6 server→client messages and states `decodeMessage` rejects unknown types, leaving the client→server handshake untyped and unvalidated in `src/protocol/`. In addition, `connectBridge(socketPath: string)` (`phase-03-viewer-spec.md:105`) takes no `session` argument, forcing hidden `process.env.LENS_SESSION` reads inside the bridge client.
- **why_it_matters:** The extension's bridge server cannot validate the viewer's handshake with `decodeMessage`, and `connectBridge` cannot be unit-tested cleanly across sessions without mutating `process.env`.
- **suggested_fix:** Add `ClientMessage` (`{ v: 1; role: "viewer"; session: string }`) and `decodeClientMessage(line)` to `src/protocol/` in P1 (which also serves as the boundary rejecting `control.*` frames for P1-R4), and change `connectBridge` to `connectBridge(opts: { socketPath: string; session: string })`.

### F-08: RC-3 history transport is un-wired across P2/P3/P5, and P4's spawn-only open breaks P5-R6's post-restart history view
- **severity:** high
- **type:** cross-spec-contradiction / lifecycle-gap
- **location:** `docs/plans/specs/00-reconciliation.md` (RC-3, lines 30–37); `docs/plans/specs/phase-02-observation-spec.md` (lines 120, 128); `docs/plans/specs/phase-03-viewer-spec.md` (lines 40, 94–102); `docs/plans/specs/phase-04-topology-spec.md` (P4-R2, lines 40–44); `docs/plans/specs/phase-05-history-spec.md` (P5-R6, lines 74–78, 108–117)
- **issue:** Two compounding problems:
  1. RC-3 defines `hello.history?` and `WorkerSnapshot.historical?` and requires P3 to render the **not-live** label. Yet P2's `startBridge(roster, opts)` only accepts `roster` (explicitly `"live only"`), P5 specifies no caller for `createHistorySource` / `mergeLiveAndHistorical`, and P3 still lists history/not-live as out-of-scope (`line 40`) with no `hello.history` or `historical` handling in `ViewerState`/`applyMessage`.
  2. `FR-04` and `P4-R2` only open the `OMP subagents` tab **on `worker.spawned`**. After an OMP restart in the same cwd (`P5-R6`), no task has spawned yet—so no tab opens! And if the prior Herdr tab remained open (`Q-P4-1`), its viewer is still connected/reconnecting to the **dead previous OMP process's** socket path, not the new OMP session's socket.
- **why_it_matters:** Either post-restart history is invisible until the user runs a brand-new task (failing `P5-R6`'s own acceptance scenario), or the user ends up with a hung old viewer tab and duplicate tabs on next spawn.
- **suggested_fix:** (1) Pass `historySource?: HistorySource` into `startBridge` (and `cwd`) so `hello.history` populates on connect/reconnect; (2) update P3's `ViewerState` and `applyMessage` for `hello.history` and live-wins replacement; (3) resolve the restart UX by either auto-opening on startup when non-empty history exists in Herdr or adding an explicit `/lens` open command + defining how a restarted OMP session handles or reuses an existing `OMP subagents` tab.

### F-09: `FR-06` (`openWorkerSplit`) has no v1 user trigger and no worker-scoped viewer mode in P3
- **severity:** high
- **type:** requirements-gap / orphaned-interface
- **location:** `docs/superpowers/specs/2026-11-19-herdr-omp-lens-design.md` (FR-06, lines 109–110); `docs/plans/specs/phase-04-topology-spec.md` (P4-R7, lines 61–64, 98); `docs/plans/specs/phase-03-viewer-spec.md` (P3-R6, P3-R10, lines 65–68, 81–85)
- **issue:** `FR-06` and `P4-R7` require an action `openWorkerSplit(workerId)` that creates a no-focus split "running a worker-scoped viewer". However: (1) P3 defines no `--worker <id>` flag or `LENS_WORKER_ID` env var for a single-worker view; (2) the viewer makes no Herdr calls (`P3-R10`) and sends no messages after handshake (`P3-R6`), so a viewer keybind cannot trigger `openWorkerSplit`; (3) P1/P2/P4 define no OMP slash command or tool to invoke `openWorkerSplit`; (4) `P4-R7` doesn't specify which `targetPaneId` `splitPane` splits (splitting `ctx.paneId` shrinks the user's active OMP pane; splitting the overview tab fails when the overview tab is `closed`).
- **why_it_matters:** `FR-06` is unimplemented end-to-end and untestable as a user feature in `DoD-v1` / `P6-R6`.
- **suggested_fix:** Define a concrete trigger (e.g., an OMP slash command `/lens split <id>` registered by the extension), add `LENS_WORKER_ID` / `--worker <id>` support to P3's viewer CLI, and specify `splitPane` target semantics (split the overview tab's pane, auto-opening the overview tab first if closed).

### F-10: Topology concurrency, `pane.send_input` shell-startup/length hazard, and `pane.moved` vs `tab.closed` race threaten safety invariants
- **severity:** high
- **type:** safety-invariant-hole / race-condition
- **location:** `docs/plans/specs/phase-04-topology-spec.md` (P4-R2..R4, P4-R9, lines 40–52, 70–73); `docs/analysis/research-seams.md` (V-HDR-3, V-HDR-4, V-HDR-6, lines 108–131)
- **issue:**
  1. `onWorkerSpawned()` is `async` and deduplicates via `snapshot()`/`getPane()` (`P4-R4`). Two parallel spawns arriving in the same turn will both call `snapshot()` before `createOverviewTab` finishes and create two tabs unless serialized synchronously up front.
  2. `runInPane` sends `pane.send_input` (`V-HDR-6`), where ack is only input-queue admission and `V-HDR-6` notes macOS's canonical input limit (1024 bytes). Sending a command right after `tab.create` races shell initialization (prompt/rc hooks) or silently truncates long commands—leaving a broken shell pane that `P4-R4` counts as an existing viewer, preventing future reopens.
  3. `P4-R3` treats `tab.closed` or `pane.closed` (either order) as "viewer gone", while `P4-R9` updates IDs on `pane.moved`. If a user drags the viewer pane out of `OMP subagents` into another tab/workspace, the old empty `OMP subagents` tab closes and emits `tab.closed` for the old `tabId` (with no cross-event ordering guarantee vs `pane.moved`, `V-HDR-3`), falsely marking a live pane `closed` and causing a duplicate viewer on the next spawn.
- **why_it_matters:** Directly causes double-create (`FR-05`), stuck non-rendering viewer panes, or duplicate viewers after pane moves.
- **suggested_fix:** Serialize all `TopologyManager` state transitions behind a single-flight in-memory promise queue/mutex; keep `runInPane` commands short (wrapper script/bin, <256 bytes) and verify viewer health via `pane.get` + bridge client connection rather than assuming `pane.get` alone means the viewer is running; on `tab.closed`, confirm the stored `paneId` is also absent in `snapshot()` before transitioning to `closed`.

### F-11: Unverified capabilities claimed for `omp render`, `omp read history://`, thinking-visibility settings, and `herdr tab create --env`
- **severity:** high
- **type:** hallucinated-or-unverified-capability
- **location:** `docs/plans/specs/phase-03-viewer-spec.md` (P3-R4 lines 58–61, `renderWorkerTranscript` line 114); `docs/plans/specs/phase-05-history-spec.md` (P5-R1 lines 46–48, P5-R5 lines 67–70); `docs/plans/specs/phase-06-hardening-spec.md` (P6-R5 lines 67–68); `docs/superpowers/specs/2026-11-19-herdr-omp-lens-design.md` (§8.2, lines 173–174); `docs/analysis/research-seams.md` (V-OMP-6, V-OMP-7, V-HDR-1)
- **issue:**
  1. `P3-R4` and `P5-R5` invoke `omp render` on a subagent `sessionFile` and `omp read history://` as a host-less CLI fallback (`P5-R1`), yet neither was ever tested in Phase 0, and `V-OMP-6` warns `history://` has no documented extension API (and bare `history://` relies on session/cwd context).
  2. `P3-R4` and `P6-R5` require mirroring "OMP's display setting" for thinking visibility (`probe caveat 4`), yet `research-seams.md` cites **zero** documented API, setting file, or CLI flag to read OMP's thinking-visibility preference.
  3. `SDD §8.2` writes CLI `herdr tab create ...` while `RC-4`/`P1` require `env` on `createOverviewTab`; `V-HDR-1` documents `env` on the raw JSON socket API `tab.create`, not on the `herdr` CLI.
- **why_it_matters:** Implementing P3/P5/P1 against unverified CLI flags or non-existent config seams will cause late rework during coding.
- **suggested_fix:** Run quick empirical checks before P1 subplans on: (a) `omp render <subagent.jsonl>` and `omp read history://` outside a session; (b) where OMP 19.0.1 stores thinking visibility (or make it a viewer toggle with safe default hidden); (c) use the Herdr JSON socket protocol directly in `src/herdr/` for `tab.create`/`pane.split` with `env`.

### F-12: `events_lost` recovery ownership is ambiguous between P1 and P4, and `PaneMetadata` omits `source` (and `tokens`)
- **severity:** high
- **type:** cross-spec-contradiction / interface-mismatch
- **location:** `docs/plans/specs/phase-01-foundation-spec.md` (P1-R6 lines 50–53, `LifecycleHandlers` lines 89–101); `docs/plans/specs/phase-04-topology-spec.md` (P4-R10, lines 74–77); `docs/analysis/research-seams.md` (V-HDR-7, lines 132–133)
- **issue:** `P1-R6` says "an `events_lost` path triggers resubscribe + snapshot" inside the adapter, yet `LifecycleHandlers` exposes `onEventsLost?(): void` and `P4-R10` requires P4 to "resubscribe, await `subscription_started`, `snapshot()`, reconcile owned ids". Also, `P1` defines `PaneMetadata { title?, displayAgent?, stateLabels?, seq?, ttlMs? }` while `V-HDR-7` lists `pane.report_metadata {pane_id, source, title, display_agent, state_labels, tokens, seq, ttl_ms}`—omitting `source` (and `tokens`).
- **why_it_matters:** Leaving `events_lost` resubscribe ownership ambiguous risks either double-subscribing (leaking connections) or never re-subscribing, and omitting `source` in `pane.report_metadata` may fail Herdr socket validation or conflict with other metadata writers.
- **suggested_fix:** Have P1's `subscribeLifecycle` own the transparent resubscribe + `subscription_started` wait and invoke `onEventsLost()` only as a hook for P4 to run `snapshot()` reconciliation (or document that P1 does not auto-resubscribe and `Subscription` must be replaced by P4). Add `source: string` (and `tokens?: number`) to `PaneMetadata`.

### F-13: SDD §7 bridge protocol schema drifts from P1's ratified `Message` types and RC-3
- **severity:** medium
- **type:** spec-drift
- **location:** `docs/superpowers/specs/2026-11-19-herdr-omp-lens-design.md` (§7, lines 153–159, §14, lines 229–230); `docs/plans/specs/phase-01-foundation-spec.md` (lines 63–76)
- **issue:** SDD §7 shows `worker.upsert` with flat top-level fields (`{id, name, agent, status, ...}`) and `hello` without `history`, whereas P1 wraps `worker.upsert` as `{ v: 1; type: "worker.upsert"; worker: WorkerSnapshot }` and adds `hello.history?` and `WorkerSnapshot.historical?` per RC-3. Although SDD §14 notes §7 can now be finalized after Phase 0, §7 was never updated.
- **why_it_matters:** The SDD claims to be "the source of truth the implementation plans argue from" (`line 11`); leaving an outdated wire format in §7 invites subplan drift.
- **suggested_fix:** Update SDD §7 to match P1's `WorkerSnapshot` and `Message` shapes (including `ClientMessage` per F-07 and RC-3 `history`/`historical`).

### F-14: Cross-workspace focus theft (`U-HDR-2`) is unverified and untested in `FR-13` / `P6-R6`
- **severity:** medium
- **type:** safety-invariant-hole / testing-gap
- **location:** `docs/analysis/research-seams.md` (U-HDR-2, lines 147–148); `docs/superpowers/specs/2026-11-19-herdr-omp-lens-design.md` (FR-13, lines 125–126); `docs/plans/specs/phase-04-topology-spec.md` (P4-R5, lines 53–56); `docs/plans/specs/phase-06-hardening-spec.md` (P6-R6, lines 71–76)
- **issue:** `U-HDR-2` explicitly flags an open unknown: "Focus behavior when creating a tab in a non-focused workspace (docs cover entity focus, not workspace auto-switch)." Despite this, `P6-R6` does not require testing a spawn while the user is focused in a *different* workspace, and `P4-R5` assumes `--no-focus` prevents workspace switching.
- **why_it_matters:** If the user switches to Workspace B while OMP runs in Workspace A and spawns a subagent, `tab.create` in Workspace A could yank the user's window back to Workspace A—violating `FR-13`.
- **suggested_fix:** Add a cross-workspace focus test to P4's `U-HDR-1..5` live checklist and `P6-R6`; if Herdr switches workspaces on `tab.create`, gate auto-open or document the limitation explicitly in FR-13.

### F-15: Fail-soft and local-security gaps: blocking `before_subagent_spawn`, unspecified adapter timeouts, `/tmp` socket race, and stale socket cleanup
- **severity:** medium
- **type:** safety-invariant-hole / hardening-gap
- **location:** `docs/plans/specs/phase-02-observation-spec.md` (P2-R1, P2-R6, P2-R8, lines 44–46, 73–86); `docs/plans/specs/phase-04-topology-spec.md` (P4-R11, lines 78–80)
- **issue:**
  1. `pi.on("before_subagent_spawn")` is an in-line lifecycle hook; P2 never explicitly forbids awaiting async operations inside it, which would block OMP task spawning (`FR-12`).
  2. `P4-R11` specifies "bounded timeouts" without defining timeout values or a degraded-mode circuit breaker when Herdr's socket stalls instead of refusing immediately.
  3. `P2-R6` requires mode `0600` in `$TMPDIR`, whereas `P5-R9` requires a `0700` parent dir. If `$TMPDIR` falls back to `/tmp`, creating a socket directly in `/tmp` risks pre-creation/symlink races, and neither P2 nor P4 mandates unlinking the socket on exit.
  4. Socket path uniqueness across multiple OMP sessions in the same workspace is not specified; if non-unique, a second OMP session collides (`EADDRINUSE`) or hijacks the first session's socket.
- **why_it_matters:** A hung Herdr socket or awaited hook stalls the OMP turn (`FR-12`), and shared socket paths break multi-session isolation (`FR-10`).
- **suggested_fix:** Require synchronous, fire-and-forget enqueueing inside all `pi.on`/`pi.events.on` handlers; set explicit per-call timeouts (e.g., 2s connect / 5s RPC) and circuit-break into `degraded` state; bind per-PID/session sockets inside a `0700` directory and unlink on `BridgeHandle.close()`/`SIGINT`/`SIGTERM`.

### F-16: Clean-profile `omp plugin link` entrypoint and `viewerCommand` resolution are unspecified
- **severity:** medium
- **type:** requirements-gap / packaging-gap
- **location:** `docs/superpowers/specs/2026-11-19-herdr-omp-lens-design.md` (FR-15, lines 129–130); `docs/plans/specs/phase-01-foundation-spec.md` (P1-R1, lines 35–36); `docs/plans/specs/phase-04-topology-spec.md` (line 103); `docs/plans/specs/phase-06-hardening-spec.md` (P6-R9, lines 86–90)
- **issue:** `P1-R1` loads `./src/extension/index.ts` from repo cwd, while `FR-15` and `P6-R9` install via `omp plugin link`/`install` into a clean profile and run in arbitrary user working directories. `P4` takes an opaque `viewerCommand: string` with no specification of how the extension resolves the viewer script/binary path independent of `cwd` (or what `package.json` `bin` / `omp.extensions` points to).
- **why_it_matters:** If `viewerCommand` assumes repo cwd or `bun run src/viewer/...`, clean-profile `FR-15` will fail as soon as OMP runs in any other directory.
- **suggested_fix:** Specify `resolveViewerCommand()` in P1/P3 using `import.meta.resolve` / `import.meta.dirname` against the installed package root (and declare `"bin"` in `package.json`), and run `P1-R1` from a temp cwd outside the repo.

### F-17: Minor cross-spec drift: `"queued"` missing in P3, `Q-01` vs `Q-P4-1` typo in P4, and closed RC questions left open in P5/P6
- **severity:** medium
- **type:** cross-spec-consistency
- **location:** `docs/plans/specs/phase-03-viewer-spec.md` (line 119); `docs/plans/specs/phase-04-topology-spec.md` (line 100); `docs/plans/specs/phase-05-history-spec.md` (Q-P5-2, lines 143–145); `docs/plans/specs/phase-06-hardening-spec.md` (lines 139–140); `docs/plans/specs/00-reconciliation.md` (RC-3, RC-8, line 71)
- **issue:** (a) P3 (`line 119`) enumerates `status ∈ running|idle|parked|completed|failed|aborted`, omitting `"queued"` from P1 (`line 62`). (b) P4 (`line 100`) writes `owned pane policy = Q-01` (`Q-01` is repo name), instead of `Q-P4-1`. (c) P5 still lists `Q-P5-2` as open despite RC-3 ratifying it, and P6 (`lines 139–140`) still asks the `dod-v1-report.md` question despite RC-8 ratifying it.
- **why_it_matters:** Creates ambiguity for subplan authors checking which questions and enum values are authoritative.
- **suggested_fix:** Add `"queued"` to P3 line 119, fix `Q-01` → `Q-P4-1` in P4 line 100, and mark `Q-P5-2` and P6's report path question as resolved by RC-3 / RC-8.

### F-18: Static regex guard (`P6-R3`) and 10-minute wall-clock soak (`P6-R8`) are brittle verification mechanisms
- **severity:** low
- **type:** testability-gap
- **location:** `docs/plans/specs/phase-06-hardening-spec.md` (P6-R3 lines 52–58, P6-R8 lines 82–85)
- **issue:** `P6-R3` relies on `scanSources` regex scanning over `src/` to catch forbidden Herdr calls (`layout.apply` with `tab_id`, `agent start`, `report_agent`, `agent.view.set`) plus a manual review note. Regex scanning is trivial to bypass via indirection/composition. Meanwhile `P6-R8` mandates a `≥10 min` wall-clock soak for viewer memory bounds, making automated DoD verification slow and flaky.
- **why_it_matters:** Runtime transport guards in `src/herdr/` give real guarantees against dynamic construction, whereas a 10-minute wall-clock test slows every release check.
- **suggested_fix:** Enforce the forbidden-command/focus allowlist/denylist at `src/herdr/`'s single runtime transport boundary (tested with unit/tamper tests) alongside `scanSources`, and drive `P6-R8` by deterministic frame/byte volume (e.g., 50k frames + heap/line-count assertion) rather than a 10-minute sleep.
