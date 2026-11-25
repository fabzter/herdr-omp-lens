# P6 Hardening & Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn "everything works" into "everything is demonstrated": invariant tamper tests that provably fail on sabotage, an isolated named-Herdr-session E2E, closure of Phase 0 caveats, NFR evidence, clean-profile install, docs reconciled, and a DoD-v1 evidence report for owner sign-off.

**Architecture:** P6 adds no features. It is a verification surface (`tests/guards/`, `tests/e2e/`, `scripts/`) plus the one bug fix required to make a gate green (`stopLens` bound to `session_shutdown`). Most safety machinery already exists (runtime transport denylist `src/herdr/guards.ts`, topology subscribe-before-create + `onEventsLost` reconcile, bridge `control.*` rejection, viewer historical rendering); P6 proves each with a tamper test and assembles the evidence.

**Tech Stack:** TypeScript, Bun (`bun:test`, `Bun.spawn`), Biome, tsc; Herdr CLI (`herdr`) for the isolated-session E2E; OMP 19.2.1 / Herdr 0.9.5 pinned (19.0.1 → 19.1.1 OI-1 → 19.2.1 OI-4, owner decisions 2026-11-25; observed bus shapes unchanged from the 19.0.1 Phase-0 probe).

**Spec:** `docs/plans/specs/phase-06-hardening-spec.md` (P6-R1..R11). Requirement IDs: SDD `docs/superpowers/specs/2026-11-19-herdr-omp-lens-design.md` §5 (FR-01..15), §6 (NFR-01..06). Verified facts: `docs/analysis/phase-0-probe-report.md`.

## Global Constraints

- No new feature or behavior change beyond a bug fix required to make a green gate go green (spec Scope).
- Tamper tests MUST provably fail on the broken state; quote the red sabotage output in the evidence report (P6-R2, SDD §10).
- E2E runs in a named, disposable Herdr session — NEVER the daily workspace; enumerate the daily workspace before/after and show it untouched (P6-R6, F-14).
- Deterministic verification, not wall-clock: ≥50k-frame volume run with flat-heap/bounded-line assertions replaces any ≥10-min soak (P6-R8, D5/F-18).
- Evidence report at `docs/analysis/dod-v1-report.md`, generated markdown table, checked in; a row per FR-01..15 + NFR-01..06 with `pass | fail | manual-evidence`; every manual row names its capture (P6-R1, RC-8).
- Owner sign-off is recorded by the OWNER, never the agent (P6-R11).
- License MIT (Q-02 closed); pinned OMP 19.2.1 / Herdr 0.9.5 (OI-1 + OI-4 resolved 2026-11-25: owner approved both re-pins; the version-drift→owner-decision rule was honored, no silent re-pin).
- Verify commands: `bun test`, `bun run typecheck`, `bun run lint`.

## Review Focus

1. **Guard evasion** — a forbidden Herdr call built dynamically (string concat) could escape a regex source scan; the runtime transport denylist must still reject it, and the tamper test must fail when the denylist is removed (P6-R3).
2. **Focus theft across workspaces** — `tab.create` on 0.9.5 may yank focus from a different workspace; the E2E must exercise a spawn while focused elsewhere and scope FR-13 as a limitation if observed, never silently pass (P6-R6, F-14/U-HDR-2).
3. **Daily-workspace contamination** — an E2E that creates/closes panes in the user's real workspace is destructive; the before/after enumeration must prove it untouched (P6-R6).
4. **Untriggerable transitions faked** — `parked`/`aborted` may not reproduce on the pinned OMP build; they must be recorded as known limitations, never fabricated (P6-R5).
5. **Viewer misclassified as agent** — if Herdr reports the viewer pane as an agent (U-HDR-1), lifecycle takeover hazards return; the E2E must fail the run on that misclassification (P6-R6).

---

### Task 1: Invariant tamper-test suite (sabotage-proven)

**Files:**
- Create: `tests/guards/invariants.test.ts`
- Create: `tests/guards/sabotage.md` (records each deliberate sabotage + red output)
- Modify (only if a guard reveals a real gap): the relevant `src/` file.

**Interfaces:**
- Consumes: roster, bridge (`decodeClientMessage`), topology, extension gate, observe handlers.
- Produces: one tamper test per invariant, each with a documented sabotage that turns it red:
  (a) worker survives viewer close (FR-14); (b) no duplicate worker spawned by any view operation (FR-14); (c) no focus theft across open/split/reopen (FR-13); (d) `control.*` frames rejected (FR-11); (e) extension no-op outside Herdr (FR-01); (f) OMP turn completes with Herdr/bridge dead (FR-12); (g) all `pi.on`/`pi.events.on` handlers enqueue synchronously, never await I/O (F-15).

