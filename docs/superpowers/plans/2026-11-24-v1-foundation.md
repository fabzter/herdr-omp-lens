# herdr-omp-lens v1 Foundation (P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. TDD is mandatory (superpowers:test-driven-development): watch each test fail before implementing.

**Goal:** Build the dependency-light foundation of the OMP extension — package/toolchain, the versioned NDJSON bridge protocol, the Herdr adapter (no-focus, socket-API, guarded), lifecycle subscription, and the activation gate — all unit-tested.

**Architecture:** Pure-TypeScript modules (`src/protocol`, `src/herdr`) with Zod boundary validation and an injectable Herdr transport so unit tests need no live Herdr. Only `src/extension` touches the OMP extension API (structural type in P1). No viewer rendering, roster, or topology orchestration here (P2–P4).

**Tech Stack:** Bun 1.3.x, TypeScript (strict), Zod v4, Biome (lint). OMP 19.1.1 / Herdr 0.9.5 are the runtime targets (re-pinned to 19.1.1 per owner OI-1 decision 2026-11-25; observed bus shapes unchanged from the 19.0.1 Phase-0 probe).

**Spec:** `docs/plans/specs/phase-01-foundation-spec.md` (canonical interfaces), `docs/plans/specs/00-reconciliation.md` (RC-1..15), `docs/superpowers/specs/2026-11-19-herdr-omp-lens-design.md` (SDD §7–10).

## Global Constraints

- License MIT; package name `herdr-omp-lens`; `type: module`; `omp.extensions: ["./src/extension/index.ts"]`.
- `PROTOCOL_VERSION = 1`. `WorkerStatus = "queued"|"running"|"idle"|"parked"|"completed"|"failed"|"aborted"`.
- `WorkerSnapshot` fields exactly: `id, name?, agent, status, model?, activity?, sessionFile?, counters?{tokens?,cost?,requests?,toolCount?,durationMs?}, parentToolCallId?, index?, modelRole?, thinkingLevel?, assignment?, historical?, updatedAt`.
- Server→client `Message`: `hello{session,workers,history?}` | `worker.upsert{worker}` | `worker.removed{id}` | `transcript.ref{id,sessionFile,artifactDir?}` | `topology{tabId?,paneIds,state}` | `notice{level,message}`. Client→server `ClientMessage {v:1,role:"viewer",session}`.
- `decodeMessage`/`decodeClientMessage` return typed `{ok:true,...}|{ok:false,error}` and **never throw**; the client boundary **rejects `control.*`** (FR-11).
- `CallerContext.socketPath` is **Herdr's** socket (`$HERDR_SOCKET_PATH`). The bridge socket is separate (P2). Never confuse them (F-01).
- Herdr adapter: `focus:false` always; `env` is a JSON socket-API field on `tab.create`/`pane.split` (not a CLI flag). `PaneMetadata.source` required.
- Transport denylist (runtime, tamper-tested): never `layout.apply` with `tab_id`, never `agent.start`, never `pane.report_agent`, never `agent.view.set` (V-HDR-5/6/7, D5).
- `subscribeLifecycle` owns transparent `events_lost` resubscribe + `subscription_started` wait; `onEventsLost` hook lets the caller reconcile (F-12).
- Extension handlers fire-and-forget; the gate is a no-op outside Herdr (`HERDR_ENV=1` + ids). `resolveViewerCommand()` resolves against the package root, never cwd (F-16).
- No network access in any module; local unix sockets only. No `any`/`as any` (project style); validate external input with Zod.
- Commands: `bun test`, `bun run typecheck` (`tsc --noEmit`), `bun run lint` (`biome check src tests`). All must be green.

## Review Focus

1. **Malformed/oversized NDJSON** fed to the codec → typed `{ok:false}`, never a throw or crash (NFR-02).
2. **`control.*` or wrong-role client frames** → rejected at the client boundary (FR-11), never accepted.
3. **Missing/partial Herdr env** → gate no-ops, `callerContext` returns null, no socket attempted (FR-01).
4. **Forbidden Herdr calls** (`layout.apply`+`tab_id`, `agent.start`, `report_agent`, `agent.view.set`) → transport guard throws; tamper test fails if removed (D5).
5. **`events_lost` / stalled socket** → transparent resubscribe + reconcile hook; bounded timeouts, no hung turn (F-12/F-15).

---

