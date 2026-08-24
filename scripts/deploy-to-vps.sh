#!/bin/sh
# Safe deploy from Mac — NEVER overwrites VPS data/
set -e
HOST="${1:-root@194.87.104.91}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"

echo "Deploy → $HOST:/root/server (data/ NOT synced)"
rsync -avz \
  --exclude node_modules \
  --exclude data \
  --exclude .env \
  --exclude .git \
  "$SRC/" "$HOST:/root/server/"

echo ""
echo "On VPS run:"
echo "  cd /root/server"
echo "  chmod +x docker-entrypoint.sh scripts/*.sh"
echo "  docker compose up -d --build"
