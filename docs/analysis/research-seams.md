# Research: OMP ↔ Herdr integration seams

Status: verified against official documentation on 2026-11-19.
Versions observed: **OMP 19.0.1** (at research time — the spec pin later moved to 19.1.1 per owner OI-1 decision 2026-11-25), **Herdr 0.9.5** (client/server protocol 22, compatible).
Method: two read-only documentation scouts (official docs + published schema), coordinator
re-verification of the load-bearing claims. No implementation source was read; no live Herdr
topology was mutated. Claims are tagged `verified` (documented) or `unknown` (must be probed).

Stable IDs here are referenced by the SDD (`../superpowers/specs/2026-11-19-herdr-omp-lens-design.md`)
and the master plan (`../plans/00-master-plan.md`).

---

## 1. The observation seam (OMP side)

### Verified

- **V-OMP-1** — The `task` tool emits `task:subagent:event`, `task:subagent:progress`, and
  `task:subagent:lifecycle` "on the parent event bus." Channel **names** are documented; payload
  **shapes** are not (they live only in implementation `src/task/types.ts`).
  Source: https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md
- **V-OMP-2** — `ExtensionAPI` exposes `on(event, handler)` for a canonical event union **plus**
  `pi.events`, a shared event bus. The documented `pi.on` union includes session/agent/turn/message/
  tool/plan/mode events and `before_subagent_spawn`, but **not** `task:subagent:*`; no doc enumerates
  `pi.events` channels.
  Source: https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md
- **V-OMP-3** — SDK `createAgentSession()` returns `eventBus` and optional `subagentEventBus`; docs
  state `subagentEventBus` "carries `task:subagent:*` observability frames across the session tree."
  This is documented as a UI-host embedding surface, **not** explicitly as reachable via
  `ExtensionAPI.pi.events`.
  Source: https://github.com/can1357/oh-my-pi/blob/main/docs/sdk.md
- **V-OMP-4** — PR #9952 ("nested subagent frames never reach RPC/observer surfaces") confirms the
  `task:subagent:*` channels are the subscription contract consumed by `set_subagent_subscription`,
  `get_subagents`, `get_subagent_messages`, and the interactive observer; depth ≥ 2 frames flow on the
  same bus.
  Source: https://github.com/can1357/oh-my-pi/pull/9952
- **V-OMP-5** — RPC mode documents a complete subagent surface (`set_subagent_subscription`
  off|progress|events; `get_subagents`; `get_subagent_messages` with `fromByte` incremental reads;
  `steer_subagent`; `cancel_subagent`) — but only for a host process RPC **owns**. There is **no
  documented way to attach this surface to an already-running TUI host**.
  Source: https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md
- **V-OMP-6** — `agent://<id>` resolves a subagent's saved **final output/status**, not the live
  transcript; `write agent://<id>` steers/revives. `history://<id>` gives a concise transcript for a
  live/parked worker or a retained on-disk transcript; bare `history://` lists registered agents and
  retained transcripts. These URIs are consumed by the model-facing read/write tools; no documented
  extension-side resolver API.
  Source: https://github.com/can1357/oh-my-pi/blob/main/docs/agent-hub.md
- **V-OMP-7** — CLI subcommands give host-less access to the same surface: `omp read` (returns what the
  read tool returns for a path/URL/internal URI), `omp render` (draws a session thread through the
  production transcript pipeline), `omp session` (transfer/lease checks), `omp --export <session>`
  (HTML). Reading/inspecting a session does **not** acquire the lease.
  Source: https://github.com/can1357/oh-my-pi/blob/main/docs/cli-reference.md
- **V-OMP-8** — Session files are JSONL at `~/.omp/agent/sessions/<encoded-cwd>/<ts>_<id>.jsonl` with a
  documented entry taxonomy. Subagent transcripts live as JSONL inside the parent session's artifact
  tree; Agent Hub scans that tree to discover parked workers.
  Source: https://github.com/can1357/oh-my-pi/blob/main/docs/session.md
- **V-OMP-9** — Agent Hub documents the fidelity target: roster (status running/idle/parked/aborted,
  model role + resolved model, age, cost, active time, request/tool-call counts, tokens, unread IRC);
  inspector (current tool + args, last intent, retry state, context-window use, lineage, output/patch
  paths, worktree branch); activity log; live tailing transcript; parked-worker discovery. The roster
  "updates from the session's agent registry and progress events."
  Source: https://github.com/can1357/oh-my-pi/blob/main/docs/agent-hub.md
