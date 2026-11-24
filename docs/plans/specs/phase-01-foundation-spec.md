# Phase P1 — Foundation (spec)

- Version: v1 "The Window"
- Status: **Draft for owner review.**
- Depends on: P0 (done — bus confirmed), master plan, SDD.
- Produces interfaces for: P2 (observation), P3 (viewer), P4 (topology), P5 (history).
- Source of truth: `../../superpowers/specs/2026-11-19-herdr-omp-lens-design.md`.

> This is a phase **spec** (requirements + interfaces + acceptance), not a subplan. Per the long-horizon
> process, all v1 phase specs settle before any code subplan is written.

## Goal

Stand up the reusable package and the three shared foundations every later phase builds on: the
**bridge protocol**, the **Herdr adapter**, and the **activation gate** — with a test harness and local
dev loop. No observation, rendering, or topology behavior yet beyond the gate.

## Scope

In scope:
- Package scaffold (`package.json` with `omp.extensions`, Bun toolchain, strict `tsconfig`, scripts).
- `src/protocol/` — versioned NDJSON message types + boundary validation + encode/decode.
- `src/herdr/` — typed, no-focus-by-default adapter over the Herdr CLI/socket + lifecycle subscription +
  authoritative-read helpers.
- `src/extension/index.ts` — default factory + **Herdr activation gate** (FR-01), no-op outside Herdr.
- `tests/` harness — Bun unit tests, a mocked-Herdr fixture, and an isolated-named-session helper stub
  for later integration phases.
- `LICENSE` (pending Q-02).

Out of scope (later phases): native-event subscription/roster (P2), viewer rendering (P3), tab/split
lifecycle orchestration (P4), history/restart (P5), hardening/release (P6).

## Requirements & acceptance criteria

- **P1-R1 Package loads.** `omp --extension ./src/extension/index.ts` loads the factory without error in
  a throwaway session. *Accept:* load succeeds; `/extensions` lists it; no runtime throw.
- **P1-R2 Activation gate (FR-01).** The extension activates only when `HERDR_ENV=1` and caller ids are
  present; otherwise it registers nothing observable. *Accept:* unit tests prove no-op when env absent
  or partial; active path returns the caller context.
- **P1-R3 Protocol round-trip.** Every v1 message type encodes to one NDJSON line and decodes back with
  boundary validation; malformed/unknown-version input is rejected with a typed error, never a throw
  that escapes. *Accept:* round-trip tests for `hello`, `worker.upsert`, `worker.removed`,
  `transcript.ref`, `topology`, `notice`; rejection tests for bad JSON, wrong `v`, unknown type.
- **P1-R4 Reserved control namespace.** `control.*` types exist but v1 decode rejects them as
  not-supported (FR-11). *Accept:* a `control.steer` frame is rejected with a typed `unsupported` error.
- **P1-R5 Herdr adapter no-focus default.** `createOverviewTab`/`splitPane` always pass no-focus; the
  adapter never calls `layout.apply` with `tab_id`, never `agent start`, never `report_agent`.
  *Accept:* unit tests against a mocked CLI assert the exact argv/socket payloads; a guard test fails if
  a focusing or destructive call is introduced.
- **P1-R6 Lifecycle subscription + reconcile.** Adapter exposes `subscribeLifecycle` (the session-wide
  close/move/exit set) and authoritative `getPane`/`snapshot`; an `events_lost` path triggers
  resubscribe + snapshot. *Accept:* mocked tests simulate close events (either order), `pane.moved`
  id-update, and `events_lost` recovery.
- **P1-R7 Local dev loop.** `bun install`, `bun test`, `bun run typecheck`, `bun run lint` all run with no
  cloud dependency. *Accept:* commands succeed on a clean checkout.

## Interfaces produced (consumed by later phases)

