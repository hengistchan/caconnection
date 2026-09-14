#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd "$(dirname "$0")/../.." && pwd)"
PYTHONPATH="$ROOT"
export PYTHONPATH

exec python3 -m server.cutover_acceptance "$@"