- **V-OMP-10** — `ctx.agent = {kind: main|sub, id, name, depth, parentId?}` gives an extension its own
  session identity; `ctx.sessionManager.getBranch()` is own-session only — a parent extension cannot
  read a child's branch through the documented context API.
  Source: https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md

### Unknown (probe or upstream needed)

- **U-OMP-1** — Whether `pi.events` in a running TUI is exactly the bus carrying `task:subagent:*`
  (strong inference from V-OMP-3/4, no explicit published contract). **→ R-01, Phase 0.**
- **U-OMP-2** — Field-level payload shapes for the three channels. **→ R-01, Phase 0.**
- **U-OMP-3** — Whether `task:subagent:lifecycle` distinguishes running/idle/parked/aborted/killed and
  carries cost/token/tool-call counters. **→ Phase 0.**
- **U-OMP-4** — Whether `task:subagent:event` emits the full session-event union (message deltas, tool
  events) per subagent or a subset. **→ Phase 0.**
- **U-OMP-5** — Whether a TUI-loaded extension can enumerate already-running subagents at load time
  (no replay; no documented registry snapshot for extensions). **→ Phase 0 / P2.**
- **U-OMP-6** — Exact artifact-tree path convention mapping a subagent id → `<id>.jsonl` / `<id>.md`.
  **→ P2/P5.**
- **U-OMP-7** — Concurrent-read semantics of `omp read history://<id>` while the owning TUI flushes.
  **→ P5.**
- **U-OMP-8** — ACP `_omp/agents/*` surface (PR #9878) appears unreleased in 19.0.1 (`docs/acp-agents.md`
  404s). Not a v1 dependency.
