#!/bin/sh
set -eu

BASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -d "$BASE/../Resources/app" ]; then DEFAULT_ROOT=$(CDPATH= cd -- "$BASE/../Resources" && pwd); else DEFAULT_ROOT=$(CDPATH= cd -- "$BASE/.." && pwd); fi
ROOT=${SCOUT_ROOT:-$DEFAULT_ROOT}
NODE="$ROOT/runtime/node"
SERVER="$ROOT/app/ui/server.mjs"
URL=http://127.0.0.1:8459/
WORKSPACE=${SCOUT_WORKSPACE:-"$HOME/Documents/Scout Workspace"}
LOGS="$WORKSPACE/logs"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"

if [ ! -x "$NODE" ]; then
  printf 'Scout could not find its bundled Node.js runtime. Reinstall Scout.\n' >&2
  exit 1
fi
if command -v curl >/dev/null 2>&1 && curl -fsS "${URL}api/app-info" >/dev/null 2>&1; then
  if [ "$(uname -s)" = Darwin ]; then open "$URL"; else xdg-open "$URL" >/dev/null 2>&1 || true; fi
  exit 0
fi

mkdir -p "$LOGS"
SCOUT_WORKSPACE="$WORKSPACE" nohup "$NODE" "$SERVER" >>"$LOGS/ui-stdout.log" 2>>"$LOGS/ui-stderr.log" &
i=0
while [ "$i" -lt 50 ]; do
  if curl -fsS "$URL" >/dev/null 2>&1; then
    if [ "$(uname -s)" = Darwin ]; then open "$URL"; else xdg-open "$URL" >/dev/null 2>&1 || true; fi
    exit 0
  fi
  i=$((i + 1)); sleep 0.3
done
printf 'Scout did not start. Diagnostic logs are in %s\n' "$LOGS" >&2
exit 1
