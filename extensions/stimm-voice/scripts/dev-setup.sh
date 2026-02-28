#!/usr/bin/env bash
set -euo pipefail
# ───────────────────────────────────────────────────────────────
# Stimm Voice — Dev Environment Setup
#
# Sets up local development:
#   1. Installs npm dependencies (including @stimm/protocol from npm)
#   2. Creates a Python venv with stimm installed in editable mode
#   3. Starts LiveKit server via Docker
#
# Prerequisites:
#   - Docker running
#   - Python 3.10+
#   - pnpm installed
#
# Usage:
#   ./extensions/stimm-voice/scripts/dev-setup.sh
#   ./extensions/stimm-voice/scripts/dev-setup.sh --no-docker
# ───────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$EXT_DIR/../.." && pwd)"

VENV_DIR="$EXT_DIR/python/.venv"
SKIP_DOCKER=false

for arg in "$@"; do
  case "$arg" in
    --no-docker) SKIP_DOCKER=true ;;
  esac
done

echo "╔══════════════════════════════════════╗"
echo "║   Stimm Voice — Dev Setup           ║"
echo "╚══════════════════════════════════════╝"
echo

# ── 1) Install npm deps ───────────────────────────────────────
echo
echo "→ Installing npm deps for @openclaw/stimm-voice..."
(cd "$REPO_DIR" && pnpm install --filter @openclaw/stimm-voice --silent)
echo "✓ npm deps installed (@stimm/protocol from npm)"

# ── 2) Python venv + editable stimm install ────────────────────
echo
echo "→ Setting up Python venv at $VENV_DIR..."
if [[ ! -d "$VENV_DIR" ]]; then
  python3 -m venv "$VENV_DIR"
fi
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

echo "→ Installing stimm in editable mode with dev extras..."
pip install -q -e "$STIMM_REPO[deepgram,openai,dev]"
echo "✓ Python venv ready ($(python --version), stimm editable)"

# ── 3) LiveKit via Docker ──────────────────────────────────────
if [[ "$SKIP_DOCKER" == "false" ]]; then
  echo
  echo "→ Starting LiveKit server..."
  docker compose -f "$EXT_DIR/docker/docker-compose.dev.yml" up -d
  echo "✓ LiveKit running at ws://localhost:7880"
else
  echo
  echo "⊘ Skipping Docker (--no-docker)"
fi

# ── Summary ────────────────────────────────────────────────────
echo
echo "┌──────────────────────────────────────────────────────────┐"
echo "│  Dev environment ready!                                  │"
echo "│                                                          │"
echo "│  LiveKit:   ws://localhost:7880  (devkey / secret)       │"
echo "│  Python:    source $VENV_DIR/bin/activate                │"
echo "│                                                          │"
echo "│  Quick start:                                            │"
echo "│    # Terminal 1 — run voice agent:                       │"
echo "│    source $VENV_DIR/bin/activate                         │"
echo "│    cd $STIMM_REPO                                        │"
echo "│    LIVEKIT_URL=ws://localhost:7880 \\                     │"
echo "│    LIVEKIT_API_KEY=devkey \\                              │"
echo "│    LIVEKIT_API_SECRET=secret \\                           │"
echo "│    python -m livekit.agents dev python/agent.py          │"
echo "│                                                          │"
echo "│    # Terminal 2 — run openclaw with stimm-voice:         │"
echo "│    pnpm dev                                              │"
echo "│                                                          │"

echo "└──────────────────────────────────────────────────────────┘"