- [ ] **Step 1: Write the tamper tests** — each asserts the invariant on the clean tree. For (g), use a fake `pi` whose handlers are invoked and assert no returned promise is awaited / no async I/O occurs inside the handler body (spy on fs/socket).

- [ ] **Step 2: Sabotage each, quote red** — for each test, flip the assertion or fixture (e.g. make `close()` cancel the worker; allow a `control.*` frame; remove the gate; await I/O in a handler) and run; record the red output in `sabotage.md`. Restore.

- [ ] **Step 3: Run the clean suite green** — `bun test tests/guards/invariants.test.ts`; expected PASS.

- [ ] **Step 4: Commit** — `git add tests/guards && git commit -m "test(guards): invariant tamper suite, sabotage-proven (P6-R2)"`

---

### Task 2: Herdr hazard guards — source scan + runtime denylist

**Files:**
- Create: `tests/guards/herdr-source-scan.test.ts`
- Create: `scripts/scan-herdr-calls.ts` (source scanner used by the test)
- Modify: `tests/herdr/guards.test.ts` (extend runtime-denylist tamper coverage)

**Interfaces:**
- Consumes: `DENIED_METHODS`, `assertAllowedRequest` (`src/herdr/guards.ts`); the `src/` tree.
- Produces: (a) a source-scanning guard asserting `src/` never emits `layout.apply` with `tab_id`, `agent start`, `pane report_agent`, `agent.view.set`; every `tab.create`/`pane.split`/`pane.run` path carries `focus:false`/`--no-focus`; metadata only via `pane.report_metadata` with required `source`. (b) runtime transport guard tamper test: removing/bypassing `DENIED_METHODS` fails even for a runtime-composed command.

- [ ] **Step 1: Write the source-scan test** — scan `src/**/*.ts`; assert no forbidden call pattern; add a fixture file containing each forbidden call to the scan set and assert the guard FAILS; the real tree scans clean.

- [ ] **Step 2: Write the runtime-denylist tamper test** — compose a forbidden request dynamically (e.g. `["agent","start"].join(".")`) and assert `assertAllowedRequest` throws; remove a `DENIED_METHODS` entry and assert the test fails.

- [ ] **Step 3: Run green + sabotage red** — quote both; record a review note that no RPC payload is built by string concatenation evading either layer.

- [ ] **Step 4: Commit** — `git commit -am "test(guards): Herdr source-scan + runtime denylist tamper (P6-R3)"`

---

### Task 3: Subscribe-before-create + events_lost reconcile tests

**Files:**
- Create: `tests/guards/lifecycle-reconcile.test.ts`

**Interfaces:**
- Consumes: topology manager, adapter (`subscribeLifecycle`, `snapshot`, `getPane`), `onEventsLost`.
- Produces: ordered-mock tests asserting subscription established before any `tab.create`; viewer liveness confirmable via `getPane`/`snapshot` (never purely event-derived); `pane.moved` updates stored ids; a simulated `events_lost` ends with exactly ONE live subscription, a reconciled roster, no duplicate viewer (P1 transparent resubscribe + P4 `reconcileOwned`).

- [ ] **Step 1: Write the failing tests** — ordered mock adapter records call sequence; assert `subscribeLifecycle` precedes `tab.create`; simulate `events_lost` → assert one resubscribe + `snapshot()` reconcile, no double subscription.

- [ ] **Step 2: Run to verify fail/pass** — these prove existing P4 behavior; if a gap appears, fix minimally and note it.

- [ ] **Step 3: Commit** — `git commit -am "test(guards): subscribe-before-create + events_lost reconcile (P6-R4)"`

---

### Task 4: Fail-soft + performance-bounds evidence

**Files:**
- Create: `tests/guards/fail-soft.test.ts`
- Create: `tests/guards/perf-bounds.test.ts`

