# Phase 0 probe report — the native subagent bus

- Date: 2026-11-20 (probe run), design dated 2026-11-19.
- Target: OMP **19.0.1** (installed at probe time — the spec pin later moved to 19.1.1 per OI-1, then 19.2.1 per OI-4, owner decisions 2026-11-25; observed shapes unchanged). Herdr not involved in this probe.
- Verdict: **R-01 RESOLVED — positively.** `pi.events` carries `task:subagent:*` with full-fidelity
  payloads. The live OMP-like view is feasible directly from the bus; the artifact-polling fallback is
  likely unnecessary for live fidelity (kept only as a fail-soft degradation).
- Raw frames: `probes/out/frames.jsonl` (gitignored). Probe source: `probes/bus-probe.ts`.

## Method

A throwaway extension (`probes/bus-probe.ts`) introspects `pi.events`, subscribes to the three
`task:subagent:*` channels via `.on`, hooks `before_subagent_spawn`, and appends every frame to
`PROBE_OUT/frames.jsonl`. It was loaded into a **fresh, isolated** OMP print-mode session that spawned
exactly one cheap scout task (`LensProbe`, "reply ok").

Isolation matters. The first attempt ran in the project cwd and entangled with the live session
(auto-resume); no task spawned and only `__shutdown__` frames were captured. The successful run used a
temp cwd, `--no-session`, and stripped `HERDR_*` env:

```sh
TMPD=$(mktemp -d /tmp/lens-probe.XXXXXX); cd "$TMPD"
env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
    -u HERDR_SOCKET_PATH -u HERDR_BIN_PATH \
    PROBE_OUT=/Users/fabzter/src/omp-fabz-improvements/probes/out \
    omp --no-extensions --no-session \
    --extension /Users/fabzter/src/omp-fabz-improvements/probes/bus-probe.ts \
    -p 'Call the task tool now with exactly one scout subagent: name LensProbe, task "Reply with the single word ok", solutionSpace "trivial probe". Wait for it to finish and report its result.'
```

Child result: `LensProbe (scout) completed in 7.6s. Result: ok`. 49 bus frames captured.

## What `pi.events` is

`meta.json` shows an EventEmitter-like bus: methods `on`, `emit`, `clear`, `hasListeners`,
`watchListeners`. Subscribing to all three channels via `.on` succeeded with no error:

```
task:subagent:event:on
task:subagent:progress:on
task:subagent:lifecycle:on
```

## Observed payload shapes (trimmed)

### `before_subagent_spawn` (pi.on hook)
```json
{"type":"before_subagent_spawn","agent":"scout","invocationKind":"task",
 "modelRole":"smol","patterns":["devin/swe-2:max"],"spawnKey":"LensProbe"}
```

### `task:subagent:lifecycle` — identity + status + **sessionFile**
```json
{"id":"LensProbe","agent":"scout","parentToolCallId":"call_44d3…","detached":true,
 "agentSource":"bundled","status":"started",
 "sessionFile":"/var/folders/…/omp-task-15d5200b7f8a9636/LensProbe.jsonl","index":0}
```
Observed `status`: `started` → `completed`. The `sessionFile` field gives the exact persisted JSONL
path (resolves the artifact-path unknown U-OMP-6).

### `task:subagent:progress` — the Agent Hub roster counters
```json
{"index":0,"agent":"scout","agentSource":"bundled","parentToolCallId":"call_44d3…",
 "detached":true,"assignment":"Reply with the single word ok",
 "progress":{"id":"LensProbe","status":"running","recentTools":[{"tool":"yield","isError":false,"endMs":…}],
   "recentOutput":["ok"],"toolCount":1,"requests":2,"tokens":14114,"cost":0.0085106,
   "durationMs":7576,"modelOverride":["devin/swe-2:max"],"modelRole":"smol",
   "contextWindow":262000,"resolvedModelIdentity":"devin/swe-2","resolvedThinkingLevel":"medium"}}
```
Observed `progress.status`: `running` → `completed`. Carries tokens, cost, requests, toolCount,
durationMs, model identity, context window, recent tools, recent output — the documented roster set.

