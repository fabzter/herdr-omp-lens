# herdr-omp-lens — Master Plan (long horizon)

- Date: 2026-11-19
- Status: **For owner review.** Architecture approved; Phase 0 approved to run after this plan is reviewed.
- Source of truth: `../superpowers/specs/2026-11-19-herdr-omp-lens-design.md` (SDD).
- Evidence: `../analysis/research-seams.md`. Seam decision: `../adr/0001-observation-seam.md`.

This master plan defines the **v1 / v2 horizon**, the **phases**, the **Definition of Done** at each
level, the dependency graph, risk prioritization, and global constraints. Per the long-horizon process,
**phase specs are written one at a time and reviewed before any subplan**; all specs settle before
subplans. The owner closes review gates — the agent never closes them unilaterally.

---

## 1. Vision

A reusable, humane OMP extension that lets Herdr act as a second screen for OMP's native subagents:
**v1 = a faithful read-only window; v2 = a safe interactive console**, without ever duplicating workers,
stealing focus, or leaving the machine.

## 2. Version horizon

### v1 — "The Window" (ratified scope)

Read-only observation of the current session's direct native task workers: one no-focus overview tab +
optional splits, auto-open/reopen-on-next-subtask, OMP-like detail, finished-collapse, persisted history.
Full requirements: SDD §5 (FR-01..15), §6 (NFR-01..06). **Exit = DoD-v1 (§5).**

### v2 — "The Console" (horizon; specs written later, owner-gated)

Builds on v1's reserved `control` namespace. Candidate features (each its own phase spec + DoD):

- **Interactive control** — steer a running worker, follow-up an idle one, revive a parked one, and
  explicitly cancel — routed back to the **owning** OMP session, with point-of-risk confirmation for
  cancel. Likely requires an upstream OMP control API or extension control surface (**R-05, P7**).