- **U-OMP-9** — Any documented way to attach a second process to a live TUI for observation
  (`omp attach`, issue #8404, is an open feature request). None today. **→ informs ADR-0001.**

---

## 2. The hosting seam (Herdr side)

### Verified

- **V-HDR-1** — Additive, no-focus creation: `tab.create {workspace_id, cwd, label, env, focus:false}`
  and `pane.split {target_pane_id, direction, ratio, cwd, env, focus:false}`; `focus` defaults false.
  CLI: `herdr tab create --workspace ID --no-focus`, `herdr pane split --no-focus`. Caller env
  `HERDR_WORKSPACE_ID/TAB_ID/PANE_ID/SOCKET_PATH/BIN_PATH` is authoritative.
  Sources: https://herdr.dev/tui/docs/agent-automation/ ,
  https://raw.githubusercontent.com/herdrdev/herdr/ca1af383/src/api/schema/tabs.rs ,
  https://raw.githubusercontent.com/herdrdev/herdr/ca1af383/src/api/schema/panes.rs
- **V-HDR-2** — `events.subscribe {subscriptions:[{type:'tab.closed'},{type:'pane.closed'},…]}`: first
  line acks (`subscription_started`), later lines are pushed events on the held-open connection.
  `tab.closed`, `pane.closed`, `pane.exited`, `pane.moved`, `workspace.closed`, `layout.updated` are
  session-wide Lifecycle subscriptions taking no params (min protocol 17). All entries must be valid
  or the whole request errors and the connection closes. No replay of pre-subscription events.
  Sources: https://herdr.dev/tui/docs/socket-api/ ,
  https://raw.githubusercontent.com/herdrdev/herdr/ca1af383/src/api/schema/events.rs
- **V-HDR-3** — Close payloads: `tab.closed → {workspace_id, tab_id}`; `pane.closed → {workspace_id,
  pane_id}`; `pane.exited → {workspace_id, pane_id}` (process exit, distinct from close);
  `pane.moved → {previous_pane_id, previous_workspace_id, previous_tab_id, pane}` (cross-workspace move
  changes the public pane id). Ordering is guaranteed only within a subscription entry, so either
  `pane.closed`/`tab.closed` order means "viewer gone."
  Source: https://docs.rs/herdr-protocol/latest/src/herdr_protocol/events.rs.html
- **V-HDR-4** — Events are **not durable**: lag → `error.code:'events_lost'` then the server closes the
  subscription. Recovery: resubscribe, await `subscription_started`, `session.snapshot` on a separate
  connection, reconcile via authoritative reads. Viewer liveness must always be verifiable via
  `pane.get`/`session.snapshot`, never purely event-derived. Subscribe-first → create → reconcile
  covers the close-before-subscribe race; dedupe double-create via authoritative read. `events.wait`
  is a one-shot alternative.
  Source: https://herdr.dev/tui/docs/socket-api/
- **V-HDR-5** — **Hazard:** `layout.apply` **with** `tab_id` creates a replacement tab then **closes the
  old tab**, killing live PTYs/scrollback and changing pane ids; the emitted `tab.closed` is
  indistinguishable from a user close. Safe additive use = **omit** `tab_id` (fresh tab, `focus:false`).
  No `herdr layout` CLI group (raw API only).
  Source: https://herdr.dev/tui/docs/socket-api/
- **V-HDR-6** — Ordinary `pane run` = `pane.send_input` (shell command + Enter); ack means input-queue
  admission, not execution (macOS canonical-input-limit check). The viewer stays an ordinary pane
  occupant, invisible to `agent.*` unless screen/process detection matches a manifest. `agent start`
  requires an idle shell pane and never creates layout. A viewer must **never** be launched via
  `agent start` nor reported via `pane report_agent` (semantic lifecycle state).
  Source: https://herdr.dev/tui/docs/agent-automation/
- **V-HDR-7** — Custom presentation without lifecycle takeover: `pane.report_metadata {pane_id, source,
  title, display_agent, state_labels, tokens, seq, ttl_ms}`. `agent.view.set` atomically **replaces**
  the user's Agents view (no restore API) — avoid.
  Source: https://herdr.dev/tui/docs/socket-api/
- **V-HDR-8** — Plugin-pane alternative (`plugin.pane.open`) is manifest-only in v1; `popup` placement
  has **no pane id** and emits **no lifecycle events** (unusable for close detection). Ordinary pane is
  simpler and fully observable.
  Source: https://herdr.dev/tui/docs/socket-api/
- **V-HDR-9** — Herdr's built-in OMP integration reports the **main** OMP session's state/resume; it does
  not expose native child PTYs. Installed here: `omp: current (v10)`.
  Source: https://herdr.dev/tui/docs/integrations/

### Unknown (live-test needed)

- **U-HDR-1** — Whether Herdr agent auto-detection misclassifies the viewer pane as an agent. **→ P4 live test.**
- **U-HDR-2** — Focus behavior when creating a tab in a non-focused workspace (docs cover entity focus,
  not workspace auto-switch). **→ P4 live test.**
- **U-HDR-3** — `pane.exited` payload beyond ids (exit code/reason). **→ P4.**
- **U-HDR-4** — Double-create race when reopening while a `layout.apply`-induced `tab.closed` is in
  flight. **→ P4 (authoritative-read dedupe).**
- **U-HDR-5** — Whether `events.wait` coexists with a concurrent `events.subscribe` on one connection. **→ P4.**

---

## 3. Load-bearing risk

**R-01 (critical, gates v1):** full live fidelity depends on `pi.events` carrying `task:subagent:*`
with usable payloads (U-OMP-1..4). Documented channel names + strong inference, but no published
subscribe contract or payload schema. **Phase 0** is a bounded empirical probe on installed 19.0.1
(one cheap task call, dump frames). If insufficient, fall back to artifact-tree JSONL polling +
`omp render` (fully documented, less live). We do **not** read OMP implementation source to fill the gap.

---

## 4. Phase 0 outcome (2026-11-20) — R-01 resolved

The bounded probe (`phase-0-probe-report.md`) confirmed on installed OMP 19.0.1 that `pi.events` is an
EventEmitter-like bus (`on`/`emit`/`hasListeners`/`watchListeners`) and that `.on` subscriptions to all
three `task:subagent:*` channels receive full-fidelity frames during a real task spawn:

- **U-OMP-1 resolved:** `pi.events` carries the frames (observed in print mode; TUI confirmation = P2).
- **U-OMP-2 resolved:** payload shapes observed (report §"Observed payload shapes").
- **U-OMP-3 resolved:** progress carries status + tokens/cost/requests/toolCount/durationMs/model/contextWindow.
- **U-OMP-4 resolved:** `task:subagent:event` streams the full session-event union incl. tool calls/results.
- **U-OMP-6 resolved:** `lifecycle.sessionFile` gives the exact child JSONL path.
- **Still open:** idle/parked/aborted transitions (P2); TUI-mode confirmation (P2); thinking-visibility
  mirroring (P3). R-01 downgraded from critical-unknown to verified-with-caveat.