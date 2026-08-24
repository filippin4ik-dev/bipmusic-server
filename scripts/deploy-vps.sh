#!/usr/bin/env bash
# Деплой на VPS БЕЗ npm и БЕЗ docker build на сервере.
# Всё собирается в Docker на твоём Mac, на VPS только загрузка готового образа.
#
# Использование:
#   ./scripts/deploy-vps.sh
#   ./scripts/deploy-vps.sh root@194.87.104.91
set -euo pipefail

VPS="${1:-root@194.87.104.91}"
REMOTE="/root/server"
IMAGE="bpmz-api:latest"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "Нужен Docker Desktop на Mac." >&2
  exit 1
fi

echo "→ 1/4 Slim-сборка образа на Mac (без node_modules в образе)…"
docker build --platform linux/amd64 -t "$IMAGE" .

echo "→ 2/4 Загрузка образа на VPS…"
docker save "$IMAGE" | gzip | ssh "$VPS" 'gunzip | docker load'

echo "→ 3/4 Конфиги на VPS (без data, .env, node_modules)…"
rsync -avz \
  --exclude node_modules \
  --exclude release \
  --exclude data \
  --exclude .env \
  --exclude .git \
  "$ROOT/" "$VPS:$REMOTE/"

echo "→ 4/4 Запуск на VPS…"
ssh "$VPS" "cd $REMOTE && docker compose up -d"

echo ""
echo "✓ Готово. На VPS npm не запускался."
