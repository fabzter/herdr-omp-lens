# Cross-spec reconciliation (v1 phase specs)

- Date: 2026-11-20
- Status: **Coordinator ratification of interface contracts** (technical consistency across the P1–P6
  draft specs). These are not owner policy decisions; the owner still reviews the specs and settles the
  master-plan open questions Q-01..04. Subplans argue from these ratified contracts.
- Specs reconciled: `phase-01-foundation-spec.md` … `phase-06-hardening-spec.md`.

The five phase specs were drafted in parallel against the settled architecture and the observed Phase 0
payloads. Drafting surfaced a handful of interface seams where two specs assumed different shapes. Each
is resolved below with a stable ID; the canonical definitions live in **P1** (the interface source).

## RC-1 — Roster signals (P2 ↔ P4)

**Conflict:** P2 produces per-worker signals; P4's draft claimed "no dedicated P2 finish signal" and
derived finish from `roster.onChange`.
**Ratified:** P2's `Roster` emits per-worker `RosterSignal` — `worker.spawned`, `worker.finished`,
`roster.empty` — via `Roster.onSignal(cb: (s: RosterSignal) => void)`. P4 consumes `worker.spawned → onWorkerSpawned` and
`worker.finished → onWorkerFinished` directly; it does **not** re-derive finish. `roster.onChange`
remains the general snapshot stream for P3/P5. P4's consumed-interfaces paragraph updated accordingly.

## RC-2 — `LifecycleHandlers` concrete shape (P1 ↔ P4)

**Conflict:** P4 referenced a `LifecycleHandlers` type P1 had not defined.
**Ratified:** P1 now defines `LifecycleHandlers` with optional handlers `onTabClosed`, `onPaneClosed`,
`onPaneExited`, `onPaneMoved`, `onWorkspaceClosed`, `onLayoutUpdated`, `onEventsLost`, plus
`Subscription`, `PaneInfo`, `SessionSnapshot`, `PaneMetadata`, `DecodeResult`. Payload field names match
V-HDR-3. P4 consumes this shape verbatim.

## RC-3 — History transport (P1 ↔ P2 ↔ P3 ↔ P5)

**Conflict:** P5 proposed an additive history shape; P1's protocol lacked it; P2/P3 must tolerate it.
**Ratified:** `WorkerSnapshot.historical?: boolean` and `hello.history?: WorkerSnapshot[]` are added to
P1 (additive; `PROTOCOL_VERSION` stays **1**). `worker.upsert` may carry `historical:true`. P5 scans the
artifact tree and merges with the live roster (**live-wins** dedupe); P2's publisher emits/tolerates the
marker; P3 renders the **not-live** label. No version bump for v1.

## RC-4 — Viewer socket/session env handoff (P1 ↔ P3 ↔ P4)

