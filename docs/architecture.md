# herdr-omp-lens — architecture notes (v1 + v1.1, shipped)

This document describes the **shipped** v1 architecture: an in-process OMP extension that observes
the native `task` subagents of the current session and publishes them over a local-only bridge to a
read-only viewer CLI running in Herdr panes. Authoritative requirements live in the
[SDD](superpowers/specs/2026-11-19-herdr-omp-lens-design.md); this note mirrors what the code does,
not the draft.

## Component map

```
OMP interactive session (the agent that owns the workers)
  └─ src/extension/            in-process extension, bound via package.json `omp.extensions`
       gate          callerContext() — activates only under HERDR_ENV=1 with all caller ids
       observe/      pi.events.on(task:subagent:{event,progress,lifecycle}) + pi.on(before_subagent_spawn)
       roster        direct-worker reducer (status map, notices, counters from the nested progress envelope)
       history/      bounded fs scan of ~/.omp/agent/sessions/<encoded-cwd>/ (read-only, no lease, no history://)
       bridge        per-session unix socket (0700 dir, 0600 sock), NDJSON, hello + deltas + notices
       topology      overview tab + worker splits through the guarded Herdr adapter (no-focus only)
       resolve       resolveViewerCommand() → `bun <pkg>/src/viewer/cli.ts` (never process.cwd())
  ├─ src/herdr/                 the single Herdr boundary
       context       HERDR_* env → CallerContext
       transport     unix-socket NDJSON RPC + events.subscribe stream (timeouts, circuit break)
       adapter       typed methods only; every create/split passes focus:false; env passthrough
       guards        runtime denylist + param guards (no layout.apply tab_id, no agent start, no focus:true)
       lifecycle     transparent resubscribe on events_lost → onEventsLost reconcile hook
  ├─ src/protocol/              versioned NDJSON codec (PROTOCOL_VERSION=1)
       types/codec  strict Zod shapes; client boundary accepts ONLY the viewer handshake (control.* rejected)
  └─ src/viewer/                read-only renderer, runs as an ordinary Herdr pane
       cli           env/argv resolution, keymap (select + view-local transcript scroll), main loop
       client        connects, handshakes, applies hello + deltas (never writes after the handshake)
       state/render  roster + persistent finished section (v1.2: retained after reap, ≤100) + history (not-live) + banners
       tui           v1.1 two-column OMP-look screen: pi-tui `agent` painter roster (left) + inspector/transcript (right);
                     exact-version pin to the installed OMP; stacks <100 cols; LENS_PLAIN/--plain → legacy render
       transcript    `omp render <sessionFile> --plain` via a filtered temp copy (thinking hidden by default)
```

## Data flow

1. **Gate.** `lensExtension(pi)` is a complete no-op unless `HERDR_ENV=1` and the caller context vars
   are all present — no commands, hooks, sockets, or Herdr calls happen otherwise.
2. **Observe.** `before_subagent_spawn` opens the direct-worker id set; the three
   `task:subagent:*` channels feed a synchronous reducer (status transitions, counters, activity,
   sessionFile). Handlers enqueue work and return — no `await` inside a bus or command handler.
3. **Publish.** The bridge binds a unix socket in a per-session `0700` directory (`0600` socket),
   authenticates with the versioned `{v:1, role:"viewer", session}` handshake, then streams `hello`
   (roster + history) followed by `worker.upsert` / `worker.removed` / `transcript.ref` / `notice`.
   Progress bursts coalesce to at most one delta per ≤150 ms window (latest-wins).
4. **Present.** The topology manager subscribes to the lifecycle event stream **before** the first
   `tab.create`, opens exactly one `--no-focus` `OMP subagents` tab, and runs the viewer in its root
   pane with `env = {LENS_SOCKET_PATH, LENS_SESSION, [LENS_WORKER_ID]}`. `LENS_SOCKET_PATH` is the
   *bridge* socket, never the caller's `HERDR_SOCKET_PATH`.
5. **Render.** The viewer paints roster, inspector, and the selected worker's transcript. On a TTY
   (v1.1) it renders OMP's own look through `@oh-my-pi/pi-tui`'s `agent` painter — two columns
   (roster left, detail right), stacked under 100 columns; a dynamic import falls back to the plain
   single-column renderer when pi-tui is absent or `LENS_PLAIN=1`/`--plain` is set. Both columns
   render at all times (v1.2, owner UX decision 2026-11-25): finished workers stay listed after
   `worker.removed` (finished rows retained; non-terminal reaps demote to *not-live* history;
   retention ≤100). The only bytes the viewer ever sends are its handshake.

## Topology lifecycle

- **Auto-open** on the first `worker.spawned` signal (single-flight: concurrent spawns open exactly
  one tab) and on startup when the history scan is non-empty (`onHistoryPresent`, D2).
