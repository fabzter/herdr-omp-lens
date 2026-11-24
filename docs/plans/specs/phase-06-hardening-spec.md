# Phase P6 — Hardening & Release (spec)

- Version: v1 "The Window"
- Status: **Draft for owner review.**
- Depends on: P1 (foundation), P2 (observation), P3 (viewer), P4 (topology), P5 (history).
- Produces interfaces for: none downstream — this is the **DoD-v1 release gate** (master plan §5).
  Produces the verification/evidence surface consumed by the owner sign-off.
- Source of truth: `../../superpowers/specs/2026-11-19-herdr-omp-lens-design.md` (FR-01..15,
  NFR-01..06, §10 safety invariants, §11 testing strategy).

> This is a phase **spec** (requirements + interfaces + acceptance), not a subplan. P6 adds no
> features: it proves the shipped behavior, closes Phase 0 caveats, and assembles the evidence pack
> for owner sign-off. Global constraints (master plan §7) are binding throughout.

## Goal

Turn "everything works" into "everything is demonstrated": safety-invariant tamper tests that provably
fail on the broken state, an isolated named-Herdr-session E2E covering the full topology lifecycle,
closure of every Phase 0 caveat and live-test unknown, a clean-profile install check, docs reconciled
to shipped behavior, and a DoD-v1 evidence report for owner sign-off (SDD §10, §11; master plan §5).

## Scope

In scope:
- **Tamper/guard tests** for every safety invariant and Herdr hazard (SDD §10, V-HDR-5/6/7).
- **Static-analysis + runtime transport guards** asserting forbidden Herdr calls can never be
  emitted — the source scan plus the denylist at `src/herdr`'s single transport boundary (F-18/D5).
- **Isolated-session E2E** in a dedicated named Herdr session — never the daily workspace.
- **Phase 0 caveat closure:** interactive-TUI confirmation, `queued`/`idle`/`parked`/`aborted`
  transitions, thinking-visibility **viewer toggle** (D4: default hidden — no documented OMP API to
  read, F-11), `detached` flag behavior in TUI.
- **Fail-soft verification:** bridge/Herdr death, malformed frames, shape drift → OMP unaffected;
  degraded-mode artifact-dir discovery (D1), adapter timeouts + circuit-break (F-15).
- **NFR evidence:** socket 0600, no network bind, ≤150 ms coalescing, bounded buffers.
- **Clean-profile install** (`omp plugin link`) on the pinned versions (OMP 19.0.1 / Herdr 0.9.5).
- **Docs reconcile** + **DoD-v1 evidence report** + owner sign-off walkthrough.

Out of scope: any new feature or behavior change beyond a bug fix required to make a green gate go
green; v2 control surface (P7+); nested tree, workspace board, Herdr-restart restore (v2 horizon);
upstream submission.

## Requirements & acceptance criteria

- **P6-R1 DoD-v1 evidence matrix.** A machine-generated report maps **every** FR-01..15 and
  NFR-01..06 to an evidence entry: automated test name + output, or an explicitly-labeled
  manual/witnessed capture. *Accept:* `docs/analysis/dod-v1-report.md` (or equivalent artifact) has
  a row per requirement with `pass | fail | manual-evidence`; no row is blank or untraced; every
  `manual-evidence` row names the capture (log/screenshot/session id).
- **P6-R2 Invariant tamper tests (SDD §10, F-15).** One tamper test per invariant, each proven to
  **fail on the broken state**: (a) worker survives viewer close, (b) no duplicate worker is
  spawned by any view operation, (c) no focus theft across open/split/reopen, (d) `control.*`
  frames rejected per FR-11, (e) extension is a no-op outside Herdr per FR-01, (f) OMP turn
  completes with Herdr/bridge dead per FR-12, (g) all `pi.on`/`pi.events.on` handlers enqueue
  synchronously and never await I/O — fire-and-forget, including inside `before_subagent_spawn`
  (F-15/FR-12). *Accept:* for each test, a deliberate sabotage run (assertion or fixture flipped)
  produces a red result, quoted in the evidence report; the unmodified suite is green.
