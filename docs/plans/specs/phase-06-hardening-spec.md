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
- **Static-analysis guards** over `src/` asserting forbidden calls can never be emitted.
- **Isolated-session E2E** in a dedicated named Herdr session — never the daily workspace.
- **Phase 0 caveat closure:** interactive-TUI confirmation, `idle`/`parked`/`aborted` transitions,
  thinking-visibility mirroring, `detached` flag behavior in TUI.
- **Fail-soft verification:** bridge/Herdr death, malformed frames, shape drift → OMP unaffected.
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
- **P6-R2 Invariant tamper tests (SDD §10).** One tamper test per invariant, each proven to **fail on
  the broken state**: (a) worker survives viewer close, (b) no duplicate worker is spawned by any
  view operation, (c) no focus theft across open/split/reopen, (d) `control.*` frames rejected per
  FR-11, (e) extension is a no-op outside Herdr per FR-01, (f) OMP turn completes with Herdr/bridge
  dead per FR-12. *Accept:* for each test, a deliberate sabotage run (assertion or fixture flipped)
  produces a red result, quoted in the evidence report; the unmodified suite is green.
- **P6-R3 Herdr hazard static guards (V-HDR-5/6/7, U-HDR-4).** A source-scanning guard asserts
  `src/` never emits: `layout.apply` with `tab_id`, `agent start`, `pane report_agent`,
  `agent.view.set`; and that every `tab.create`/`pane.split`/`pane.run` (API or CLI) path carries
  `focus:false`/`--no-focus`, and metadata goes only through `pane.report_metadata`. *Accept:* the
  guard fails when a fixture file containing each forbidden call is added to the scan set; the real
  tree scans clean; dynamic-construction review note records that no RPC payload is built by string
  concatenation that could evade the scan.
- **P6-R4 Subscribe-before-create + reconcile (V-HDR-4, R-07).** Tests prove the lifecycle
  subscription is established before any `tab.create`, viewer liveness is always confirmable via
  `getPane`/`snapshot` (never purely event-derived), `pane.moved` updates stored ids, and an
  `events_lost` error triggers resubscribe + snapshot reconcile. *Accept:* ordered-mock tests assert
  call sequence; a simulated `events_lost` run ends with a reconciled roster and no duplicate viewer.
- **P6-R5 Phase 0 caveat closure (U-OMP-1/3/4/5, probe caveats 1–4).** Live-verified in an interactive
  TUI session inside the isolated Herdr session: `task:subagent:{event,progress,lifecycle}` frames
  flow identically to print mode; `idle`, `parked`, and `aborted` transitions are each exercised and
  land correctly in the roster (`WorkerStatus` union); the viewer mirrors OMP's thinking-visibility
  display rather than dumping raw thinking; `detached` flag semantics confirmed for TUI async spawns.
  *Accept:* evidence report records each transition observed with its raw bus frame; any transition
  that cannot be triggered on 19.0.1 is recorded as a known limitation, not silently skipped.
- **P6-R6 Isolated named-session E2E (SDD §11).** One scripted E2E in a named, disposable Herdr
  session covers: auto-open on first spawn, manual close → next-subtask reopen (exactly one tab),
  optional no-focus split, finished-collapse, history after OMP restart marked not-live (FR-09), and
  focus preservation throughout (FR-13). U-HDR-1..5 findings are recorded. *Accept:* the E2E script
  runs green against the isolated session; the daily workspace is enumerated before/after and shown
  untouched; a viewer misclassified as an agent (U-HDR-1) fails the run.
- **P6-R7 Local-only & fail-soft evidence (NFR-01, FR-03, FR-12).** Verify the unix socket exists
  with mode `0600`, no TCP listener is bound by extension or viewer, malformed/truncated NDJSON and
  wrong-`v` frames are rejected without a thrown escape, and a mid-turn Herdr kill leaves the OMP
  turn completing normally with a single `notice`. *Accept:* `stat`/`lsof` evidence in the report;
  fuzzed-frame unit tests green; the kill-Herdr E2E step shows the parent turn finishing.
- **P6-R8 Performance bounds (NFR-03).** Progress coalescing emits at most one bridge delta per
  ≤150 ms window under rapid progress frames; bridge buffers are bounded; viewer tail does not grow
  unbounded (rotate/snapshot). *Accept:* a synthetic 100-frame burst test asserts the coalesced
  count; a long-run soak (≥10 min worker churn) shows flat memory/line counts for the viewer.
- **P6-R9 Version discipline & clean-profile install (NFR-02, FR-15).** On pinned OMP 19.0.1 /
  Herdr 0.9.5: `omp plugin link` (or `install`) into a clean profile loads the extension, and first
  delegation opens the view. Feature-detection degrades — never crashes — when a bus channel or Herdr
  command is absent. *Accept:* clean-profile run documented with version strings; a simulated
  missing-channel run produces `notice` + fallback, not a throw.
- **P6-R10 Docs reconcile (NFR-06).** README, CONTRIBUTING, architecture notes, and a limitations
  section match shipped behavior exactly: v1 read-only, direct workers only, reopen semantics,
  history caveat (R-04), pinned versions. *Accept:* a doc-vs-shipped checklist is reviewed line by
  line; every documented command was executed and its output quoted.
- **P6-R11 Owner sign-off.** Evidence pack presented; open items are either closed or converted to
  recorded known limitations; owner signs off on DoD-v1 before any v2 work begins. *Accept:*
  sign-off recorded in the master plan / evidence report by the owner — never by the agent.

## Interfaces produced/consumed

**Consumed (unchanged):** `PROTOCOL_VERSION`, `WorkerStatus`, `WorkerSnapshot`, `Message`,
`encodeMessage`/`decodeMessage` (P1 protocol); `isHerdrEnv`/`callerContext`/`createOverviewTab`/
`splitPane`/`runInPane`/`subscribeLifecycle`/`getPane`/`snapshot`/`reportMetadata`, `CallerContext`
(P1 herdr); `lensExtension(pi)` gate (P1/P2); the P2 roster/publisher, P3 viewer, P4 topology
orchestrator, and P5 history surfaces under test. Observed bus field names per
`phase-0-probe-report.md` (`progress.{toolCount,requests,tokens,cost,durationMs,resolvedModelIdentity}`,
`lifecycle.{id,status,sessionFile,index,parentToolCallId}`).

**Produced (verification surface only — no production API):**

```ts
// tests/harness/
export interface IsolatedHerdrSession {  // named disposable session; never the daily workspace
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
  payload-construction review note in P6-R3 and socket-level capture in E2E.
- **Daily-workspace contamination:** E2E asserts the daily workspace untouched before *and* after.
- **Version drift between spec and gate:** pins re-verified at run time; drift → owner decision, not
  silent re-pin.

## Open questions (settle before subplan)

- Evidence report location/format: `docs/analysis/dod-v1-report.md` as a generated markdown table?
  (recommend: yes, checked in).
- Is the E2E run scripted-and-rerunnable, witnessed live, or both? (recommend: scripted, owner
  spot-witnesses the focus-preservation step).
- Soak duration for P6-R8 (≥10 min proposed — confirm bound).
- Q-02 (license) must be closed for release — confirm MIT.

## Milestone (testable software at this gate)

Every DoD-v1 item green with evidence: tamper tests pass *and* provably fail on sabotage; static
guards clean; isolated-session E2E green with daily workspace untouched; all Phase 0 caveats closed or
recorded as limitations; socket/perf/fail-soft evidence captured; clean-profile install verified on
pinned versions; docs reconciled; the evidence report is assembled for **owner sign-off**. v1 ships.
