#!/bin/sh
# Done-when of phase 2: `docker compose restart sync` loses no text, even text typed less than a
# batch (~1 s) before it. Run from the project root with the stack up.
set -eu
url=${SYNC_URL:-ws://localhost:${HTTP_PORT:-8080}/ws/sync}
probe() { docker run --rm --network host -v "$PWD/apps/sync:/app:ro" -w /app node:26.13.1-bookworm-slim node src/probe.js "$url" "$@"; }
text="restart-check-$(date +%s)-$$"
out=$(mktemp)
trap 'rm -f "$out"' EXIT

probe write "$text" >"$out" 2>&1 &
writer=$!
until grep -q acked "$out"; do kill -0 "$writer" 2>/dev/null || { cat "$out"; exit 1; }; sleep 0.05; done
docker compose restart sync # while the writer is still connected and its batch not yet written
wait "$writer"
probe read "$text" # the provider retries until sync is back up
