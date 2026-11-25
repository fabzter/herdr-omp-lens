# Phase 0 caveat closure — P6-R5 evidence report

- Date: 2026-11-25 · Author: P6 task 5 (SDD v1-hardening)
- Installed OMP: **v19.1.1** (self-reported; binary at `~/.local/bin/omp` dated 2026-11-23). The spec
  pins 19.0.1 — the upgrade predates this task; observed shapes are unchanged from the 19.0.1 probe.
  Drift is recorded here and flagged in the task report for the owner, per spec §Risks.
- Sources: Phase 0 probe (`phase-0-probe-report.md`, caveats 1–5), controller live test (session
  `01a210e2-5995-74b7-99d0-1acf4182b855`), two fresh isolated probes run by this task
  (`/tmp/lens-probe-q-out`, `/tmp/lens-probe-a-out` — same `probes/bus-probe.ts`, same isolation
  recipe: temp cwd, `--no-session`, `HERDR_*` env stripped).

## Verdicts at a glance

| Item | Verdict |
|---|---|
| Caveat 1 — TUI frames ≡ print mode | **CLOSED** (manual evidence, witnessed session id) |
| Caveat 2 — `queued` | **LIMITATION** — attempted, not emitted (parallel batch spawns start ~30 ms apart) |
| Caveat 2 — `aborted` | **CLOSED** — triggered live, raw frames below |
| Caveat 2 — `idle` / `parked` | **LIMITATION** — not reproducible in print-mode probes |
| Caveat 3 — `detached` | Partly closed: semantics identical in print probes; TUI async-spawn variance → limitation |
| Caveat 4 — thinking display | **CLOSED** — viewer toggle, default hidden (D4), code-verified |
| Caveat 5 — undocumented surface | **CLOSED-as-designed** — Zod boundary + optional fields + fail-soft |
| U-OMP-1 | **CLOSED** — same bus in TUI |
| U-OMP-3 | **CLOSED** — lifecycle statuses + counters observed; residual statuses noted |
| U-OMP-4 | **CLOSED** — full session-event union on `task:subagent:event` |
| U-OMP-5 | **CLOSED as limitation** — no registry snapshot; pre-activation workers excluded (P2-R9) |
| Host-less facts | **RE-VERIFIED live today** |

---

## Caveat 1 — interactive-TUI frames flow identically to print mode

**CLOSED — manual evidence (witnessed).** The controller's live test ran the extension inside a real
interactive TUI session in the isolated Herdr pane `wN:p4`, session
`01a210e2-5995-74b7-99d0-1acf4182b855` (persisted at
`~/.omp/agent/sessions/-src-omp-fabz-improvements/2026-11-25T04-06-39-253Z_01a210e2-5995-74b7-99d0-1acf4182b855/`).
Observed: the overview tab auto-opened on the history/spawn signal, the viewer reached `[connected]`,
and it rendered the finished worker — i.e. `task:subagent:{lifecycle,progress,event}` flowed through
the TUI-loaded extension's `pi.events` exactly as the print-mode probe recorded. This closes U-OMP-1:
the TUI bus is the same bus.

## Caveat 2 — `queued` / `idle` / `parked` / `aborted` transitions

### `aborted` — CLOSED (triggered, frames captured)

Probe: temp cwd, `--no-session`, one scout task told to sleep 120 s; parent received `SIGINT` after
the first `task:subagent:lifecycle` frame. Raw capture (`/tmp/lens-probe-a-out/frames.jsonl`):

```json
{"channel":"task:subagent:lifecycle","t":1795594075443,"payload":{"id":"ProbeAbort","agent":"scout","parentToolCallId":"agy_b658882d86a44f24b24560303127e5b9","detached":true,"agentSource":"bundled","status":"started","sessionFile":"/var/folders/…/omp-task-15dbbd2339699178/ProbeAbort.jsonl","index":0}}
{"channel":"task:subagent:event","t":1795594078945,"payload":{"id":"ProbeAbort","event":{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"aborted","errorMessage":"Previous OMP process exited before completing the turn."}}}}
{"channel":"task:subagent:progress","t":1795594078959,"payload":{"progress":{"id":"ProbeAbort","status":"aborted","…"}}}
{"channel":"task:subagent:lifecycle","t":1795594078959,"payload":{"id":"ProbeAbort","agent":"scout","parentToolCallId":"agy_b658882d86a44f24b24560303127e5b9","detached":true,"agentSource":"bundled","description":"Run 120-second sleep then confirm completion","status":"aborted","sessionFile":"/var/folders/…/omp-task-15dbbd2339699178/ProbeAbort.jsonl","index":0}}
```

`status:"aborted"` lands on **both** `lifecycle` and `progress` — the roster maps it terminal via the
observed-vocabulary `STATUS_MAP` (roster.ts). The terminal event frames also carry
`stopReason:"aborted"`. One new optional field appeared: `description` on the terminal lifecycle
frame — additive, already tolerated by the Zod schema (`.optional()` / passthrough-tolerant parse).

**Side observation (P6-relevant):** `session_shutdown` fired **twice** on SIGINT (t=…930 and …954)
and **three times** at normal exit in the batch probe — the hook is not once-only, so the
fire-and-forget teardown bound to it must be idempotent (it is: `stopLens` early-returns on
`rt.stopped`/`runtime === null`).

### `queued` — LIMITATION (attempted, not emitted)

