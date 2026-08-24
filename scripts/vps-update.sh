#!/bin/sh
# Обновление после заливки нового bpmz-server.zip
set -e
cd /root/server

echo "=== bpMZ: обновление ==="

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker не установлен: sh scripts/install-docker.sh"
  exit 1
fi

# Не трогаем .env и data/ — они не в архиве
docker compose up -d --build

sleep 3
sh scripts/vps-status.sh

echo ""
echo "Готово. Проверь: curl -s https://bipmusic.ru/health"
