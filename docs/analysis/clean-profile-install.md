# Clean-profile install + version discipline (P6-R9 / NFR-02 / FR-15 / F-16)

Date: 2026-11-25. Evidence for the P6-R9 acceptance:

> On pinned OMP 19.0.1 / Herdr 0.9.5: `omp plugin link` (or `install`) into a
> clean profile loads the extension, and first delegation opens the view from
> an arbitrary working directory — `resolveViewerCommand()` resolves against
> the installed package root, never the session cwd. Feature-detection
> degrades — never crashes — when a bus channel or Herdr command is absent.

## 1. Versions — drift recorded, owner decision open

| Component | Spec pin | Installed | Status |
|---|---|---|---|
| OMP | 19.0.1 | `omp/19.1.1` | **drift — open owner decision** |
| Herdr | 0.9.5 | `herdr 0.9.5` | exact |
| herdr-omp-lens | — | `0.1.0` | n/a |

Per the spec's "Version drift between spec and gate" risk rule, the drift is
recorded as an **open owner decision** (re-pin the spec vs accept 19.1.1), not
a silent re-pin. No package pins were changed. All evidence below was produced
on the installed versions (OMP 19.1.1 / Herdr 0.9.5). Nothing observed in this
task suggests a 19.1.1 regression; the run is evidence on the drifted version,
not proof of the pinned one — the owner decides whether the pin moves or a
19.0.1 re-verify is required.

## 2. Clean-profile install

### Profile isolation mechanism

`omp --profile <name>` is a global flag ("Use an isolated profile for auth,
sessions, settings, and caches") that also isolates the plugin registry.
`omp plugin list --profile=p6t7-probe --json` on a never-used profile returned
`{"npm": [], "marketplace": []}` — a genuinely clean plugin state. Note:
`--profile` must precede the subcommand (`omp --profile=X plugin link …`);
`omp plugin link --profile=X` is rejected as an unknown option.

### Install quirk (controller-verified, confirmed)

`omp install`/`plugin link` HANGS inside a Herdr pane: the extension's open
bridge/socket handles keep the install subprocess alive. The fix is to strip
the `HERDR_*` env vars. The link below ran in ~1.5 s with the strip:

```bash
env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
    -u HERDR_SOCKET_PATH -u HERDR_BIN_PATH \
    omp --profile=p6t7-clean plugin link /Users/fabzter/src/omp-fabz-improvements
# → ✔ Linked herdr-omp-lens from /Users/fabzter/src/omp-fabz-improvements
```

Result — `omp --profile=p6t7-clean plugin list --json`:

```json
{"name": "herdr-omp-lens", "version": "0.1.0",
 "path": "/Users/fabzter/.omp/profiles/p6t7-clean/plugins/node_modules/herdr-omp-lens",
 "manifest": {"extensions": ["./src/extension/index.ts"], "version": "0.1.0"},
 "enabled": true}
```

`~/.omp/profiles/p6t7-clean/plugins/node_modules/herdr-omp-lens` is a **symlink
→ `/Users/fabzter/src/omp-fabz-improvements`**, and
`plugins/omp-plugins.lock.json` pins `{version: 0.1.0, enabled: true}`. Runtime
inside a Herdr pane is unaffected — the quirk is install-time only.

### Profile seeding note (honest scope)

`--profile` isolates everything: settings, sessions, *and* the model catalog.
A truly empty profile drops into the first-run setup wizard and has no model
config. To make the delegation step executable, the run copied
`~/.omp/agent/models.yml` → `~/.omp/profiles/p6t7-clean/agent/models.yml`
(provider catalog only — plugin state stayed pristine; no `config.yml`, no
sessions were seeded). The first-run wizard was then skipped with `esc` keys,
landing on default `alibaba-token-plan/qwen3.7-plus`. This is recorded, not
hidden: the claim under test is plugin loading + root resolution, not
auth/bootstrap UX.

## 3. First delegation from an arbitrary non-repo cwd — live run

Session cwd was `/private/tmp/p6t7-scratch` — a disposable directory, **not**
the repo. Steps (all `herdr` CLI, bounded; focused workspace wN throughout):

```bash
herdr workspace create --cwd /tmp/p6t7-scratch --label lens-p6t7-clean --no-focus
# → workspace w11, root pane w11:p1, cwd /private/tmp/p6t7-scratch

herdr agent start p6t7lens --kind omp --pane w11:p1 --timeout 90000 -- \
    --profile p6t7-clean --config /tmp/p6t7-scratch/omp-overlay.yml
# → interactive_ready, argv: omp --profile p6t7-clean --config <overlay>
#   (overlay only disables prewalk — same as the P6-R6 E2E; user config untouched)

# first-run setup wizard skipped with esc keys → TUI: "π-p6t7-clean > Qwen3.7 Plus > p6t7-scratch"

herdr agent prompt p6t7lens "Use the task tool to dispatch exactly one
  subagent with instruction 'Reply with the single word alpha immediately.
  Do not call any tools.' Then reply done."
```

Observed:

- **Overview auto-opened**: `herdr tab list --workspace w11` →
  `w11:t2 "OMP subagents"` (pane `w11:p2`), alongside the agent tab `w11:t1`.
- **Viewer connected**: `herdr pane read w11:p2` →
  `omp lens — session 01a21203-f011-71ea-bf3b-8f5c17f115e9 [connected]`,
  `workers (0):` — the scout finished and was reaped during readback
  (finished-collapse is transient by design; see e2e-evidence.md F3).
- **Real delegation under the clean profile**: worker artifact
  `~/.omp/profiles/p6t7-clean/agent/sessions/--private-tmp-p6t7-scratch--/2026-11-25T09-22-57-681Z_01a21203-…/TenseCephalopod.jsonl`
  exists; its `.md` result file contains the scout reply `alpha`.
- **Viewer is a plain pane, not an agent** (U-HDR-1): `herdr agent list`
  shows only `p6t7lens` in w11; `w11:p2` has no agent registration.
- **Focus preserved** (FR-13): the focused workspace stayed `wN` before,
  during, and after the run (`--no-focus` + topology never focuses).
- **Daily workspaces untouched**: enumeration before = `{w1,w2,w7,w8,w9,wB,
  wC,wD,wG,wJ,wM,wN,wP}` (13) and after teardown = the identical 13; `w11`
  created and closed. `herdr workspace close w11` → ok; the viewer process
  exited with the workspace (one remaining `viewer/cli.ts` process on the
  host is PID 85088, started 2026-11-24 — stale from the prior day's run,
  from the *main* profile's installed copy; unrelated to this run).

### Root resolution (F-16) — the claim under test

`resolveViewerCommand()` (`src/extension/resolve.ts:12`) builds
`bun <resolve(import.meta.dirname, "../viewer/cli.ts")>` — rooted at the
*installed package*, never `process.cwd()`. Live proof, session cwd
`/private/tmp/p6t7-scratch`:

```
ps → bun /Users/fabzter/src/omp-fabz-improvements/src/viewer/cli.ts   (PID 63739)
```

The launch succeeded in a workspace whose cwd has no `src/viewer/cli.ts` —
impossible if the path were cwd-relative. (The resolved path is the repo
because `plugin link` installs a symlink; an `omp install` npm copy would
resolve under `…/plugins/node_modules/herdr-omp-lens/` — same invariant.)

Unit proofs pinning the same invariant, all green in the 460-test gate:

- `tests/extension/resolve.test.ts` — "returns a runnable `bun <abs path to
  src/viewer/cli.ts>`" and "is independent of process.cwd()" (chdirs to
  tmpdir, asserts identical output).
- `tests/extension/topology-herdr.test.ts` — "the production viewer command
  word is a runnable `bun <cli.ts>` invocation" (real
  `resolveViewerCommand()` through the `runInPane` launch path).
- `tests/viewer/cli.test.ts` — "resolveViewerCommand resolves to the real
  cli.ts behind a runnable `bun` word" (F-16).

## 4. Missing-channel degradation — notice + fallback, never a throw

Feature-detection lives at `src/extension/observe/index.ts:83-121`:
`const bus = pi.events; bus?.on(…)` — an absent bus subscribes nothing,
`pi.on("before_subagent_spawn", …)` still attaches, and after the bridge
starts exactly one `notice{level:"warn"}` is broadcast:
`"degraded: pi.events task:subagent:* bus unavailable — live worker
observation disabled"`. Deterministic unit proofs (green in the gate; the
evidence line printed during `bun test`):

- `tests/extension/observe-wiring.test.ts` — "absent pi.events degrades: one
  warn notice is broadcast after bridge start" (no throw; spawn hook still
  subscribes).
