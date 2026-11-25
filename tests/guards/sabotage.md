# P6-R2 sabotage evidence — tests/guards/invariants.test.ts

One deliberate sabotage per invariant. Each patch was applied to `src/`, the suite was run with
`bun test tests/guards/invariants.test.ts`, the red output was captured, and the patch was reverted.
After all seven runs `git diff -- src/` is empty and the clean suite is green (7 pass / 83 expect
calls). All sabotage diffs below are verbatim; red quotes are verbatim output (paths trimmed where
noted).

---

## (a) FR-14 — worker survives viewer close

**Sabotage** (`src/extension/topology.ts`, `handlePaneClosed`): a closed worker split claims the
worker is gone — the exact FR-14 violation.

```diff
 	for (const [workerId, splitPaneId] of splits) {
+		safeEmit({ v: 1, type: "worker.removed", id: workerId }); // SABOTAGE
 		if (splitPaneId === paneId) {
```

**Red output:**

```
332 | 		const removed = h.sent.filter((m) => m.type === "worker.removed");
333 | 		expect(removed).toHaveLength(0);
error: expect(received).toHaveLength(expected)

Expected length: 0
Received length: 1

      at <anonymous> (tests/guards/invariants.test.ts:333:19)
(fail) P6-R2 invariant tamper tests > (a) FR-14: closing the overview and a split never removes the worker

 6 pass
 1 fail
```

---

## (b) FR-14 — no duplicate worker spawned by any view operation

**Sabotage** (`src/extension/index.ts`, roster-signal → topology wiring): the view-open signal
re-feeds a duplicate of the worker into the roster — the "view op spawns a worker" violation.

```diff
 			case "worker.spawned":
 				void topo.onWorkerSpawned().catch(onError);
+				obs.roster.applySpawn({ type: "before_subagent_spawn", agent: s.worker.agent, spawnKey: `${s.worker.id}-dup` });
+				obs.roster.applyLifecycle({ id: `${s.worker.id}-dup`, agent: s.worker.agent, status: "running" });
 				break;
```

The duplicate itself emits `worker.spawned`, recursively spawning `…-dup-dup-dup…` — runaway
duplication, i.e. the sabotage cannot hide behind a no-op.

**Red output:**

```
+   "w-2-dup-dup-dup-dup-dup-dup-dup-dup-dup-dup-dup... (27608 bytes truncated) ...-dup-dup-dup-dup-dup-dup-dup-dup-dup-dup-dup-dup",
+   "w-2-dup-dup-dup-dup-dup-dup-dup-dup-dup-dup-dup... (27676 bytes truncated) ...-dup-dup-dup-dup-dup-dup-dup-dup-dup-dup-dup-dup",
  ]

- Expected  - 0
+ Received  + 6942

      at <anonymous> (tests/guards/invariants.test.ts:363:17)
(fail) P6-R2 invariant tamper tests > (b) FR-14: open/split/close/reopen never spawns a duplicate worker [682.85ms]

 5 pass
 2 fail
```

---

## (c) FR-13 — no focus theft across open/split/reopen

**Sabotage** (`src/herdr/adapter.ts`, `createOverviewTab`): flip the pinned no-focus flag.

```diff
-	const params: Record<string, unknown> = { workspace_id: c.workspaceId, label, focus: false };
+	const params: Record<string, unknown> = { workspace_id: c.workspaceId, label, focus: true };
```

The request never reached the mock transport: `assertAllowedRequest` (the P1-R5 runtime boundary)
threw inside `guardedRequest`, proving defense-in-depth — the tamper test fails even though the
`focus !== true` transport assertion was never evaluated.

**Red output:**

```
HerdrForbiddenError: forbidden herdr request: tab.create with focus:true (adapter is no-focus)
 method: "tab.create",

      at assertAllowedRequest (src/herdr/guards.ts:57:9)
      at guardedRequest (src/herdr/adapter.ts:26:2)
      at createOverviewTab (src/herdr/adapter.ts:92:9)
      at <anonymous> (tests/guards/invariants.test.ts:408:32)
(fail) P6-R2 invariant tamper tests > (c) FR-13: every adapter create/split/run is no-focus; guard still throws

 6 pass
 1 fail
```

