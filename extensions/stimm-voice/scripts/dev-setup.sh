#!/usr/bin/env bash
set -euo pipefail
# ───────────────────────────────────────────────────────────────
# Stimm Voice — Dev Environment Setup
#
# Sets up local development without publishing any packages:
#   1. Links @stimm/protocol (TS) from the local stimm repo
#   2. Creates a Python venv with stimm installed in editable mode
#   3. Starts LiveKit server via Docker
#
# Prerequisites:
#   - Docker running
#   - Python 3.10+
#   - pnpm installed
#   - Stimm repo cloned next to openclaw:
#       ../stimm  (or set STIMM_REPO)
#
# Usage:
#   ./extensions/stimm-voice/scripts/dev-setup.sh
#   ./extensions/stimm-voice/scripts/dev-setup.sh --no-docker
# ───────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$EXT_DIR/../.." && pwd)"

# Resolve stimm repo location
STIMM_REPO="${STIMM_REPO:-$(cd "$REPO_DIR/../stimm" 2>/dev/null && pwd || echo "")}"
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

# ── 1) Check stimm repo ────────────────────────────────────────
if [[ -z "$STIMM_REPO" || ! -d "$STIMM_REPO/packages/protocol-ts" ]]; then
  echo "✗ Stimm repo not found. Expected at: $REPO_DIR/../stimm"
  echo "  Set STIMM_REPO=/path/to/stimm and rerun."
  exit 1
fi
echo "✓ Stimm repo: $STIMM_REPO"

# ── 2) Build @stimm/protocol ──────────────────────────────────
echo
echo "→ Building @stimm/protocol..."
(cd "$STIMM_REPO/packages/protocol-ts" && npm install --silent && npm run build)
echo "✓ @stimm/protocol built"

# ── 3) Install pnpm deps (link: resolves to local stimm) ──────
echo
echo "→ Installing pnpm deps for @openclaw/stimm-voice..."
(cd "$REPO_DIR" && pnpm install --filter @openclaw/stimm-voice --silent)
echo "✓ pnpm deps installed (linked @stimm/protocol)"

# ── 4) Python venv + editable stimm install ────────────────────
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

# ── 5) LiveKit via Docker ──────────────────────────────────────
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
echo "│  Protocol:  linked from $STIMM_REPO/packages/protocol-ts│"
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
echo "│  Watch mode for protocol types:                          │"
echo "│    cd $STIMM_REPO/packages/protocol-ts && npm run dev    │"
echo "└──────────────────────────────────────────────────────────┘"
