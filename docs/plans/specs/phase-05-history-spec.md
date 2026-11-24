# Phase P5 — History & restart (spec)

- Version: v1 "The Window"
- Status: **Draft for owner review.**
- Depends on: P1 (protocol + adapter), P2 (live roster + bridge publisher + `sessionFile` capture),
  P3 (viewer rendering incl. finished-collapse), P4 (view lifecycle: open/reopen hosts history).
- Produces interfaces for: P6 (hardening). Adds the `historical` marker P3 renders.
- Source of truth: `../../superpowers/specs/2026-11-19-herdr-omp-lens-design.md` §9 (Transcript
  fidelity & history), FR-09, FR-10, FR-12, NFR-02/03; `../../analysis/research-seams.md`
  V-OMP-6/7/8, U-OMP-6/7; `../../analysis/phase-0-probe-report.md` (`sessionFile`); adversarial
  review `../../analysis/review-agy-hydrogen-2026-11-24.md` (F-04, F-08, F-11, F-17) + ratified
  contracts in `00-reconciliation.md` (RC-3, RC-5, RC-15; D1–D5).

> This is a phase **spec** (requirements + interfaces + acceptance), not a subplan.

## Goal

Make worker history durable and honest: persisted subagent transcripts stay accessible while OMP
runs, and after an **OMP restart** the view shows saved history marked **not live** (SDD §9, FR-09) —
reconstructed from the verified persisted artifact tree, never implying live execution, never
acquiring the session lease, and never blocking an OMP turn.

## Scope

In scope:

- `src/extension/history/` — artifact-tree scan of the current session's project session directory
  (`~/.omp/agent/sessions/<encoded-cwd>/<ts>_<session-id>/<worker-id>.jsonl`, V-OMP-8 layout verified
  2026-11-24 for OMP 19.0.1), mapping discovered subagent transcripts to `WorkerSnapshot` entries
  flagged `historical`, plus merge/dedupe against the live roster.
- Historical transcript access: emit `transcript.ref` (`{v:1, type:"transcript.ref", id, sessionFile,
  artifactDir?}`, RC-5) so the viewer can render via `omp render <sessionFile>` (verified host-less)
  or direct JSONL tail — host-less, no lease (V-OMP-7). **`omp read history://<id>` is NOT a
  host-less path** (probe: fails outside the owning live session, "Known agents: none"; F-11/RC-15) —
  it is never emitted as the rendering contract for historical entries.
- Live↔historical reconciliation: live bus state wins on `id` collision; `sessionFile` recorded by
  P2 at observe time (`lifecycle.sessionFile`) is the primary transcript pointer for lens-observed
  workers.