- **P6-R3 Herdr hazard guards (V-HDR-5/6/7, U-HDR-4, F-18/D5).** Two layers. (a) A
  source-scanning guard asserts `src/` never emits: `layout.apply` with `tab_id`, `agent start`,
  `pane report_agent`, `agent.view.set`; and that every `tab.create`/`pane.split`/`pane.run` (API
  or CLI) path carries `focus:false`/`--no-focus`, and metadata goes only through
  `pane.report_metadata` — always with the required `source` field (F-12). (b) A **runtime
  transport guard** enforces the same command denylist + `focus:false` requirement at `src/herdr`'s
  single socket-transport boundary, so dynamically-constructed calls cannot evade the scan.
  *Accept:* the source guard fails when a fixture file containing each forbidden call is added to
  the scan set and the real tree scans clean; a transport-guard tamper test fails when the denylist
  is removed or bypassed even for a runtime-composed command; a review note records that no RPC
  payload is built by string concatenation that could evade either layer.
- **P6-R4 Subscribe-before-create + reconcile (V-HDR-4, R-07, F-12).** Tests prove the lifecycle
  subscription is established before any `tab.create`, viewer liveness is always confirmable via
  `getPane`/`snapshot` (never purely event-derived), `pane.moved` updates stored ids, and an
  `events_lost` error triggers P1's **transparent resubscribe** (the adapter waits
  `subscription_started` itself) plus the `onEventsLost` hook → P4 `snapshot()` reconcile of owned
  ids — never a double subscription. *Accept:* ordered-mock tests assert call sequence; a simulated
  `events_lost` run ends with exactly one live subscription, a reconciled roster, and no duplicate
  viewer.