### Task 1: Package scaffold & toolchain

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.json`, `src/index.ts` (re-export barrel), `tests/sanity.test.ts`
- Modify: `.gitignore` (add `node_modules/`, already present; ensure `dist/`)

**Interfaces:**
- Produces: scripts `test`/`typecheck`/`lint`; devDeps `typescript`, `zod`, `@biomejs/biome`, `bun-types`; `omp.extensions` entry.

- [ ] **Step 1: Scaffold** `package.json` (name `herdr-omp-lens`, version `0.1.0`, `type:module`, license MIT, `omp.extensions:["./src/extension/index.ts"]`, scripts test=`bun test`, typecheck=`tsc --noEmit`, lint=`biome check src tests`), strict `tsconfig.json` (module ESNext, moduleResolution bundler, target ES2022, strict, types `["bun-types"]`, noEmit), minimal `biome.json`. Run `bun install`.
- [ ] **Step 2: Write sanity test** `tests/sanity.test.ts`: `test("toolchain runs", () => expect(1+1).toBe(2))`.
- [ ] **Step 3: Verify** `bun test` PASS, `bun run typecheck` clean, `bun run lint` clean.
- [ ] **Step 4: Commit** `chore: package scaffold and toolchain`.

### Task 2: Protocol types & codec

**Files:**
- Create: `src/protocol/types.ts`, `src/protocol/codec.ts`, `tests/protocol/codec.test.ts`

**Interfaces:**
- Produces: `WorkerStatus`, `WorkerSnapshot`, `Message`, `ClientMessage`, `DecodeResult`, `ClientDecodeResult` (types.ts, exact Global Constraints); `encodeMessage(m: Message): string`, `decodeMessage(line: string): DecodeResult`, `decodeClientMessage(line: string): ClientDecodeResult` (codec.ts).
- Consumes: Zod.

- [ ] **Step 1: Write failing tests** (`tests/protocol/codec.test.ts`):
  - round-trip: `decodeMessage(encodeMessage(hello))` → `{ok:true, message: hello}` for a `hello` with one `WorkerSnapshot` (all optional fields populated) and `history`.
  - each `Message` variant round-trips (`worker.upsert`, `worker.removed`, `transcript.ref`, `topology`, `notice`).
  - `decodeMessage("{not json")` → `{ok:false}` (no throw); `decodeMessage(JSON.stringify({v:2,type:"hello"}))` → `{ok:false}`; unknown `type` → `{ok:false}`.
  - `decodeClientMessage(JSON.stringify({v:1,role:"viewer",session:"s1"}))` → `{ok:true, message:{v:1,role:"viewer",session:"s1"}}`.
  - `decodeClientMessage(JSON.stringify({v:1,role:"viewer",session:"s",type:"control.steer"}))` → `{ok:false}`; wrong `role` → `{ok:false}`; missing `session` → `{ok:false}`.
  - fixture: parse a real `task:subagent:progress`-derived `worker.upsert` (counters from nested source) round-trips.
- [ ] **Step 2: Run** `bun test tests/protocol/codec.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** types.ts (exact fields) + codec.ts with Zod schemas; `encodeMessage` = `JSON.stringify(m)+"\n"`; decoders parse then `safeParse`, mapping failure to `{ok:false,error}`; client schema is strict (`.strict()`), rejects extra `type`/`control.*`.
- [ ] **Step 4: Run** `bun test` → PASS (full suite).
- [ ] **Step 5: Commit** `feat(protocol): versioned NDJSON codec with Zod boundary and control rejection`.

### Task 3: Herdr context detection

**Files:**
- Create: `src/herdr/context.ts`, `tests/herdr/context.test.ts`

**Interfaces:**
- Produces: `CallerContext {workspaceId,tabId,paneId,binPath,socketPath}`, `isHerdrEnv(env?): boolean`, `callerContext(env?): CallerContext|null`.

- [ ] **Step 1: Write failing tests:** full env (`HERDR_ENV=1`, `HERDR_WORKSPACE_ID=w1`, `HERDR_TAB_ID=w1:t1`, `HERDR_PANE_ID=w1:p1`, `HERDR_BIN_PATH=/bin/herdr`, `HERDR_SOCKET_PATH=/sock`) → `isHerdrEnv` true, `callerContext` maps fields exactly (`socketPath` from `HERDR_SOCKET_PATH`). `HERDR_ENV` unset → false/null. `HERDR_ENV=1` but missing `HERDR_PANE_ID` → false/null. `HERDR_ENV=0` → false.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** context.ts (default `env = process.env`; require `HERDR_ENV==="1"` and all five ids present).
- [ ] **Step 4: Run** `bun test` → PASS.
- [ ] **Step 5: Commit** `feat(herdr): caller context detection`.

### Task 4: Herdr transport & adapter

**Files:**
- Create: `src/herdr/transport.ts`, `src/herdr/adapter.ts`, `src/herdr/guards.ts`, `tests/herdr/adapter.test.ts`, `tests/herdr/guards.test.ts`

**Interfaces:**
- Consumes: `CallerContext` (Task 3), `PaneMetadata`/`PaneInfo`/`SessionSnapshot` types (define in `src/herdr/types.ts`).
- Produces: `HerdrTransport {request(method,params):Promise<unknown>}`; `socketTransport(socketPath): HerdrTransport`; `assertAllowedRequest(method,params):void` (guards); adapter fns `createOverviewTab(c,label,env?,t?)`, `splitPane(c,targetPaneId,dir,env?,t?)`, `runInPane(c,paneId,command,t?)`, `getPane(c,paneId,t?)`, `snapshot(c,t?)`, `reportMetadata(c,paneId,meta,t?)` (default `t = socketTransport(c.socketPath)`).