- **Reopen** after a manual close on the *next* spawn — one tab, deduplicated against an
  authoritative `session.snapshot` read so concurrent events can't double-create.
- **One tab per OMP session (v1.4).** The first session keeps the plain `OMP subagents` label (the
  D2 restart anchor); additional live sessions get `OMP subagents · <suffix>` (suffix = the session
  id's random tail — UUIDv7 heads collide). A session rebinds only its OWN tab; the plain anchor is
  adoptable only when its viewer's owner pid is dead (restart orphan). Ownership is read from the
  viewer's argv0 token `lens:<suffix>:<pid>` via `pane.process_info` — a live foreign owner is never
  hijacked.
- **`/lens`** opens the overview; **`/lens split <workerId>`** opens a no-focus worker-scoped split
  (one per worker; repeats reuse the live pane). Both are read-only and never touch the worker.
- **Survivor rebind (D2).** After an OMP restart a surviving `OMP subagents` pane is rebound to the
  *new* bridge socket — the viewer reconnects to the new session and history shows *not-live*; no
  duplicate tab is created.
- **Authoritative reconcile.** `pane.closed`/`pane.exited` are hints; state clears only when an
  authoritative `getPane`/`snapshot` misses. `pane.moved` rewrites owned ids so a later close hits
  the new id. `events_lost` triggers the adapter's transparent resubscribe plus one
  `onEventsLost` → `snapshot()` reconcile — never a second subscription.

## Invariants (enforced by tests, tamper-proven)

- **Read-only v1.** No `control.*` frame is accepted; the viewer has no control affordance.
- **No worker duplication.** View operations never emit `before_subagent_spawn`; the roster is only
  fed by native bus frames.
- **Worker ≠ view.** Closing the overview or a split emits topology signals only — never
  `worker.removed`, never an OMP side effect.
- **No focus theft.** Every adapter create/split carries `focus:false`; `layout.apply` with
  `tab_id`, `agent start`, `report_agent`, and `focus:true` are runtime-denied at the transport
  boundary (two layers: source scan + runtime guard).
- **No focus or agent claims.** Owned panes report only `pane.report_metadata` with the required
  `source` field.
- **Local-only.** The bridge binds unix sockets only — `0600` in a `0700` per-session dir, unlinked
  on `close()`/SIGINT/SIGTERM; no TCP listener is ever bound.
- **Fire-and-forget.** Every `pi.on`/`pi.events.on` handler and command is synchronous; a throwing
  downstream (dead bridge, dead Herdr) becomes one `notice`, never a thrown escape into an OMP turn.
  `session_shutdown` tears the lens down asynchronously and idempotently.

## Degraded mode (D1)

- `pi.events` absent → the bus subscribes nothing, `before_subagent_spawn` still attaches, and after
  the bridge starts exactly **one** `notice{level:"warn"}` is broadcast. Discovery relaxes to the
  bounded artifact scan (live roster/counter promises FR-02/04/10 are explicitly relaxed).
- Herdr adapter/socket failure → the topology manager goes `degraded` with one `notice`, signals
  still flow, and it recovers through the `events_lost` reconcile path; refused fails fast, a stalled
  socket trips the per-call timeouts (2 s connect / 5 s RPC) and circuit-breaks.
- Missing/corrupt history → that entry is skipped with a per-file warning; the scan still succeeds
  and the viewer gets one deduplicated warn notice.

## History

`src/extension/history/` scans `~/.omp/agent/sessions/<encoded-cwd>/<ts>_<session-id>/*.jsonl` for
the current cwd only: newest ≤20 session dirs, ≤100 workers, mtime-keyed cache, bounded tail-read for
the terminal marker. Every emitted snapshot is `historical:true`, merged into `hello.history` with
**live-wins** dedupe. The scan performs no writes, no spawns, no sockets, no `history://` reads —
`omp render` is the only transcript path.

## Testing shape

- `tests/protocol|viewer|herdr|extension` — unit tests for codec, state/render, adapter, roster,
  observe wiring, topology (mocked adapter).
- `tests/guards` — safety-invariant tamper tests, each proven red on a deliberate sabotage
  (`tests/guards/sabotage.md`), plus source-scan + runtime denylist guards and deterministic perf
  bounds (100-frame burst → 1 coalesced upsert; 50k frames → flat heap, bounded lines).
- `tests/harness/isolated-session` + `tests/e2e/isolated-session.e2e.ts` + `scripts/run-e2e.sh` —
  disposable named Herdr-session E2E (safe default; `RUN_E2E_LIVE=1` for the full lifecycle).
- `bun scripts/gen-dod-report.ts` — regenerates [`analysis/dod-v1-report.md`](analysis/dod-v1-report.md):
  maps every FR-01..15 + NFR-01..06 to a test or a named manual capture, plus the doc-vs-shipped
  checklist.