### `task:subagent:event` — the full session-event union (live transcript)
`{id, event}` where `event.type` observed includes:
`agent_start`, `turn_start`, `message_start`, `message_update`, `message_end`, `turn_end`,
`agent_end`, `tool_execution_start`, `tool_execution_end`, `advisor_cost_changed`.

`message_update.assistantMessageEvent` carries `thinking_start/delta/end`, `text_start/delta/end`,
`toolcall_start/delta/end` — i.e. **streaming text, thinking, and tool calls**. `tool_execution_end`
carries the tool `result` (content + details). `agent_end` carries the full `messages` array.

## Fidelity mapping (bus → Agent Hub target, V-OMP-9)

| Agent Hub field | Source on the bus |
|---|---|
| status running/idle/parked/aborted | lifecycle.status + progress.status (started/running/completed observed) |
| model role + resolved model | progress.modelRole / resolvedModelIdentity / resolvedThinkingLevel |
| age / active time | progress.durationMs |
| cost / tokens / requests / tool calls | progress.cost / tokens / requests / toolCount |
| current tool + args | event tool_execution_start.args; progress.recentTools |
| recent output | progress.recentOutput |
| live transcript | event message_* / tool_execution_* stream |
| lineage | lifecycle.parentToolCallId + index |
| persisted history | lifecycle.sessionFile (JSONL) |

## Caveats (honest)

1. **Print mode, not the interactive TUI.** The extension runtime and shared event bus are
   mode-agnostic, so this is strong evidence the TUI behaves identically — but **P2 must confirm in a
   real TUI session** (load extension, spawn a task, observe frames) as an acceptance step.
2. **Only started/running/completed exercised.** `idle`, `parked`, `aborted` transitions (idle-TTL
   parking, abort/kill) were not triggered by a single quick task. P2 verifies them.
3. **`detached:true`** appeared in print mode; TUI async spawns may differ. The frames still flow.
4. **Thinking content is on the bus.** There is no documented OMP API to read thinking-visibility, so the
   viewer uses its own toggle (default hidden, D4); prefer `omp render` for faithful rendering.
5. Payload field names are now **observed**, not guessed; the bridge protocol (SDD §7) can be finalized
   against them. They remain undocumented upstream, so keep feature-detection + fail-soft (NFR-02).

## Conclusion

The load-bearing risk is cleared: a parent-session extension can observe its direct native task
workers live, with the full roster + transcript fidelity the owner asked for, using `pi.events.on` on
the three documented channels. Proceed to P1/P2 with the bus as the primary observation source;
artifact JSONL + `omp render` remain the history/fallback path.

---

## Follow-up probe (2026-11-24) — persisted paths & host-less CLI

Run to ground review findings F-04 and F-11 (isolated temp cwd, **persisted session**, `HERDR_*` stripped):

- **Persisted subagent JSONL path (F-04, resolves the `$TMPDIR` ambiguity):** with a real session,
  `lifecycle.sessionFile` = `~/.omp/agent/sessions/<encoded-cwd>/<ts>_<session-id>/<worker-id>.jsonl`.
  Phase 0's `/var/folders/…` path was solely an artifact of `--no-session`. The extension can discover
  workers in degraded mode by scanning its own session's artifact dir (direct-only filter from JSONL headers).
- **`omp render <sessionFile>` (F-11):** exit **0** host-less — renders the transcript. **Use this** for
  host-less rendering.
- **`omp read <sessionFile>`:** exit 0 (reads the JSONL).
- **`omp read history://<id>` (F-11):** exit **1** host-less — `Unknown agent: <id>. Known agents: none`.
  `history://` needs the owning **live session** registry; it is **not** a host-less fallback. Use it only
  in-session.

Still open (P2 acceptance probes): interactive-TUI frames, nested depth-2 correlation, and
`idle`/`parked`/`aborted` transitions.