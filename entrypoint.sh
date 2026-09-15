#!/bin/sh
# Entrypoint: seed the project workspace on first boot, then run the MCP server.
set -e

WORKSPACE="${HF_WORKSPACE:-/data/projects}"
mkdir -p "$WORKSPACE"
mkdir -p "${HF_JOBS_DIR:-/data/jobs}"

if [ -z "$(ls -A "$WORKSPACE" 2>/dev/null)" ]; then
  echo "[entrypoint] seeding sample projects into $WORKSPACE"
  cp -r /opt/hf-samples/. "$WORKSPACE"/ 2>/dev/null || true
fi

exec node /app/mcp/src/index.js