**Conflict:** P3 needs the bridge `socketPath`; P4 launches the viewer; P1's create/split had no `env`.
**Ratified:** P1 `createOverviewTab`/`splitPane` accept `env?: Record<string,string>`. P4 launches the
viewer with `env = { LENS_SOCKET_PATH: BridgeHandle.socketPath, LENS_SESSION: <session id> }`; P3's
`connectBridge({socketPath, session})` reads them. **`LENS_SOCKET_PATH` is the BRIDGE socket, never `CallerContext.socketPath` (Herdr's socket, F-01).** Names fixed: `LENS_SOCKET_PATH`, `LENS_SESSION`.

## RC-5 — `transcript.ref` semantics (P2 ↔ P5)

**Conflict:** both P2 (live) and P5 (historical) reference `transcript.ref`.
**Ratified:** one message shape `{ v:1, type:"transcript.ref", id, sessionFile, artifactDir? }`. P2
emits it on `lifecycle.sessionFile` for live workers (P2-R6); P5's `transcriptRefFor` builds the same
shape for historical entries. Consumers treat them identically; `historical` distinguishes liveness.

## RC-6 — Isolated-session helper ownership (P1 ↔ P4 ↔ P6)

**Conflict:** P1 stubbed an isolated-named-session helper; P6-R6 assumed P4 owns it.
**Ratified:** P1 defines the helper interface/stub; **P4 implements and owns** the concrete
isolated-named-session helper (its lifecycle milestone needs it first); P6's `IsolatedHerdrSession`
verification surface wraps/reuses it. One implementation, no duplication.

## RC-7 — `reportMetadata` ownership (P1 ↔ P3 ↔ P4)

**Ratified:** P1 provides the `reportMetadata` adapter primitive; **P4 drives** all presentation
reporting. P3 does not call it. The viewer is never reported via `report_agent` (V-HDR-6).

## RC-8 — DoD-v1 evidence artifact (P6 ↔ peers)

**Ratified:** the release evidence pack is generated at `docs/analysis/dod-v1-report.md` (P6-R1). Peer
milestone claims that cite DoD-v1 evidence point there.

## Naming note

P4's phase-local questions were renamed `Q-P4-1..3` to avoid collision with the master-plan open
questions `Q-01..04` (repo name, license, v2 headline, model routing). Phase-local questions use the
`Q-P<n>-<k>` convention (P3 already used `Q-P3-1`, P5 `Q-P5-1/2`).

## Still pending (owner)

Master-plan Q-01 (name), Q-02 (license), Q-03 (v2 headline), Q-04 (Terra/Luna routing) remain owner
decisions and do not block the v1 interface contracts above. Phase-local open questions (render
strategy, history scope, stop/crash/split policy) are settled during spec review before subplans.

---

## Review fixes (2026-11-24, agy-hydrogen adversarial review)

An external adversarial review (Gemini 4 Hydrogen, archived at `../../analysis/review-agy-hydrogen-2026-11-24.md`)
found 18 valid issues. Canonical contracts updated in P1; phase specs P2–P6 aligned. Additional ratified points:

- **RC-9 (F-02) Progress envelope:** `task:subagent:progress` is an envelope `{index?,agent?,parentToolCallId?,…,progress:{…}}`.
  P2's `SubagentProgress` models the envelope; counters come from the nested `.progress`. Zod parses raw probe fixtures.
- **RC-10 (F-03) Direct-only correlation:** the direct-id set is built from `before_subagent_spawn.spawnKey`
  (== worker id; the parent extension's hook fires only for direct spawns). Filter `lifecycle` by id in that set.
  The hook payload has **no** `parentToolCallId`. TUI/nested/idle/parked/aborted frames remain a P2 acceptance probe.
- **RC-11 (F-06) Inspector fields:** `WorkerSnapshot` adds `parentToolCallId?`, `index?`, `modelRole?`,
  `thinkingLevel?`, `assignment?` (FR-07 / P3-R3 lineage + model role).
- **RC-12 (F-07) Client handshake:** `ClientMessage {v:1,role:"viewer",session}` + `decodeClientMessage` in
  `src/protocol`; `connectBridge({socketPath, session})`. The same boundary rejects `control.*` (FR-11).
- **RC-13 (F-12) Metadata + events_lost:** `PaneMetadata.source` is required; P1 owns transparent `events_lost`
  resubscribe, `onEventsLost` lets P4 reconcile ids.
- **RC-14 (F-15/F-16) Hardening + packaging:** fire-and-forget handlers (never block an OMP turn); per-session
  socket in a `0700` dir, unlinked on close/SIGINT/SIGTERM; adapter per-call timeouts + circuit-break to degraded;
  `resolveViewerCommand()` resolves against the package root (clean-profile FR-15).
- **RC-15 (F-11) Host-less rendering:** `omp render <sessionFile>` works host-less (verified); `omp read history://<id>`
  needs the owning live session (fails host-less). P3/P5 use `omp render`; `src/herdr` uses the JSON socket API for `env`.

### Decisions adopted from the review (owner may reshape at spec review)

- **D1 (F-04):** degraded fallback relaxes live FR-02/04/10 promises; discovery = scan the verified session artifact
  dir `~/.omp/agent/sessions/<encoded-cwd>/<ts>_<session-id>/<id>.jsonl`; no live counters without the bus.
- **D2 (F-08):** auto-open the overview on startup when non-empty history exists in Herdr; define reuse/reconnect of a
  surviving tab to the new session socket.
- **D3 (F-09):** worker splits via a read-only `/lens split <id>` slash command + worker-scoped viewer (`LENS_WORKER_ID`).
- **D4 (F-11):** thinking visibility is a viewer toggle, default hidden (no documented OMP API).
- **D5 (F-18):** runtime transport guards in `src/herdr` (tamper-tested) + deterministic frame-volume test, not a 10-min soak.

### Probe evidence (2026-11-24)

Persisted-session subagent JSONL path verified as `~/.omp/agent/sessions/<encoded-cwd>/<ts>_<session-id>/<id>.jsonl`
(Phase 0's `$TMPDIR` path was an artifact of `--no-session`). `omp render <sessionFile>` exit 0 host-less;
`omp read history://<id>` exit 1 host-less ("Unknown agent"). Recorded in `../../analysis/phase-0-probe-report.md`.