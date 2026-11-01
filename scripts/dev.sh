#!/usr/bin/env bash
# Starts everything LockedIn needs locally, with the full AI: Ollama, then the API on http://localhost:8000.
# Usage: ./scripts/dev.sh   (Ctrl+C stops the API; Ollama keeps running in the background)
set -euo pipefail
cd "$(dirname "$0")/../backend"

if ! curl -s -m 2 http://localhost:11434/api/version > /dev/null; then
  echo "Starting Ollama…"
  ollama serve > /tmp/ollama.log 2>&1 &
  until curl -s -m 2 http://localhost:11434/api/version > /dev/null; do sleep 1; done
fi

MODEL="${LOCKEDIN_OLLAMA_MODEL:-llama3.2:3b}"
ollama list | grep -q "^${MODEL}" || ollama pull "$MODEL"

if lsof -nP -iTCP:8000 -sTCP:LISTEN > /dev/null; then
  echo "Port 8000 is already in use. Stop the other server first:"
  lsof -nP -iTCP:8000 -sTCP:LISTEN
  exit 1
fi

uv run alembic upgrade head
echo "API on http://localhost:8000 (docs at /docs). Point the extension's AI backend there."
exec uv run uvicorn app.main:app --reload --port 8000