---

## (d) FR-11 — `control.*` frames rejected at the handshake boundary

**Sabotage** (`src/protocol/codec.ts`): relax the strict client schema so extra keys pass.

```diff
-const clientMessageSchema: z.ZodType<ClientMessage> = z.strictObject({
+const clientMessageSchema: z.ZodType<ClientMessage> = z.object({
```

**Red output:**

```
455 | 			const r = decodeClientMessage(frame);
456 | 			expect(r.ok).toBe(false);
error: expect(received).toBe(expected)

Expected: false
Received: true

      at <anonymous> (tests/guards/invariants.test.ts:456:17)
(fail) P6-R2 invariant tamper tests > (d) FR-11: control.* frames are rejected at decodeClientMessage

 6 pass
 1 fail
```

---

## (e) FR-01 — extension is a no-op outside Herdr

**Sabotage** (`src/extension/index.ts` entry): bypass the HERDR_ENV gate with a fabricated context.

```diff
-	const ctx = callerContext();
-	if (ctx === null) return;
+	const ctx: CallerContext = callerContext() ?? {
+		workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1",
+		binPath: "/bin/herdr", socketPath: "/sock",
+	};
```

**Red output:**

```
478 | 		expect(fake.commands.size).toBe(0);
error: expect(received).toBe(expected)

Expected: 0
Received: 1

      at <anonymous> (tests/guards/invariants.test.ts:478:30)
herdr-omp-lens: observation failed to start: Error: must never be called
(fail) P6-R2 invariant tamper tests > (e) FR-01: HERDR_ENV unset — extension registers nothing, activates nothing

 6 pass
 1 fail
```

---

## (f) FR-12 — OMP turn completes with Herdr/bridge dead

**Sabotage** (`src/extension/roster.ts`, `notice()`): let a throwing subscriber (the dead bridge's
`broadcast`) propagate into the bus handler — the failure the swallow-into-notices contract exists
to prevent.

```diff
 		for (const cb of this.noticeCbs) {
-			try {
-				cb(message);
-			} catch {
-				// A throwing notice subscriber must never break the reducer.
-			}
+			cb(message); // SABOTAGE: unguarded notice subscriber
 		}
```

**Red output:**

```
506 | 		}).not.toThrow();
error: expect(received).not.toThrow()

Error name: "Error"
Error message: "dead bridge"

      at <anonymous> (tests/guards/invariants.test.ts:506:10)
(fail) P6-R2 invariant tamper tests > (f) FR-12: handlers never throw when bridge + Herdr are dead

 6 pass
 1 fail
```

---

## (g) F-15 — all `pi.on` / `pi.events.on` handlers enqueue synchronously, never await I/O

**Sabotage** (`src/extension/observe/index.ts`): an `await` inside a bus handler — parse+reduce no
longer completes before return.

```diff
-	const onEvent = (payload: unknown): void => {
+	const onEvent = async (payload: unknown): Promise<void> => {
 		if (stopped) return;
+		await Promise.resolve(); // SABOTAGE: async hop inside the handler
 		const parsed = parseSubagentEvent(payload);
 		if (parsed.ok) roster.applyEvent(parsed.value);
 	};
```

**Red output:**

```
552 | 		for (const r of returns) {
553 | 			expect(r).toBeUndefined();
error: expect(received).toBeUndefined()

Received: Promise { <pending> }

      at <anonymous> (tests/guards/invariants.test.ts:553:14)
(fail) P6-R2 invariant tamper tests > (g) F-15: every pi.on / pi.events.on / command handler is synchronous

 6 pass
 1 fail
```

---

## Restore verification

`git status --porcelain` after the seventh restore shows only `?? tests/guards/` (the new suite +
this file); `git diff -- src/` is empty. Clean re-run: `7 pass, 0 fail, 83 expect() calls`.
