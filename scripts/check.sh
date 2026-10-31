#!/usr/bin/env bash
# Fast hermetic check: typecheck + unit tests (no claude, no network).
set -euo pipefail
cd "$(dirname "$0")/.."
bun run check