```ts
// src/protocol
export const PROTOCOL_VERSION = 1;
export type WorkerStatus = "queued" | "running" | "idle" | "parked" | "completed" | "failed" | "aborted";
export interface WorkerSnapshot {
  id: string; name?: string; agent: string; status: WorkerStatus;
  model?: string; activity?: string; sessionFile?: string;
  counters?: { tokens?: number; cost?: number; requests?: number; toolCount?: number; durationMs?: number };
  // F-06: lineage + model-role inspector fields (FR-07 / P3-R3), mapped by P2 from the bus.
  parentToolCallId?: string; index?: number; modelRole?: string; thinkingLevel?: string; assignment?: string;
  historical?: boolean;   // P5: true for persisted / not-live entries (additive; PROTOCOL_VERSION stays 1)
  updatedAt: number;
}
// Server -> client messages.
export type Message =
  | { v: 1; type: "hello"; session: string; workers: WorkerSnapshot[]; history?: WorkerSnapshot[] }
  | { v: 1; type: "worker.upsert"; worker: WorkerSnapshot }
  | { v: 1; type: "worker.removed"; id: string }
  | { v: 1; type: "transcript.ref"; id: string; sessionFile: string; artifactDir?: string }
  | { v: 1; type: "topology"; tabId?: string; paneIds: string[]; state: "open" | "closed" }
  | { v: 1; type: "notice"; level: "info" | "warn" | "error"; message: string };
export type DecodeResult = { ok: true; message: Message } | { ok: false; error: string };
export function encodeMessage(m: Message): string;           // one NDJSON line
export function decodeMessage(line: string): DecodeResult;   // typed ok | error, never throws
// F-07: client -> server handshake, validated at the same boundary; also rejects control.* (P1-R4 / FR-11).
export type ClientMessage = { v: 1; role: "viewer"; session: string };
export type ClientDecodeResult = { ok: true; message: ClientMessage } | { ok: false; error: string };
export function decodeClientMessage(line: string): ClientDecodeResult;

// src/herdr
// F-01: socketPath here is HERDR's server socket ($HERDR_SOCKET_PATH). It is NOT the bridge socket.
export interface CallerContext { workspaceId: string; tabId: string; paneId: string; binPath: string; socketPath: string }
export function isHerdrEnv(env?: NodeJS.ProcessEnv): boolean;
export function callerContext(env?: NodeJS.ProcessEnv): CallerContext | null;
// Viewer env handoff (P4 sets, P3 reads): LENS_SOCKET_PATH=<BRIDGE socket = BridgeHandle.socketPath>,
// LENS_SESSION=<OMP session id>. Never use CallerContext.socketPath for LENS_SOCKET_PATH (F-01).
// F-11: tab.create/pane.split env is a raw socket-API field; src/herdr uses the JSON socket protocol,
// not a CLI --env flag.
export function createOverviewTab(c: CallerContext, label: string, env?: Record<string, string>): Promise<{ tabId: string; rootPaneId: string }>;
export function splitPane(c: CallerContext, targetPaneId: string, dir: "right" | "down", env?: Record<string, string>): Promise<{ paneId: string }>;
export function runInPane(c: CallerContext, paneId: string, command: string): Promise<void>;
export interface LifecycleHandlers {
  onTabClosed?(e: { workspaceId: string; tabId: string }): void;
  onPaneClosed?(e: { workspaceId: string; paneId: string }): void;
  onPaneExited?(e: { workspaceId: string; paneId: string }): void;
  onPaneMoved?(e: { previousPaneId: string; previousWorkspaceId: string; previousTabId: string; pane: PaneInfo }): void;
  onWorkspaceClosed?(e: { workspaceId: string }): void;
  onLayoutUpdated?(e: { tabId: string }): void;
  onEventsLost?(): void;   // F-12: P1 auto-resubscribes + waits subscription_started; this hook lets P4 reconcile ids
}
export interface Subscription { close(): Promise<void>; }
export interface PaneInfo { paneId: string; tabId: string; workspaceId: string; title?: string; agent?: string }
export interface SessionSnapshot { workspaces: unknown[]; tabs: unknown[]; panes: PaneInfo[] }
// F-12: source is required by pane.report_metadata (V-HDR-7); tokens optional.
export interface PaneMetadata { source: string; title?: string; displayAgent?: string; stateLabels?: Record<string, string>; tokens?: Record<string, string>; seq?: number; ttlMs?: number }
export function subscribeLifecycle(c: CallerContext, handlers: LifecycleHandlers): Promise<Subscription>;
export function getPane(c: CallerContext, paneId: string): Promise<PaneInfo | null>;
export function snapshot(c: CallerContext): Promise<SessionSnapshot>;
export function reportMetadata(c: CallerContext, paneId: string, meta: PaneMetadata): Promise<void>;

// src/extension
export default function lensExtension(pi: ExtensionAPI): void;  // registers gate; no-op outside Herdr
// F-16: resolve the viewer invocation against the installed package root (import.meta.dirname / package bin),
// never the session cwd, so clean-profile FR-15 works in any working directory.
export function resolveViewerCommand(): string;
```