- Restart flow: new OMP session in the same cwd → scan runs, history rides `hello.history` on every
  viewer connect/reconnect and appears in the (re)opened view (F-08/D2: P4 auto-opens the overview
  on startup when non-empty history exists and reuses a surviving `OMP subagents` tab, reconnecting
  its viewer to the **new** session's bridge socket).
- Degraded-discovery source (D1): the same scan is the specified discovery mechanism P2's degraded
  fallback consumes when the bus is unavailable — historical markers apply, live counters do not.
- Bounded scanning (NFR-03), torn-read tolerance (U-OMP-7), fail-soft with a single `notice`.
- Tamper/guard tests for the read-only + no-lease + no-duplicate invariants (deterministic
  fixture-driven, per D5 — no wall-clock soaks).

Out of scope:

- Live observation/roster mechanics (P2), rendering and collapse UI (P3), tab lifecycle incl. the
  auto-open-on-history + surviving-tab reconnect mechanics (P4, D2), worker-scoped splits and
  `LENS_WORKER_ID` viewer modes (P3/P4, D3), thinking-visibility policy (P3 viewer toggle, D4).
- Cross-project history, cross-session live workers (FR-10), `control.*` (v2), Herdr-restart layout
  restore (P10), nested-worker trees (P9).
- Exact live-counter reconstruction for historical entries — not possible (R-04); label instead.

## Requirements & acceptance criteria

- **P5-R1 Artifact-tree scan.** Enumerate direct task-worker transcripts in the current OMP
  session's persisted project artifact tree
  `~/.omp/agent/sessions/<encoded-cwd>/<ts>_<session-id>/<worker-id>.jsonl` (V-OMP-8; verified
  2026-11-24 — the `$TMPDIR` path observed in Phase 0 was a `--no-session` artifact, F-04/probe
  evidence). Layout detection is feature-gated, not assumed; a scan failure yields partial results
  plus one `notice`, never a thrown error (NFR-02). Produces `WorkerSnapshot`s with
  `historical: true`, `id`, `agent`, `sessionFile`, `updatedAt` from file mtime.
  *Accept:* a fixture tree with 2 sessions / 3 subagent JSONLs yields exactly 3 historical snapshots
  with correct id/agent/sessionFile; nested (depth ≥ 2) entries are excluded when parent linkage is
  detectable (FR-10).
- **P5-R2 Not-live marking.** Every scanned snapshot carries `historical: true`; the viewer can
  unambiguously render "not live" from the payload alone — no live-status field is fabricated.
  *Accept:* decoded `history`/hello payload shows `historical: true` on every historical entry; a
  snapshot without the flag is never emitted from the scan (guard test).
- **P5-R3 Live wins on collision.** If a worker `id` appears in both the live roster (P2) and the
  history scan, the live snapshot is authoritative; the historical duplicate is dropped.
  *Accept:* merge with live `{id:X,status:"running"}` + historical `{id:X}` → exactly one row, live
  status, `historical` absent (tamper test fails if the historical row survives or duplicates).
- **P5-R4 Honest status mapping.** Terminal JSONL markers map to `completed`/`failed`/`aborted`; a
  transcript with no terminal marker maps to `aborted` (its session ended). Live counters that
  cannot be reconstructed stay **absent** (optional fields omitted), never zero-filled or guessed
  (R-04).
  *Accept:* fixture with a completed transcript → `status:"completed"`, counters absent; fixture
  truncated mid-run → `status:"aborted"`, `historical:true`.
- **P5-R5 Transcript access without lease (F-11/RC-15).** For any historical worker the extension
  emits `transcript.ref` and the transcript renders from disk via **`omp render <sessionFile>`**
  (verified exit 0 host-less) or direct JSONL tail while the owning OMP process is dead.
  `omp read history://<id>` is **not** used for this — it requires the owning live session registry
  and fails host-less ("Unknown agent … Known agents: none"); it is valid only as an in-session
  convenience, never as the host-less contract. Reading acquires no lease and runs no
  `omp session` attach/transfer (V-OMP-7).
  *Accept:* after killing the OMP process that spawned a worker, `transcript.ref` resolves and the
  transcript renders via `omp render`; a tamper test asserts no lease/transfer/attach argv and no
  `history://` read is ever constructed for historical rendering (fails if introduced).
- **P5-R6 Restart shows history (F-08/D2).** A new OMP session in the same cwd, inside Herdr,
  surfaces prior sessions' workers marked not live: the scan result rides `hello.history` on
  **every** viewer connect/reconnect (RC-3), so a surviving `OMP subagents` tab that reconnects to
  the new session's bridge socket (`BridgeHandle.socketPath`, never `CallerContext.socketPath`,
  F-01) shows history immediately; P4 (D2) auto-opens the overview on startup when the scan is
  non-empty and rebinds a surviving tab to the new bridge socket.
  *Accept:* isolated named-Herdr-session integration test: spawn + complete worker, exit OMP,
  relaunch same cwd → history appears without any new `worker.spawned` (auto-open or surviving-tab
  reconnect path), the worker is marked not live with a resolvable `transcript.ref`, and no second
  (live) copy exists.
