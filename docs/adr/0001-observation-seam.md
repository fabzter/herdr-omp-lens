# ADR-0001 — Observation seam: in-process extension + local bridge + ordinary-pane viewer

- Status: **Accepted (design)** — 2026-11-19, owner-approved architecture; empirical confirmation pending Phase 0 (R-01).
- Deciders: Fabrizio (owner), coordinator agent.
- References: `../analysis/research-seams.md` (V-OMP-*, V-HDR-*, U-OMP-*, R-01),
  `../superpowers/specs/2026-11-19-herdr-omp-lens-design.md`.

## Context

We want a Herdr pane to show the **native task subagents of an already-running interactive OMP TUI
session**, read-only in v1, local-only (no hosted relay), without duplicating workers or stealing
focus. OMP owns execution and results; Herdr is a second screen.

The candidate seams:

1. **Attach RPC to the running TUI.** RPC has the richest subagent API (V-OMP-5) but only serves a
   host it owns; there is no documented attach to a live TUI (U-OMP-9, issue #8404 open). ✗
2. **Collab guest.** Works and shows subagents, but rides a hosted relay by default and is a
   shared-session join, heavier than local read-only observation. Owner ruled out network relay. ✗
3. **Launch a second OMP host per worker.** Would create duplicate workers, not the same native
   sessions. Violates the core invariant. ✗
4. **In-process extension + local bridge + ordinary-pane viewer.** An extension loaded in the parent
   TUI subscribes to native subagent channels (V-OMP-1..4), keeps a roster, and publishes over a local
   unix-socket NDJSON bridge. A small viewer CLI runs as an ordinary Herdr pane (V-HDR-6) and renders
   an OMP-like view; transcripts come from documented artifact JSONL + `omp render`/`history://`
   (V-OMP-6..9). The extension drives Herdr topology (V-HDR-1..5). ✓

## Decision

Adopt **option 4**. Components: extension (observer + roster + bridge publisher + topology manager),
viewer CLI (read-only renderer), versioned bridge protocol (observation-only v1, reserved `control`
namespace for v2), Herdr adapter, docs/tests.

## Consequences

- **Positive:** local-only; OMP remains sole owner; no duplicate workers; no focus theft; reuses the
  production transcript pipeline for fidelity; additive Herdr topology; clean path to v2 control via
  the reserved namespace.
- **Negative / risk:** relies on the **undocumented** `pi.events` ↔ `task:subagent:*` contract
  (R-01). Mitigation: pin to OMP 19.2.1 (19.0.1 → 19.1.1 OI-1 → 19.2.1 OI-4, owner decisions 2026-11-25; observed bus shapes unchanged), feature-detect payload fields, fail soft, and **gate v1 on the
  Phase 0 probe**. Documented fallback: artifact-tree JSONL polling + `omp render` (less live).
- **v2 implication:** true interactive control (steer/follow-up/revive/cancel from Herdr) likely needs
  an upstream OMP control API or an extension control surface; v1 reserves protocol space but does not
  implement control. Tracked as R-05 / Phase P7.
- **Herdr hazards honored:** never `layout.apply` with `tab_id` (V-HDR-5); never `agent start` /
  `report_agent` for the viewer (V-HDR-6); use `report_metadata` for presentation (V-HDR-7); subscribe
  before create and reconcile via authoritative reads (V-HDR-4).

## Alternatives reconsidered later

If upstream ships `omp attach` (issue #8404) or the ACP `_omp/agents/*` surface (PR #9878) releases,
re-evaluate whether the bridge can be replaced by a first-party observation endpoint. Until then,
option 4 is the only local-only seam that preserves ownership.

---

## Empirical confirmation (2026-11-20)

Phase 0 (`../analysis/phase-0-probe-report.md`) confirmed the chosen seam's load-bearing assumption on
OMP 19.0.1 (the version installed at probe time — the pin later moved to 19.1.1 per OI-1, then 19.2.1 per OI-4): `pi.events.on` receives `task:subagent:*` with full roster + transcript payloads. Decision
stands; R-01 cleared (print-mode observed; TUI confirmation tracked in P2).