Field names align with the **observed** Phase 0 payloads (`phase-0-probe-report.md`). F-02: the roster
`counters` map from the **nested** `task:subagent:progress.progress.{tokens,cost,requests,toolCount,durationMs}`
(P2 models the envelope, not a flat object). Validation uses a schema parser at the boundary (Zod v4) per
the project style rules; types above are the named output, not raw `unknown`.

**Cross-spec contracts (ratified in `00-reconciliation.md`):** `WorkerSnapshot.historical?` and
`hello.history?` are the P5 history transport (additive, v1 stays 1); P2's publisher and P3's viewer
handle them. The viewer receives `LENS_SOCKET_PATH` (= **bridge** socket, `BridgeHandle.socketPath`) +
`LENS_SESSION` via the `env` argument (P4 sets, P3 reads) — **not** `CallerContext.socketPath` (F-01).
Roster signals use `Roster.onSignal(cb)` emitting `worker.spawned`/`worker.finished`/`roster.empty` (F-05).
`LifecycleHandlers` is the concrete shape P4 consumes; P1 owns transparent `events_lost` resubscribe (F-12).
The isolated-named-session helper is stubbed here, **implemented and owned by P4**, reused by P6's E2E.
`reportMetadata` is the adapter primitive (requires `source`); orchestration is P4-driven.

**Hardening (F-15/F-16):** all `pi.on`/`pi.events.on` handlers enqueue synchronously (fire-and-forget) and
never await I/O, so an OMP turn is never blocked (FR-12). The bridge binds a per-session socket inside a
`0700` directory (unique per OMP session/PID), unlinked on `BridgeHandle.close()`/SIGINT/SIGTERM. Herdr
adapter calls use explicit per-call timeouts (e.g. 2s connect / 5s RPC) and circuit-break to `degraded`.
`resolveViewerCommand()` resolves against the package root for clean-profile installs.

## Risks

- **Protocol drift** (undocumented upstream payloads): mitigated by `PROTOCOL_VERSION` + boundary
  validation + fail-soft decode (NFR-02). P2 re-confirms shapes in interactive TUI.
- **Herdr auto-detection of the viewer** (R-03): not exercised in P1 (no viewer process yet); deferred to
  P4 live test. The adapter already avoids `report_agent`.
- **Naming/license** (Q-01/Q-02): package name and LICENSE finalized once settled; scaffold uses the
  working name `herdr-omp-lens`.

## Open questions (settle before subplan)

- **Q-01** Package/repo name: keep `herdr-omp-lens`? *(recommend: keep)*
- **Q-02** License: MIT? *(recommend: MIT)*

## Milestone (testable software at this gate)

`bun test` green (protocol round-trip + rejection, adapter argv/reconcile guards, activation gate);
`bun run typecheck` and `bun run lint` green; the extension loads in a throwaway OMP session and no-ops
outside Herdr. This is a working, testable foundation — not yet a visible view.