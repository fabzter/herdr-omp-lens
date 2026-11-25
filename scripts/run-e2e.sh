#!/usr/bin/env bash
# P6-R6 — isolated named-session E2E launcher.
#
# Rerunnable: `bash scripts/run-e2e.sh` from the repo root, inside a Herdr
# pane (HERDR_ENV=1 is required — the herdr CLI binds to the caller session).
#
# DEFAULT (safe): enumerates the daily workspace before/after and proves it
# untouched, and exercises a disposable `lens-e2e-<ts>` workspace
# create/enumerate/teardown round-trip. No agent is launched — rerunnable
# without disturbing anything.
#
# RUN_E2E_LIVE=1 additionally drives the full lifecycle in a NEW disposable
# workspace (auto-open / close-reopen / /lens split / finished-collapse /
# OMP restart with the local build / cross-workspace focus), bounded with
# retry-once timeouts; env-coupled failures are recorded as manual evidence.
# Evidence lands in /tmp/lens-e2e-scratch-*/evidence/.
#
# Env knobs: RUN_E2E_LIVE=1  E2E_SCRATCH=<dir>  E2E_KEEP_WORKSPACE=1  E2E_SKIP_RESTART=1
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${HERDR_ENV:-}" != "1" ]]; then
	echo "run-e2e: HERDR_ENV is not 1 — run inside a Herdr pane" >&2
	exit 2
fi
command -v herdr >/dev/null || { echo "run-e2e: herdr not on PATH" >&2; exit 2; }
command -v bun >/dev/null || { echo "run-e2e: bun not on PATH" >&2; exit 2; }

exec bun tests/e2e/isolated-session.e2e.ts "$@"
