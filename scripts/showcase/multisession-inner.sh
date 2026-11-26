#!/usr/bin/env bash
# Inner (recorded): show the real two-tab result + each viewer's OWN worker row.
set -uo pipefail
echo "$ herdr tab list   # one 'OMP subagents' tab PER OMP session"
herdr tab list --workspace "$WS" | python3 -c "
import json,sys
tabs=[t for t in json.load(sys.stdin)['result']['tabs'] if t.get('label','').startswith('OMP subagents')]
for t in tabs: print('  ', t['tab_id'], ' ', t.get('label'))
"
sleep 2
for tab in $(herdr tab list --workspace "$WS" | python3 -c "
import json,sys
print(' '.join(t['tab_id'] for t in json.load(sys.stdin)['result']['tabs'] if t.get('label','').startswith('OMP subagents')))
"); do
  PANE=$(herdr pane list --workspace "$WS" | python3 -c "
import json,sys
print(next(p['pane_id'] for p in json.load(sys.stdin)['result']['panes'] if p['tab_id']=='$tab'))")
  echo ""
  echo "$ herdr pane read $PANE   # this session's OWN worker only"
  # poll until the roster shows a worker row (worker may still be spawning)
  for i in $(seq 1 20); do
    OUT=$(herdr pane read "$PANE" --source visible --lines 60 | grep -E "omp lens|workers \(|❯|✔|sleep-45|status +running|assignment" | head -6)
    [ -n "$OUT" ] && break
    sleep 2
  done
  echo "$OUT"
  sleep 2
done
echo ""
echo "# two sessions, two tabs, zero hijack — read-only, no focus theft"
sleep 2