#!/usr/bin/env bash
# Restart OpenClaw gateway + TLS proxies for stimm-voice dev.
# Usage: bash scripts/restart-stimm.sh

set -e

cd "$(dirname "$0")/.."

echo "→ Stopping gateway and proxies..."
pkill -f openclaw-gateway 2>/dev/null || true
pkill -f "local-ssl-proxy.*18790" 2>/dev/null || true
pkill -f "local-ssl-proxy.*7443" 2>/dev/null || true
sleep 2

echo "→ Starting TLS proxies..."
nohup local-ssl-proxy --source 18790 --target 18789 > /tmp/ssl-proxy-gateway.log 2>&1 &
nohup local-ssl-proxy --source 7443   --target 7880  > /tmp/ssl-proxy-livekit.log  2>&1 &
sleep 1

echo "→ Starting gateway..."
nohup pnpm openclaw gateway run --bind lan --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &

sleep 5
ss -tlnp | grep -E "18789|18790|7443" && echo "✓ All services up"
grep -a "listening" /tmp/openclaw-gateway.log | tail -1