**Interfaces:**
- Consumes: bridge (socket mode, unlink, coalescing, bounded buffers), codec (`decodeMessage`/`decodeClientMessage`), adapter timeouts/circuit-break, roster, viewer tail.
- Produces:
  - Fail-soft (P6-R7): socket `0600` in `0700` per-session dir, unlinked on close/SIGINT/SIGTERM; no TCP listener; malformed/truncated/wrong-`v`/`control.*` frames rejected without throw; second session binds a distinct socket (no `EADDRINUSE`); stalled (not refused) Herdr socket trips 2s connect / 5s RPC timeouts → `degraded`; mid-turn Herdr kill leaves the OMP turn completing with one `notice`.
  - Perf (P6-R8): 100-frame burst asserts exact coalesced delta count (≤1 per 150ms window); ≥50k frames through encode/decode/roster/viewer asserts flat heap + bounded line counts (deterministic, numbers quoted).

- [ ] **Step 1: Write the failing tests** — `stat` mode assertions; fuzzed-frame + injected-`control.*` unit tests; stalled-socket fixture (a socket that accepts but never responds); second-session fixture; 100-frame burst coalescing count; 50k-frame volume with `process.memoryUsage()` heap delta + bounded viewer line count assertions.

- [ ] **Step 2: Run to verify fail then pass** — quote outputs; record numbers for the evidence report.

- [ ] **Step 3: Commit** — `git commit -am "test(guards): fail-soft + deterministic perf bounds (P6-R7/R8)"`

---

### Task 5: stopLens ↔ session_shutdown fix + Phase 0 caveat closure

**Files:**
- Modify: `src/extension/index.ts` (bind `stopLens` to `pi.on("session_shutdown", ...)` — fire-and-forget)
- Modify: `src/extension/api.ts` (document the shutdown hook if needed)
- Create: `tests/guards/shutdown.test.ts`
- Create: `docs/analysis/phase-0-caveat-closure.md`

**Interfaces:**
- Consumes: `stopLens`, `lensExtension`, `pi.on`.
- Produces: `session_shutdown` triggers `stopLens()` (topology + observation + bridge torn down, socket unlinked); a test asserts the hook is registered and calls stop. Phase 0 caveat closure doc records: interactive-TUI frames flow identically (witnessed in the live test, session `01a210e2-5995`); `queued`/`idle`/`parked`/`aborted` transitions exercised or recorded as limitations; thinking display is a viewer toggle default hidden (D4); `detached` semantics; host-less render facts quoted.

- [ ] **Step 1: Write the failing shutdown test** — fake `pi` records `on("session_shutdown")`; assert registered; invoke it; assert `stopLens` ran (bridge closed, socket unlinked).

- [ ] **Step 2: Run to verify it fails** — expected FAIL (hook not bound).

- [ ] **Step 3: Implement the binding** — in `lensExtension`, `pi.on("session_shutdown", () => { void stopLens(); })` (fire-and-forget, never await).

- [ ] **Step 4: Run green** — `bun test tests/guards/shutdown.test.ts`; full suite green.

- [ ] **Step 5: Caveat closure** — for each Phase 0 caveat, record observed evidence or a known limitation. Exercise `queued`/`idle`/`parked`/`aborted` in the isolated session where triggerable; record raw bus frames; any untriggerable transition is a recorded limitation, never faked (P6-R5).

- [ ] **Step 6: Commit** — `git commit -am "fix(extension): bind stopLens to session_shutdown; close Phase 0 caveats (P6-R5)"`

---

### Task 6: Isolated named-session E2E script

**Files:**
- Create: `tests/e2e/isolated-session.e2e.ts`
- Create: `scripts/run-e2e.sh`

**Interfaces:**
- Consumes: Herdr CLI (`herdr workspace create`, `herdr pane split`, `herdr agent start --kind omp`, `herdr agent prompt --wait`, `herdr tab list`, `herdr pane read`, `herdr tab close`), the installed extension, P5 history.
- Produces: one scripted, rerunnable E2E in a named disposable Herdr session covering: auto-open on first spawn; manual close → next-subtask reopen (exactly one tab); read-only `/lens split <id>` (LENS_WORKER_ID, D3); finished-collapse; OMP restart → overview auto-opens on non-empty history (D2), surviving tab reused/reconnected to the new socket (never duplicated), prior workers render not-live (FR-09); focus preservation including a spawn while focused in a DIFFERENT workspace (U-HDR-2/F-14). Daily workspace enumerated before/after, shown untouched. Viewer misclassified as agent (U-HDR-1) fails the run.