- **P5-R7 Torn-read tolerance (U-OMP-7).** Scanning a JSONL a live TUI is still flushing skips an
  undecodable trailing line deterministically, retries bounded, and never throws into the OMP turn;
  failures degrade to one `notice` (FR-12).
  *Accept:* fixture ending in a truncated line → scan completes, entry still surfaced, no exception
  propagates; a permanently unreadable file → warn `notice`, rest of scan intact.
- **P5-R8 Bounded scan.** Scan is async off the OMP turn path (F-15 fire-and-forget), capped by
  config (defaults: `maxSessions=20`, `maxWorkers=100`, `maxFileBytes` per transcript probe), with
  mtime-keyed caching so unchanged files are not reparsed (NFR-03).
  *Accept:* a synthetic tree of 200 JSONLs completes within the configured caps (only the newest
  `maxSessions` scanned) and a second scan with unchanged mtimes does no reparse.
- **P5-R9 Degraded-discovery contract (D1).** `HistorySource.scan` is the same mechanism P2's
  degraded fallback calls when the bus is unavailable: results surface workers with
  `historical: true`, no live counters, and live-only promises (FR-02/FR-04/FR-10) are explicitly
  relaxed in degraded mode.
  *Accept:* with a stubbed-absent bus, the scan still returns the fixture workers marked
  `historical`, counters absent; the emitted snapshots carry no fabricated live fields.
- **P5-R10 Local-only and gated.** Any lens-persisted cache lives under a `0700` dir / `0600` files;
  no network access; the scanner is inert when the activation gate is off (outside Herdr → no-op,
  FR-01, NFR-01).
  *Accept:* `stat` mode assertions on created paths; no socket/bind attempts; with `HERDR_ENV`
  unset, no filesystem scan occurs.

## Interfaces produced (consumed by P2/P3/P4/P6)

```ts
// src/extension/history — history source + merge (P1 names reused verbatim; F-08 wiring below)
export interface HistoryScanOptions {
  maxSessions?: number;   // default 20
  maxWorkers?: number;    // default 100
  maxFileBytes?: number;  // per-transcript parse cap
}
export interface HistoryScan { workers: WorkerSnapshot[]; warnings: string[]; scannedAt: number; }
export interface HistorySource {
  scan(cwd: string, opts?: HistoryScanOptions): Promise<HistoryScan>;
}
export function createHistorySource(deps: { ompBin: string; sessionsRoot?: string }): HistorySource;

// Live is authoritative; historical entries carry historical:true (P5-R3).
export function mergeLiveAndHistorical(live: WorkerSnapshot[], hist: WorkerSnapshot[]): WorkerSnapshot[];
// RC-5: one transcript.ref shape for live (P2) and historical (P5); `historical` distinguishes liveness.
export function transcriptRefFor(w: WorkerSnapshot): Extract<Message, { type: "transcript.ref" }> | null;

// src/protocol — additive, v1-additive (PROTOCOL_VERSION stays 1; optional fields only, RC-3)
export interface WorkerSnapshot {
  id: string; name?: string; agent: string; status: WorkerStatus;   // WorkerStatus incl. "queued"
  model?: string; activity?: string; sessionFile?: string;
  counters?: { tokens?: number; cost?: number; requests?: number; toolCount?: number; durationMs?: number };
  parentToolCallId?: string; index?: number; modelRole?: string; thinkingLevel?: string; assignment?: string;
  historical?: boolean;   // P5: true for persisted / not-live entries
  updatedAt: number;
}
// hello: { v:1; type:"hello"; session; workers; history?: WorkerSnapshot[] } — history rides EVERY
// hello incl. viewer reconnects (F-08); late-scan deltas reuse worker.upsert with historical:true.
```