Probe: one `task` call with a batch of two scout subagents (`ProbeQ1`, `ProbeQ2`). Both emitted
`before_subagent_spawn` then `lifecycle{status:"started"}` **30 ms apart** and progressed
`running → completed`. No `queued` frame exists anywhere in the 80-frame capture
(`/tmp/lens-probe-q-out/frames.jsonl`). On this build, a same-call batch runs concurrently — there is
no admission queue, so `queued` appears unreachable via ordinary `task` usage. `STATUS_MAP` keeps
`queued → "queued"` verbatim for the day OMP emits it; unrecognized statuses degrade to a `notice`
+ keep the last known status (NFR-02).

### `idle` / `parked` — LIMITATION (not reproducible)

No idle-TTL parking or park/resume surface is reachable from print-mode `task` usage on this build:
agents run to completion; completed agents are reaped silently (no `parked` lifecycle frame on
completion in either probe). TUI interactive agents kept warm between prompts might idle/park — that
surface has no deterministic trigger inside this task's scope and is recorded as a known limitation,
not skipped: if a future frame arrives, the roster maps `idle`/`parked` verbatim and unknown strings
keep the last known status with a single `notice`.

## Caveat 3 — `detached` flag semantics

- **Observed (re-confirmed today):** `detached:true` appears on every `lifecycle` and `progress`
  envelope for ordinary synchronous `task` spawns in both fresh probes — identical to Phase 0 print
  mode. The flag is present-and-constant in print mode.
- **LIMITATION:** whether TUI *async* spawns emit `detached:false` or omit it is unconfirmed — the
  async-spawn path has no deterministic headless trigger here. Mitigation already shipped: the field
  is `optional()` in `subagentLifecycleSchema`/`subagentProgressSchema`, and nothing in the roster or
  status mapping consumes it — presence/absence/flip cannot change behavior.

## Caveat 4 — thinking display is a viewer toggle, default hidden (D4)

**CLOSED — code-verified.**

- `src/viewer/state.ts`: `thinkingVisible: false` in `initialViewerState` — "Default false —
  viewer-local toggle (D4); never fetched from OMP" (line ~73, field comment line ~46).
- `src/viewer/cli.ts`: `case "toggleThinking"` flips it; footer shows `t thinking on|off`
  (`render.ts:143-144`).
- Rationale stands (F-11): OMP exposes no documented readable API for thinking visibility; thinking
  content flows raw on the bus (`thinking_start`/`thinking_delta`/`thinking_end` events,
  `content[].type:"thinking"` — re-observed in today's batch probe) and `omp render` remains the
  faithful-render path.

## Caveat 5 — undocumented upstream surface

**CLOSED-as-designed.** Field names remain undocumented upstream; today's probes confirm the shapes
still match Phase 0 on v19.1.1. Every boundary frame is Zod-parsed (`observe/schemas.ts`), additive
fields are tolerated (the new `description` field parsed fine), malformed frames drop to a `notice`,
and a missing bus degrades to the history-scan fallback (D1). Feature-detection + fail-soft (NFR-02)
is the standing mitigation; no further action.

## U-OMP unknowns under this task (1/3/4/5)

- **U-OMP-1** — `pi.events` in a TUI is the same bus: **CLOSED** by caveat 1's witnessed session.
- **U-OMP-3** — lifecycle distinguishes `started`/`running`/`completed`/`aborted` (observed);
  `queued`/`idle`/`parked`/`killed` not emitted by reachable triggers (limitations above). Counters
  live in `progress.progress.*` (`tokens`, `cost`, `requests`, `toolCount`, `durationMs`,
  `contextWindow`, model identity) — re-observed in both fresh probes. **CLOSED.**
- **U-OMP-4** — `task:subagent:event` carries the full session-event union: `agent_start`, `turn_start`,
  `message_start/update/end` (incl. `thinking_*`/`text_*`/`toolcall_*` deltas), `tool_execution_start/end`,
  `turn_end`, `agent_end`, `advisor_cost_changed`, `toolResult`. **CLOSED.**
- **U-OMP-5** — no registry snapshot for extensions: workers already running before activation miss
  `before_subagent_spawn` and are excluded. Resolved as a **documented limitation** (P2-R9;
  `src/extension/observe/index.ts:15-17`).

## Host-less facts — re-verified live (2026-11-25)

1. **Persisted JSONL layout** — confirmed on disk for the witnessed TUI session:
   `~/.omp/agent/sessions/-src-omp-fabz-improvements/2026-11-25T04-06-39-253Z_01a210e2-5995-74b7-99d0-1acf4182b855/worker.jsonl`
   (128,140 bytes) — i.e. `~/.omp/agent/sessions/<encoded-cwd>/<ts>_<session-id>/<worker-id>.jsonl`.
   Phase 0's `$TMPDIR` path was a `--no-session` artifact (confirmed again today: fresh probes'
   `sessionFile` values are under `/var/folders/…/T/omp-task-*` because they run `--no-session`).
2. **`omp render <sessionFile>` host-less → exit 0** — re-run today against the witnessed session's
   `worker.jsonl`: `render exit: 0`.
3. **`omp read history://<id>` needs the owning live session (RC-15)** — re-run today host-less:
   `omp read history://01a210e2-5995-74b7-99d0-1acf4182b855` → `Unknown agent: 01a210e2-…`, `Known
   agents: none`, **exit 1**. Used only in-session (RC-15); P3/P5 use `omp render`.

## Recorded limitations (explicit, per P6-R5)

1. `queued` — not emitted by a parallel two-agent batch on v19.1.1; no reachable trigger found.
2. `idle` / `parked` — no deterministic trigger in print-mode `task` usage; may require TUI idle-TTL
   or async/detached spawn flows outside this task's scope.
3. `detached` semantics for **TUI async spawns** — field is `optional()` and unconsumed, so unverified
   variance is harmless but unverified.
4. Version drift: evidence collected on **v19.1.1**, not the spec-pinned 19.0.1 — owner decision point,
   per spec §Risks.