- [ ] **Step 1: Write the E2E script** — create disposable workspace `lens-e2e-<ts>`; enumerate daily workspace panes/tabs (snapshot); launch omp; delegate a cheap scout task; assert overview tab auto-opens no-focus; close it; delegate again; assert exactly one tab reopens; `/lens split <id>`; finished-collapse; restart omp same cwd; assert history auto-open + not-live + no duplicate; spawn while focused in another workspace; assert focus preserved (or scope FR-13 limitation); enumerate daily workspace after; assert unchanged; tear down the disposable workspace.

- [ ] **Step 2: Run the E2E** — `bash scripts/run-e2e.sh`; quote green output; record U-HDR-1..5 findings. If `tab.create` steals cross-workspace focus on 0.9.5, scope FR-13 as a limitation in the report — never silently pass.

- [ ] **Step 3: Commit** — `git add tests/e2e scripts/run-e2e.sh && git commit -m "test(e2e): isolated named-session lifecycle E2E (P6-R6)"`

---

### Task 7: Clean-profile install + version discipline

**Files:**
- Create: `docs/analysis/clean-profile-install.md`
- Modify: `scripts/` if a install-check helper is useful.

**Interfaces:**
- Consumes: `resolveViewerCommand()` (resolves against installed package root, never session cwd), `omp plugin link`/`install`.
- Produces: clean-profile run documented with version strings (OMP 19.2.1 / Herdr 0.9.5 — the re-pinned spec versions; the original run recorded `omp/19.1.1` installed, OI-4 re-pin 2026-11-25) and a NON-repo cwd; first delegation opens the view from that arbitrary cwd; a simulated missing-channel run produces `notice` + fallback, not a throw (P6-R9).

- [ ] **Step 1: Clean-profile install** — install into a clean profile; from a non-repo cwd, launch omp in the isolated Herdr session, delegate, assert the view opens; record version strings + cwd.

- [ ] **Step 2: Missing-channel degradation** — simulate an absent bus channel / Herdr command; assert `notice` + fallback, no crash.

- [ ] **Step 3: Commit** — `git commit -am "docs(evidence): clean-profile install + version discipline (P6-R9)"`

---

### Task 8: Docs reconcile + DoD-v1 evidence report + owner sign-off prep

**Files:**
- Modify: `README.md`, `CONTRIBUTING.md`, architecture notes, limitations section.
- Create: `scripts/gen-dod-report.ts`
- Create: `docs/analysis/dod-v1-report.md` (generated, checked in)

**Interfaces:**
- Consumes: all test names + outputs, E2E evidence, manual captures, version strings.
- Produces: a machine-generated report mapping EVERY FR-01..15 + NFR-01..06 to `pass | fail | manual-evidence` with the test name + output or a named capture; no blank/untraced row. Docs match shipped behavior line by line (v1 read-only, direct workers only, reopen semantics, degraded D1, history caveat R-04, pinned versions); every documented command executed and output quoted.

- [ ] **Step 1: Write the report generator** — `scripts/gen-dod-report.ts` reads test results + evidence files and emits the markdown table to `docs/analysis/dod-v1-report.md`.

- [ ] **Step 2: Reconcile docs** — update README/CONTRIBUTING/architecture/limitations to shipped behavior; execute each documented command, quote output.

- [ ] **Step 3: Generate + verify the report** — `bun scripts/gen-dod-report.ts`; assert a row per requirement, none blank; every manual row names its capture.

- [ ] **Step 4: Commit** — `git commit -am "docs: reconcile to shipped behavior + DoD-v1 evidence report (P6-R1/R10)"`

- [ ] **Step 5: Owner sign-off prep (P6-R11)** — present the evidence pack; open items closed or converted to recorded limitations. STOP and ask the owner to sign off — the agent never records sign-off itself.

---

## Self-Review

- **Spec coverage:** P6-R1 (Task 8), R2 (Task 1), R3 (Task 2), R4 (Task 3), R5 (Task 5), R6 (Task 6), R7 (Task 4), R8 (Task 4), R9 (Task 7), R10 (Task 8), R11 (Task 8 step 5). All covered.
- **Type consistency:** consumes locked P1/P2/P3/P4/P5 names verbatim; no new production API (verification surface only).
- **Review Focus:** guard evasion (Task 2), cross-workspace focus (Task 6), daily-workspace contamination (Task 6), faked transitions (Task 5), viewer-as-agent (Task 6) — each has a test/E2E step.
- **Proportion:** verification tasks specify assertions + evidence, not production bodies; the only production change is the `session_shutdown` binding (Task 5).