- `tests/guards/fail-soft.test.ts` — "P6-R7 bus-absent degraded discovery
  (D1): no pi.events → bus-unavailable notice; workers still discovered via
  artifact scan" — end-to-end through the real extension entry and real
  bridge: one warn notice, D1 fallback keeps discovery working.
- `tests/extension/history/wiring.test.ts` — "degraded discovery (D1): no
  pi.events — scan still rides hello.history, no fabricated counters".
- `tests/extension/topology.test.ts` — "adapter failure degrades + notice,
  spawn signals still flow (P4-R11)" — a missing/absent Herdr command is
  indistinguishable from a failed one at the adapter boundary; `failOn:
  ["createOverviewTab"]` → `degraded` + `notice{level:"error"}`, no throw,
  signals still processed.
- `tests/guards/fail-soft.test.ts` — "circuit-break: adapter over a stalled
  socket degrades the topology with one notice" — real socketTransport over
  a stalled Herdr socket, per-call timeouts → one notice.

Viewer-side surface: `tests/viewer/client.test.ts` "warn notice surfaces the
degraded banner state (D1)"; `tests/viewer/render.test.ts` "degraded and
offline states are surfaced (FR-12, D1)".

## 5. Commands reproduced — live-run recipe

```bash
# 0. isolate (install-time quirk: strip HERDR_*)
env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
    -u HERDR_SOCKET_PATH -u HERDR_BIN_PATH \
    omp --profile=p6t7-clean plugin link <repo>

# 1. enumerate baseline (expect the 13 daily workspaces)
herdr workspace list

# 2. disposable workspace in a NON-repo cwd
herdr workspace create --cwd /tmp/<scratch> --label <label> --no-focus

# 3. start omp on the clean profile (setup wizard: esc to skip)
herdr agent start <name> --kind omp --pane <pane> --timeout 90000 -- \
    --profile p6t7-clean --config <overlay.yml>

# 4. delegate; then assert:
herdr tab list --workspace <wId>    # "OMP subagents" tab appears
herdr pane read <viewerPane>        # "[connected]" header
herdr agent list                    # viewer pane NOT registered as agent
ps -eo command | grep viewer/cli.ts # argv rooted at installed package

# 5. teardown
herdr agent prompt <name> "/exit"; herdr workspace close <wId>
herdr workspace list                # identical baseline
rm -rf /tmp/<scratch>               # disposable cwd
```

## 6. Gates

`bun test`: **460 pass / 0 fail** (35 files). `bun run typecheck` (`tsc
--noEmit`): clean. `bun run lint` (`biome check src tests`): 66 files, clean.