- **Nested-worker tree** — show parent/child lineage beyond direct workers (relaxes ratified #6).
- **Herdr-restart viewer restore** — restore the viewer layout after a Herdr server restart (the v1
  stretch), distinct from OMP session resume.
- **Workspace-wide board (optional)** — workers from every OMP session in the workspace, grouped by
  parent (relaxes ratified #6 differently). Owner decision required.

v2 is a **horizon, not a commitment**: P7 research settles feasibility before any v2 feature is spec'd.

## 3. Phase overview

| Phase | Name | Version | Deliverable (testable milestone) | De-risks |
|-------|------|---------|----------------------------------|----------|
| **P0** | Bus probe | v1 gate | Evidence report: does `pi.events` carry `task:subagent:*` with usable payloads on 19.0.1? Go/no-go + fallback decision. | **R-01** |
| **P1** | Foundation | v1 | Repo/package scaffold, bridge protocol types, Herdr adapter wrapper, test harness, local dev (no cloud). | — |
| **P2** | Extension observation | v1 | Extension subscribes native events, roster reducer, bridge publisher, fail-soft, Herdr gate. | R-01, R-02 |
| **P3** | Viewer rendering | v1 | Viewer CLI: roster + OMP-like transcript via JSONL/`omp render`, finished-collapse, read-only nav. | R-04 |
| **P4** | Topology lifecycle | v1 | Auto-open/reopen, no-focus tab/split, close-detect + authoritative reconcile, optional split. | R-03, R-06, R-07 |
| **P5** | History & restart | v1 | Persisted-artifact scan, history view marked not-live, restart behavior. | R-04 |
| **P6** | Hardening & release | v1 | Safety tamper tests, isolated-session E2E, docs reconcile, clean-profile install verification. **DoD-v1 sign-off.** | all v1 |
| **P7** | Control-surface research | v2 gate | ADR: feasible OMP control seam (upstream API vs extension surface); owner decision. | **R-05** |
| **P8** | Interactive control | v2 | Steer/follow-up/revive/cancel with confirmation; control routed to owning session. | R-05 |
| **P9** | Nested-worker tree | v2 | Lineage tree beyond direct workers. | — |
| **P10** | Herdr-restart restore | v2 | Viewer layout restore after Herdr server restart. | — |
| **P11** | Workspace board (optional) | v2 | Multi-session board, owner-gated. | — |

## 4. Dependency graph

```
P0 ──► P1 ──► P2 ──► P4 ──► P5 ──► P6 (DoD-v1)
              │       ▲
              └─► P3 ─┘            (P3 consumes P2's protocol; P4 integrates P2+P3)

P6 ──► P7 ──► P8 ──► (P9, P10, P11 parallel, owner-gated)   (v2 horizon)
```

- **P0 gates everything** (R-01). If the bus is insufficient, P2/P3 adopt the documented fallback
  (artifact polling + `omp render`) and the SDD fidelity claim is revised before proceeding.
- P2 and P3 can progress in parallel once P1 fixes the protocol contract; P4 integrates them.
- v2 phases depend on a shipped v1 and the P7 feasibility ADR.

## 5. Definition of Done

### Global DoD (every phase / every task)

- Failing test written first; implementation makes it pass; verification output quoted (not asserted).
- One commit per task via the eval `commit` namespace; no placeholders; docs updated with the change.
- No new network exposure; safety invariants preserved; lighter models for routine delegation, stronger
  for review.

### DoD-v1 (release gate, P6)

1. **FR-01..15** each demonstrated with evidence (SDD §5 acceptance criteria).
2. **Tamper tests pass and fail on broken state:** worker survives viewer close; no duplicate worker;
   no focus theft; `control` frames rejected in v1.
3. **Isolated named-Herdr-session E2E green:** open/reopen/split/close, finished-collapse, history after
   restart, focus preservation — daily workspace untouched.
4. **Typecheck + lint + unit tests green.**
5. **Clean-profile install verified:** `omp plugin link` loads the extension; delegation opens the view.
6. **R-01 resolved:** Phase 0 evidence recorded, or fallback documented and owner-approved.
7. **Docs reconcile** with shipped behavior (README, architecture, limitations, CONTRIBUTING).
8. **Owner sign-off.**

### DoD-v2 (per feature, owner-gated)

- P7 ADR settles the control seam; owner approves proceeding.
- Each control action routes to the **owning** session, never duplicates workers; cancel requires
  point-of-risk confirmation; read-only fallback remains intact.
- Feature-specific acceptance tests + isolated-session E2E; docs reconcile; owner sign-off per feature.

## 6. Risk prioritization

| ID | Risk | Severity | Mitigation / phase |
|----|------|----------|--------------------|
| **R-01** | Undocumented `pi.events` ↔ `task:subagent:*` contract | **Critical** | **P0 probe gates v1**; feature-detect + fail-soft; documented fallback |
| R-02 | No public attach to a live TUI | High | In-process extension (ADR-0001); P2 |
| R-03 | Herdr auto-detects viewer as an agent | Medium | P4 live test; `report_metadata` not `report_agent` |
| R-04 | Restart history ≠ exact live counters | Medium | P5; label historical |
| **R-05** | v2 control needs upstream OMP API | High (v2) | **P7 research gate** before any v2 feature |
| R-06 | `layout.apply` with `tab_id` destroys tab | High | Never use it; P4 |
| R-07 | Herdr events non-durable / races | Medium | Subscribe-first + authoritative reconcile; P4 |
| R-08 | Per-call Terra/Luna not in operator grants | Low | Use configured lighter scout routing; offer role mapping (Q-04) |

## 7. Global constraints (verbatim from ratified design)

- OMP is the **sole owner** of worker execution and results; never launch duplicate workers.
- Closing a view **never** cancels a worker.
- **No focus theft**; all topology ops no-focus.
- **No network relay**; local unix-socket bridge only (0600).
- Extension **fails soft** and never blocks an OMP turn; outside Herdr it does nothing.
- v1 is **read-only**; only **direct** native task workers of the **current** session.
- Auto-open when in Herdr; **next subtask reopens** after a manual close.
- Finished workers **collapse by default**; history accessible incl. after restart (marked not-live).
- Pin OMP **19.1.1** / Herdr **0.9.5** (re-pinned from 19.0.1 per owner OI-1 decision 2026-11-25; observed bus shapes unchanged from the 19.0.1 Phase-0 probe); feature-detect undocumented APIs; **do not read OMP
  implementation source** to fill gaps — probe empirically.
- Reusable repo, humane personality, good docs; **no upstream submission** unless separately requested.
- Routine delegation on lighter models; stronger models for review.

## 8. Repo structure (target)

```
herdr-omp-lens/
  README.md                  # humane intro, install, quickstart, links
  CONTRIBUTING.md            # dev setup, tests, conventions, review gates
  LICENSE                    # Q-02 (proposed MIT)
  package.json               # omp.extensions entry; bun toolchain
  src/
    extension/               # gate, subscriber, roster, publisher, topology, history
    viewer/                  # read-only renderer + nav
    protocol/                # versioned NDJSON types (+ reserved control)
    herdr/                   # CLI/socket adapter
    transcript/              # JSONL tail + omp render/history
  tests/                     # unit + tamper + isolated-session integration
  probes/                    # P0 throwaway probe (out/ gitignored)
  docs/
    superpowers/specs/       # SDD (this design)
    plans/                   # master plan + phase specs + subplans
    analysis/                # cited seam research
    adr/                     # decisions
```

## 9. Review gates (owner closes)

1. **This master plan + SDD** → owner review (current gate).
2. **P0 probe result** → go/no-go + fallback decision.
3. **Each phase spec** (one at a time) → owner review; open questions settled individually.
4. **All specs settled** → subplans written (writing-plans format).
5. **DoD-v1** → owner sign-off before any v2 work.

## 10. Decisions (recorded 2026-11-20)

| ID | Question | Disposition | Provenance |
|----|----------|-------------|------------|
| Q-01 | Repo/package name | **Keep `herdr-omp-lens`** — working name, reversible; owner may rename | Coordinator default; fits owner's "humane repo" ask |
| Q-02 | License | **MIT recommended; LICENSE file deferred to owner** — nothing published, not committed unilaterally | **Owner decision pending** (legal/policy) |
| Q-03 | v2 headline | **Interactive control** (steer/follow-up/revive/cancel); nested tree, restart-restore, workspace board are optional horizon candidates | Ratified by owner decision #1 ("extensibility for C"), 2026-11-19 |
| Q-04 | Delegation routing | **Keep configured lighter scout routing** (honors "smaller model" preference); Terra/Luna per-call role mapping offered, not applied (global config change needs explicit ask) | Owner preference 2026-11-19; coordinator ops decision |
| Q-05 | Phase 0 probe method | **Done** — isolated print-mode probe passed; R-01 resolved | Owner approved Phase 0; executed 2026-11-20 |

Phase-local technical questions (Q-P3-1 render strategy, Q-P5-1 history scope, Q-P4-1..3 stop/crash/split
policy) carry recommendations in their specs and are ratified during owner spec review before subplans.
Q-P5-2 history transport is already ratified as RC-3 in `specs/00-reconciliation.md`.

---

## 11. Phase 0 outcome (2026-11-20)

**P0 complete — R-01 resolved positively** (`../analysis/phase-0-probe-report.md`). `pi.events` carries
`task:subagent:*` with full fidelity on OMP 19.0.1. The bus is the primary observation source; fallback
is fail-soft only. P2 acceptance now includes: confirm in interactive TUI mode; exercise
idle/parked/aborted transitions. Risk R-01 downgraded to verified-with-caveat. Next: owner review of
this plan + SDD, then P1 foundation spec.

---

## 12. Adversarial review outcome (2026-11-24)

agy-hydrogen (Gemini 4 Hydrogen, High) reviewed the full v1 spec set and found **18 valid issues**
(archived: `../analysis/review-agy-hydrogen-2026-11-24.md`). Core architecture judged sound. All fixes
applied in one coordinated pass: canonical contracts in P1 + `specs/00-reconciliation.md` (RC-9..15),
SDD §7–10 synced, phase specs P2–P6 aligned.

- **Critical fixes:** F-01 bridge-vs-Herdr socket conflation; F-02 nested `progress` envelope; F-03
  direct-only correlation via `before_subagent_spawn.spawnKey` (not a nonexistent hook `parentToolCallId`).
- **Decisions adopted (owner may reshape at spec review):** D1 degraded-mode fallback relaxes live
  FR-02/04/10; D2 auto-open overview on restart when history exists; D3 read-only `/lens split <id>`;
  D4 thinking-visibility viewer toggle (default hidden); D5 runtime transport guards + deterministic
  frame-volume test (no 10-min soak).
- **New probe evidence (2026-11-24):** persisted subagent JSONL path verified
  (`~/.omp/agent/sessions/<encoded-cwd>/<session-dir>/<id>.jsonl`); `omp render <sessionFile>` works
  host-less; `omp read history://<id>` needs the owning session. Still open as P2 acceptance probes:
  interactive-TUI frames, nested depth-2, idle/parked/aborted transitions.
- **Next gate (owner):** review the corrected specs; pick license (Q-02); go → P1 code subplan.