- [ ] **Step 1: Write failing guard tests** (`guards.test.ts`): `assertAllowedRequest("layout.apply",{tab_id:"t"})` throws; `("layout.apply",{})` ok; `("agent.start",{})` throws; `("pane.report_agent",{})` throws; `("agent.view.set",{})` throws; `("tab.create",{focus:false})` ok. Tamper: removing a denylist entry makes the corresponding test fail.
- [ ] **Step 2: Write failing adapter tests** (`adapter.test.ts`, mock transport recording calls): `createOverviewTab` sends `tab.create` with `workspace_id=c.workspaceId`, `label`, `focus:false`, and `env` passed through; returns `{tabId,rootPaneId}` from response. `splitPane` sends `pane.split` `focus:false` + `env`. `reportMetadata` sends `pane.report_metadata` including `source`. `runInPane` sends `pane.send_input`. Each adapter call routes through `assertAllowedRequest`.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement** guards.ts (denylist), transport.ts (`HerdrTransport` interface + `socketTransport` JSON-over-unix client with per-call timeout), adapter.ts (calls guard then `t.request`, maps responses; `focus:false` hardcoded).
- [ ] **Step 5: Run** `bun test` → PASS.
- [ ] **Step 6: Commit** `feat(herdr): guarded no-focus adapter over injectable socket transport`.

### Task 5: Lifecycle subscription & events_lost recovery

**Files:**
- Create: `src/herdr/lifecycle.ts`, `src/herdr/types.ts` (LifecycleHandlers/Subscription/PaneInfo/SessionSnapshot/PaneMetadata if not already), `tests/herdr/lifecycle.test.ts`

**Interfaces:**
- Consumes: `HerdrTransport` (Task 4), `CallerContext`.
- Produces: `LifecycleHandlers` (onTabClosed/onPaneClosed/onPaneExited/onPaneMoved/onWorkspaceClosed/onLayoutUpdated/onEventsLost), `Subscription {close()}`, `subscribeLifecycle(c, handlers, t?): Promise<Subscription>`.

- [ ] **Step 1: Write failing tests** (mock transport with an event emitter): subscribing sends `events.subscribe` with the six lifecycle types; a pushed `tab.closed {workspace_id,tab_id}` invokes `onTabClosed`; `pane.moved` invokes `onPaneMoved`; an `events_lost` error triggers a **resubscribe** (second `events.subscribe`) and invokes `onEventsLost` once; `close()` ends the subscription.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** lifecycle.ts (subscribe, dispatch by event type, on `events_lost` resubscribe + wait `subscription_started` + call `onEventsLost`; bounded).
- [ ] **Step 4: Run** `bun test` → PASS.
- [ ] **Step 5: Commit** `feat(herdr): lifecycle subscription with transparent events_lost recovery`.

### Task 6: Extension gate & viewer resolution

**Files:**
- Create: `src/extension/index.ts`, `src/extension/api.ts` (structural `LensExtensionApi`), `src/extension/resolve.ts`, `tests/extension/gate.test.ts`, `tests/extension/resolve.test.ts`

**Interfaces:**
- Consumes: `isHerdrEnv`/`callerContext` (Task 3).
- Produces: `default lensExtension(pi: LensExtensionApi): void`; `resolveViewerCommand(): string`.

- [ ] **Step 1: Write failing gate tests:** with `HERDR_ENV` unset, `lensExtension(fakePi)` registers no command and subscribes nothing (spy counts 0); with full Herdr env, it activates (registers a `/lens` command placeholder via `pi.registerCommand`). `fakePi` is a structural stub (`on`, `registerCommand`, `events`).
- [ ] **Step 2: Write failing resolve test:** `resolveViewerCommand()` returns an absolute path under the package root (contains `src/viewer/cli.ts`), independent of `process.cwd()` (change cwd in test, path unchanged).
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement** api.ts (minimal structural type), resolve.ts (`import.meta.dirname`-based package-root resolution), index.ts (gate: no-op unless `isHerdrEnv`; register `/lens` placeholder; fire-and-forget).
- [ ] **Step 5: Run** `bun test` → PASS; `bun run typecheck` + `bun run lint` clean.
- [ ] **Step 6: Commit** `feat(extension): Herdr activation gate and package-root viewer resolution`.

---

## Self-review notes

- Spec coverage: P1-R1 (Task 1/6 load), R2 gate (Task 6), R3 codec round-trip/rejection (Task 2), R4 control rejection (Task 2), R5 no-focus + forbidden-call guards (Task 4), R6 lifecycle + events_lost (Task 5), R7 toolchain (Task 1). F-01 socket distinction (Task 3/4), F-07 ClientMessage (Task 2), F-12 source + resubscribe (Task 4/5), F-15 timeouts/fire-and-forget (Task 4/6), F-16 resolveViewerCommand (Task 6).
- Review Focus tests live in: codec (1,2), context/gate (3), guards (4), lifecycle (5).
- P2+ interfaces (roster, bridge publisher, topology, viewer) are intentionally NOT in P1.
