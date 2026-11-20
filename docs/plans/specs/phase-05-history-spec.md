# Phase P5 — History & restart (spec)

- Version: v1 "The Window"
- Status: **Draft for owner review.**
- Depends on: P1 (protocol + adapter), P2 (live roster + bridge publisher + `sessionFile` capture),
  P3 (viewer rendering incl. finished-collapse), P4 (view lifecycle: open/reopen hosts history).
- Produces interfaces for: P6 (hardening). Adds the `historical` marker P3 renders.
- Source of truth: `../../superpowers/specs/2026-11-19-herdr-omp-lens-design.md` §9 (Transcript
  fidelity & history), FR-09, FR-10, FR-12, NFR-02/03; `../../analysis/research-seams.md`
  V-OMP-6/7/8, U-OMP-6/7; `../../analysis/phase-0-probe-report.md` (`sessionFile`).

> This is a phase **spec** (requirements + interfaces + acceptance), not a subplan.

## Goal

Make worker history durable and honest: persisted subagent transcripts stay accessible while OMP
runs, and after an **OMP restart** the view shows saved history marked **not live** (SDD §9, FR-09) —
reconstructed from the documented artifact tree, never implying live execution, never acquiring the
session lease, and never blocking an OMP turn.

## Scope

In scope:

- `src/extension/history/` — artifact-tree scan of the current session's project session directory
  (V-OMP-8 layout), mapping discovered subagent transcripts to `WorkerSnapshot` entries flagged
  `historical`, plus merge/dedupe against the live roster.
- Historical transcript access: emit `transcript.ref` (`{id, sessionFile, artifactDir}`) so the
  viewer can render via `omp render` / JSONL tail / `omp read history://<id>` — host-less, no lease
  (V-OMP-6/7).
- Live↔historical reconciliation: live bus state wins on `id` collision; `sessionFile` recorded by
  P2 at observe time is the primary transcript pointer for lens-observed workers.
- Restart flow: new OMP session in the same cwd → scan runs, history appears in the (re)opened view.
- Bounded scanning (NFR-03), torn-read tolerance (U-OMP-7), fail-soft with a single `notice`.
- Tamper/guard tests for the read-only + no-lease + no-duplicate invariants.

Out of scope:

- Live observation/roster mechanics (P2), rendering and collapse UI (P3), tab lifecycle (P4).
- Cross-project history, cross-session live workers (FR-10), `control.*` (v2), Herdr-restart layout
  restore (P10), nested-worker trees (P9).
- Exact live-counter reconstruction for historical entries — not possible (R-04); label instead.

## Requirements & acceptance criteria

- **P5-R1 Artifact-tree scan.** Enumerate direct task-worker transcripts in the current OMP
  session's project artifact tree (`~/.omp/agent/sessions/<encoded-cwd>/…`, V-OMP-8; `omp read
  history://` listing as feature-detected fallback), producing `WorkerSnapshot`s with
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
- **P5-R5 Transcript access without lease.** For any historical worker the extension emits
  `transcript.ref` and the transcript renders from disk via `omp render`/`omp read history://<id>`/
  JSONL tail while the owning OMP process is dead; reading acquires no lease and runs no
  `omp session` attach/transfer (V-OMP-7).
  *Accept:* after killing the OMP process that spawned a worker, `transcript.ref` resolves and the
  transcript renders; a tamper test asserts no lease/transfer/attach argv is ever constructed
  (fails if introduced).
- **P5-R6 Restart shows history.** A new OMP session in the same cwd, inside Herdr, surfaces prior
  sessions' workers marked not live — on view open and on the reopen-after-close path (P4).
  *Accept:* isolated named-Herdr-session integration test: spawn + complete worker, exit OMP,
  relaunch same cwd → the worker appears marked not live with a resolvable `transcript.ref`; no
  second (live) copy.
- **P5-R7 Torn-read tolerance (U-OMP-7).** Scanning a JSONL a live TUI is still flushing skips an
  undecodable trailing line deterministically, retries bounded, and never throws into the OMP turn;
  failures degrade to one `notice` (FR-12).
  *Accept:* fixture ending in a truncated line → scan completes, entry still surfaced, no exception
  propagates; a permanently unreadable file → warn `notice`, rest of scan intact.
