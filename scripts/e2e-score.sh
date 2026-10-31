#!/usr/bin/env bash
# E2E score: number of e2e scenarios passing against real pi + real claude.
# Prints one number (0 when the suite cannot run at all, e.g. before it exists
# or when the claude/pi prerequisites are missing).
set -uo pipefail
cd "$(dirname "$0")/.."

if [ ! -d test/e2e ]; then
	echo 0
	exit 0
fi
command -v claude >/dev/null 2>&1 || { echo 0; exit 0; }
[ -x node_modules/.bin/pi ] || { echo 0; exit 0; }

out=$(PI_CLAUDE_E2E=1 bun test test/e2e 2>&1 || true)
# bun test summary line: " N pass" / " N fail". Count passes only.
echo "$out" | grep -oE '[0-9]+ pass' | head -1 | awk '{print $1+0}'