- **P6-R5 Phase 0 caveat closure (U-OMP-1/3/4/5, probe caveats 1–4, F-11).** Live-verified in an
  interactive TUI session inside the isolated Herdr session:
  `task:subagent:{event,progress,lifecycle}` frames flow identically to print mode; `queued`,
  `idle`, `parked`, and `aborted` transitions are each exercised and land correctly in the roster
  (`WorkerStatus` union); the viewer's thinking display is a **viewer toggle, default hidden**
  (D4 — OMP's thinking-visibility setting has no documented readable API, F-11), never a
  raw-thinking dump; `detached` flag semantics confirmed for TUI async spawns. The report also
  records the already-verified host-less facts (2026-11-24 probe): persisted subagent JSONL lives
  at `~/.omp/agent/sessions/<encoded-cwd>/<ts>_<session-id>/<worker-id>.jsonl` (Phase 0's `$TMPDIR`
  path was a `--no-session` artifact); `omp render <sessionFile>` exits 0 host-less;
  `omp read history://<id>` needs the owning live session and is used only in-session (RC-15).
  *Accept:* evidence report records each transition observed with its raw bus frame and quotes the
  host-less render results; any transition that cannot be triggered on 19.0.1 is recorded as a
  known limitation, not silently skipped.
- **P6-R6 Isolated named-session E2E (SDD §11, F-14/D2/D3).** One scripted E2E in a named,
  disposable Herdr session covers: auto-open on first spawn; manual close → next-subtask reopen
  (exactly one tab); a read-only `/lens split <id>` slash command opening a no-focus worker-scoped
  viewer (`LENS_WORKER_ID` env, D3); finished-collapse; **OMP restart → the overview auto-opens on
  startup when non-empty history exists** (D2), a surviving viewer tab is reused/reconnected to the
  new session socket (never duplicated), and prior workers render marked not-live (FR-09); and
  focus preservation throughout (FR-13) **including a spawn while the user is focused in a
  different workspace** (cross-workspace focus theft, U-HDR-2/F-14). U-HDR-1..5 findings are
  recorded. *Accept:* the E2E script runs green against the isolated session; the daily workspace
  is enumerated before/after and shown untouched; a viewer misclassified as an agent (U-HDR-1)
  fails the run; if `tab.create` steals cross-workspace focus on 0.9.5 the FR-13 claim is scoped
  and recorded as a limitation — never silently passed.
- **P6-R7 Local-only & fail-soft evidence (NFR-01, FR-03, FR-12, F-15/D1).** Verify the bridge
  socket exists with mode `0600` inside a `0700` per-session directory (unique per OMP
  session/PID) and is unlinked on `BridgeHandle.close()`/SIGINT/SIGTERM; no TCP listener is bound
  by extension or viewer; malformed/truncated NDJSON, wrong-`v` frames, and injected `control.*`
  frames are rejected at the `decodeClientMessage`/`decodeMessage` boundary without a thrown escape
  (F-07/FR-11); a second OMP session in the same workspace binds a **distinct** socket (no
  `EADDRINUSE`/hijack); a **stalled** (not refused) Herdr socket trips the adapter's per-call
  timeouts (2s connect / 5s RPC) and circuit-breaks to `degraded`; bus-absent degraded mode still
  discovers workers by scanning the verified session artifact dir (D1) while live
  discovery/counter promises (FR-02/04/10) are explicitly relaxed; and a mid-turn Herdr kill leaves
  the OMP turn completing normally with a single `notice`. *Accept:* `stat`/`lsof`/unlink evidence
  in the report; fuzzed-frame + injected-`control.*` unit tests green; stalled-socket and
  second-session fixtures green; the kill-Herdr E2E step shows the parent turn finishing.
- **P6-R8 Performance bounds (NFR-03, F-18/D5).** Progress coalescing emits at most one bridge
  delta per ≤150 ms window under rapid progress frames; bridge buffers are bounded; viewer tail
  does not grow unbounded (rotate/snapshot). Verification is **deterministic, not wall-clock**.
  *Accept:* a synthetic 100-frame burst test asserts the exact coalesced delta count; a
  frame-volume run (≥50k frames through encode/decode/roster/viewer) asserts flat heap and bounded
  line counts — no ≥10-minute soak — with numbers quoted in the evidence report.
- **P6-R9 Version discipline & clean-profile install (NFR-02, FR-15, F-16).** On pinned OMP
  19.0.1 / Herdr 0.9.5: `omp plugin link` (or `install`) into a clean profile loads the extension,
  and first delegation opens the view **from an arbitrary working directory** —
  `resolveViewerCommand()` resolves against the installed package root, never the session cwd.
  Feature-detection degrades — never crashes — when a bus channel or Herdr command is absent.
  *Accept:* clean-profile run documented with version strings and a non-repo cwd; a simulated
  missing-channel run produces `notice` + fallback, not a throw.
- **P6-R10 Docs reconcile (NFR-06).** README, CONTRIBUTING, architecture notes, and a limitations
  section match shipped behavior exactly: v1 read-only (observation plus the `/lens split` viewer
  command, no worker control), direct workers only, reopen semantics, degraded-mode behavior (D1),
  history caveat (R-04), pinned versions. *Accept:* a doc-vs-shipped checklist is reviewed line by
  line; every documented command was executed and its output quoted.
- **P6-R11 Owner sign-off.** Evidence pack presented; open items are either closed or converted to
  recorded known limitations; owner signs off on DoD-v1 before any v2 work begins. *Accept:*
  sign-off recorded in the master plan / evidence report by the owner — never by the agent.

## Interfaces produced/consumed

**Consumed (unchanged, names per locked P1):** `PROTOCOL_VERSION`, `WorkerStatus`,
`WorkerSnapshot`, `Message`, `DecodeResult`, `encodeMessage`/`decodeMessage`,
`ClientMessage`/`ClientDecodeResult`/`decodeClientMessage` (P1 protocol — the same boundary that
rejects `control.*`, F-07); `isHerdrEnv`/`callerContext`/`createOverviewTab`/`splitPane`/`runInPane`/
`subscribeLifecycle`/`getPane`/`snapshot`/`reportMetadata`, `CallerContext`, `LifecycleHandlers`
(incl. `onEventsLost`), `PaneMetadata` (requires `source`), `Subscription`, `PaneInfo`,
`SessionSnapshot` (P1 herdr); `resolveViewerCommand()` and the `lensExtension(pi)` gate (P1
extension); the P2 roster/publisher (`RosterSignal` via `Roster.onSignal`,
`BridgeHandle.socketPath`), P3 viewer (launched with env `LENS_SOCKET_PATH`/`LENS_SESSION`, plus
`LENS_WORKER_ID` for worker-scoped mode — `LENS_SOCKET_PATH` is the **bridge** socket, never
`CallerContext.socketPath`, F-01), P4 topology orchestrator, and P5 history surfaces under test.
Observed bus field names per `phase-0-probe-report.md`: `task:subagent:progress` is an envelope
`{index?,agent?,parentToolCallId?,…,progress:{id,status,toolCount,requests,tokens,cost,durationMs,
resolvedModelIdentity}}` (F-02); `lifecycle.{id,status,sessionFile,index,parentToolCallId}`.

**Produced (verification surface only — no production API):**

```ts
// tests/harness/
export interface IsolatedHerdrSession {  // named disposable session; wraps/reuses P4's helper (RC-6)
  sessionName: string;
  setup(): Promise<void>; teardown(): Promise<void>;
  assertDailyWorkspaceUntouched(): Promise<void>;
}
export interface TamperRule { id: string; forbidden: RegExp | string; appliesTo: string[] }
export function scanSources(rules: TamperRule[], rootDir: string): TamperViolation[]; // P6-R3
export interface FrEvidence { req: string; status: "pass" | "fail" | "manual-evidence"; evidence: string }
export function buildEvidenceReport(results: FrEvidence[]): string; // → dod-v1-report.md, P6-R1
export async function sabotage(testId: string): Promise<boolean>;   // true iff test fails on broken state, P6-R2
```

## Risks

- **E2E flakiness / environment coupling:** mitigate via the isolated named session, deterministic
  task fixtures (cheap scout tasks), retry-once policy, and recorded manual-evidence fallback.
- **Untriggerable transitions:** `parked`/`aborted` may not be reproducible on 19.0.1 — recorded as
  known limitation, never faked (P6-R5).
- **Guard evasion:** forbidden calls built dynamically could escape regex scans — mitigated by the
  `src/herdr` runtime transport denylist + review note in P6-R3 and socket-level capture in E2E.
- **Daily-workspace contamination:** E2E asserts the daily workspace untouched before *and* after.
- **Version drift between spec and gate:** pins re-verified at run time; drift → owner decision, not
  silent re-pin.
- **Cross-workspace focus theft (F-14):** `tab.create` on 0.9.5 may yank focus across workspaces —
  covered by the P6-R6 live step; if observed, FR-13 is scoped as a limitation, not silently passed.

## Open questions (settle before subplan)

- Evidence report location/format: **resolved by RC-8** — `docs/analysis/dod-v1-report.md`,
  generated markdown table, checked in (F-17).
- Soak duration: **resolved by D5/F-18** — deterministic frame-volume run (≥50k frames + heap/line
  assertion) replaces the ≥10-min wall-clock soak.
- Is the E2E run scripted-and-rerunnable, witnessed live, or both? (recommend: scripted, owner
  spot-witnesses the focus-preservation step).
- Q-02 (license) must be closed for release — confirm MIT.

## Milestone (testable software at this gate)

Every DoD-v1 item green with evidence: tamper tests pass *and* provably fail on sabotage; static
guards clean; isolated-session E2E green with daily workspace untouched; all Phase 0 caveats closed or
recorded as limitations; socket/perf/fail-soft evidence captured; clean-profile install verified on
pinned versions; docs reconciled; the evidence report is assembled for **owner sign-off**. v1 ships.