- **P5-R8 Bounded scan.** Scan is async off the OMP turn path, capped by config (defaults:
  `maxSessions=20`, `maxWorkers=100`, `maxFileBytes` per transcript probe), with mtime-keyed caching
  so unchanged files are not reparsed (NFR-03).
  *Accept:* a synthetic tree of 200 JSONLs completes within the configured caps (only the newest
  `maxSessions` scanned) and a second scan with unchanged mtimes does no reparse.
- **P5-R9 Local-only and gated.** Any lens-persisted cache lives under a `0700` dir / `0600` files;
  no network access; the scanner is inert when the activation gate is off (outside Herdr → no-op,
  FR-01, NFR-01).
  *Accept:* `stat` mode assertions on created paths; no socket/bind attempts; with `HERDR_ENV`
  unset, no filesystem scan occurs.

## Interfaces produced (consumed by P3/P4/P6)

```ts
// src/extension/history — history source + merge (module boundary only; P1 names reused verbatim)
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

// Live is authoritative; historical entries carry historical:true.
export function mergeLiveAndHistorical(live: WorkerSnapshot[], hist: WorkerSnapshot[]): WorkerSnapshot[];
export function transcriptRefFor(w: WorkerSnapshot): Extract<Message, { type: "transcript.ref" }> | null;

// src/protocol — additive, v1-additive (PROTOCOL_VERSION stays 1; additive optional fields only)
export interface WorkerSnapshot { /* P1 fields… */ historical?: boolean }   // not-live marker
// hello gains: { v:1; type:"hello"; session; workers; history?: WorkerSnapshot[] }
// deltas for late-scan results reuse worker.upsert with historical:true.
```

Consumed (P1/P2/P3, exact names): `WorkerSnapshot`, `WorkerStatus`, `Message` (`hello`,
`worker.upsert`, `transcript.ref`, `notice`), `encodeMessage`/`decodeMessage`, `PROTOCOL_VERSION=1`;
P2's roster snapshots + captured `sessionFile` (probe field `lifecycle.sessionFile`) and the bridge
publisher; P1 `CallerContext` (`binPath` for `omp`, `socketPath` locality); P3's `src/transcript/`
live-tail + render helpers (produced per the P3 spec for this scan's use). Rendering of the
`historical` marker and not-live label is P3's consuming contract.

## Risks

- **R-04 historical fidelity.** Live counters aren't reconstructable post-restart — mitigated by
  omitting them and labeling entries historical (P5-R4), not by estimation.
- **U-OMP-6 path drift.** Artifact-tree layout is documented, not contractual; partially resolved by
  `lifecycle.sessionFile` (P0) for lens-observed workers. Feature-detect layout; scan failure →
  degrade to `omp read history://` listing, then one `notice` (NFR-02).
- **U-OMP-7 torn concurrent reads** — bounded by P5-R7.
- **Scan cost on large trees** — bounded by P5-R8 caps + mtime cache.
- **Read-only creep.** Scan/transcript helpers must never write to OMP session dirs or invoke
  lease/control verbs — enforced by P5-R5/P5-R9 tamper tests (SDD §10 invariants).

## Open questions (settle before subplan)

- **Q-P5-1** History scope: current cwd's artifact tree only (recommended — matches V-OMP-8 and the
  FR-10 current-session spirit) or all projects?
- **Q-P5-2** Transport shape: `history?: WorkerSnapshot[]` on `hello` + `worker.upsert` deltas
  (recommended, additive) vs a dedicated `history` message — must match what P2's publisher and P3's
  viewer spec assume. Reconcile across specs.
- **Q-P5-3** Should the lens persist its own index (for sessions it observed) or rely purely on the
  artifact scan (recommended unless the scan proves lossy in P5-R1 fixtures)?
- **Q-P5-4** Default caps (`maxSessions=20`, `maxWorkers=100`) acceptable, and should they be
  user-configurable in v1?

## Milestone (testable software at this gate)

In an isolated named Herdr session: spawn + complete a worker, exit OMP, relaunch in the same cwd —
the view shows that worker marked **not live** with a renderable transcript and no duplicate row.
`bun test` green: scan mapping, dedupe (live-wins), torn-line tolerance, caps/cache, lease/read-only
tamper tests; `typecheck`/`lint` green. DoD-v1 FR-09 evidence is demonstrable here.
