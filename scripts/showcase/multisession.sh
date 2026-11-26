#!/usr/bin/env bash
# Multi-session showcase: two REAL OMP agents in one disposable workspace each
# delegate a worker; the lens opens ONE TAB PER SESSION. The recording captures
# the real `herdr tab list` (two tabs) + each viewer's real pane content.
set -uo pipefail
SCRATCH=$(mktemp -d /tmp/lens-showcase-XXXXXX)
OVERLAY="$SCRATCH/overlay.yml"
printf 'task:\n  prewalk: false\n  agentPrewalk:\n    task: "off"\nprewalk:\n  enabled: false\n  auto: "off"\n' > "$OVERLAY"
cleanup(){ herdr workspace close "$WS" >/dev/null 2>&1; rm -rf "$SCRATCH"; }
trap cleanup EXIT

WS=$(herdr workspace create --label lens-showcase --cwd "$SCRATCH" | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['workspace']['workspace_id'])")
P2=$(herdr pane split "$WS:p1" --direction right --no-focus | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['pane']['pane_id'])")
P3=$(herdr pane split "$WS:p1" --direction down --no-focus | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['pane']['pane_id'])")
sleep 3
herdr agent start lensdemoa --kind omp --pane "$P2" --timeout 90000 -- --config "$OVERLAY" >/dev/null 2>&1
herdr agent start lensdemob --kind omp --pane "$P3" --timeout 90000 -- --config "$OVERLAY" >/dev/null 2>&1
# sequential --wait prompts (fire-and-forget prompts get aborted; proven recipe)
herdr agent prompt lensdemoa "Use the task tool to dispatch exactly one subagent with instruction 'Run: sleep 45. Then reply alpha.' Then reply done." --wait --timeout 150000 >/dev/null 2>&1
herdr agent prompt lensdemob "Use the task tool to dispatch exactly one subagent with instruction 'Run: sleep 45. Then reply bravo.' Then reply done." --wait --timeout 150000 >/dev/null 2>&1
for i in $(seq 1 60); do
  sleep 3
  N=$(herdr tab list --workspace "$WS" | python3 -c "import json,sys;print(len([t for t in json.load(sys.stdin)['result']['tabs'] if t.get('label','').startswith('OMP subagents')]))")
  [ "$N" -ge 2 ] && break
done
echo "overview tabs: $N"

# --- the recorded part: real herdr commands, real viewer output ---
asciinema rec --overwrite --headless --window-size 118x30 --idle-time-limit 1.2 \
  -c "WS=$WS bash "$(dirname "$0")/multisession-inner.sh"" docs/assets/multisession.cast 2>&1 | tail -1
echo "recorded multisession.cast"