**Wiring (F-08, ratified RC-3 + D1/D2):** the extension activation path owns one `HistorySource` and
passes its merged output to P2's `startBridge` via `opts.history` — P2's declared
`() => WorkerSnapshot[]` callback, invoked on every viewer connect/reconnect — built as
`mergeLiveAndHistorical(live, (await scan(cwd)).workers)`. The callback (not the `HistorySource` type
itself) is the seam: P2 stays history-source-agnostic and every `hello` — including a surviving
tab's reconnect after OMP restart — carries `history`; late-scan deltas reuse `worker.upsert` with
`historical:true`. The same `HistorySource.scan` backs P2's degraded-mode discovery (D1). P4 consumes
the scan's non-emptiness via its `onHistoryPresent?()` hook for D2 auto-open and binds a surviving tab's viewer to the new session's
`BridgeHandle.socketPath` via `LENS_SOCKET_PATH` + `LENS_SESSION` (never `CallerContext.socketPath`,
F-01).

Consumed (P1/P2/P3, exact names): `WorkerSnapshot` (full locked field set above), `WorkerStatus`
(incl. `"queued"`), `Message` (`hello`, `worker.upsert`, `transcript.ref`, `notice`),
`encodeMessage`/`decodeMessage`, `PROTOCOL_VERSION=1`; P2's roster snapshots + captured `sessionFile`
(probe field `lifecycle.sessionFile`), `BridgeHandle`/`BridgeHandle.socketPath` and the bridge
publisher; P1 `CallerContext` (`binPath` for `omp` invocations; `socketPath` is Herdr's socket,
F-01); P3's `src/transcript/` `omp render`-backed + live-tail render helpers (produced per the P3
spec for this scan's use). Rendering of the `historical` marker and not-live label is P3's consuming
contract.

## Risks

- **R-04 historical fidelity.** Live counters aren't reconstructable post-restart — mitigated by
  omitting them and labeling entries historical (P5-R4), not by estimation.
- **U-OMP-6 path drift.** Persisted layout now **verified** (`~/.omp/agent/sessions/<encoded-cwd>/
  <ts>_<session-id>/<id>.jsonl`, probe evidence 2026-11-24) but remains upstream-undocumented;
  `lifecycle.sessionFile` (P0) stays primary for lens-observed workers. Feature-detect layout; scan
  failure → partial results + one `notice` (NFR-02). `history://` listing is **not** a degraded
  fallback — it needs the owning live session (F-11).
- **U-OMP-7 torn concurrent reads** — bounded by P5-R7.
- **Scan cost on large trees** — bounded by P5-R8 caps + mtime cache.
- **Read-only creep.** Scan/transcript helpers must never write to OMP session dirs or invoke
  lease/control verbs — enforced by P5-R5/P5-R10 tamper tests (SDD §10 invariants).

## Open questions (settle before subplan)

- **Q-P5-1** History scope: current cwd's artifact tree only (recommended — matches V-OMP-8 and the
  FR-10 current-session spirit) or all projects?
- ~~**Q-P5-2** Transport shape~~ — **resolved by RC-3 (F-17):** `history?: WorkerSnapshot[]` on
  `hello` (every connect/reconnect) + `worker.upsert` deltas with `historical:true`; additive,
  `PROTOCOL_VERSION` stays 1.
- **Q-P5-3** Should the lens persist its own index (for sessions it observed) or rely purely on the
  artifact scan (recommended unless the scan proves lossy in P5-R1 fixtures)?
- **Q-P5-4** Default caps (`maxSessions=20`, `maxWorkers=100`) acceptable, and should they be
  user-configurable in v1?

## Milestone (testable software at this gate)

In an isolated named Herdr session: spawn + complete a worker, exit OMP, relaunch in the same cwd —
the view shows that worker marked **not live** (via D2 auto-open or surviving-tab reconnect, P5-R6)
with a transcript renderable by `omp render <sessionFile>` host-less, and no duplicate row.
`bun test` green: scan mapping, dedupe (live-wins), torn-line tolerance, caps/cache, lease/read-only
+ no-`history://` tamper tests — all fixture-driven and deterministic (D5); `typecheck`/`lint` green.
DoD-v1 FR-09 evidence is demonstrable here (reported via `docs/analysis/dod-v1-report.md`, RC-8).
