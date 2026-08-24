#!/bin/sh
# Первый запуск на VPS (после распаковки архива).
set -e
cd /root/server

echo "=== bpMZ: первый запуск ==="

mkdir -p data/tracks data/covers data/tmp data/backups

if [ ! -f .env ]; then
  echo "Создаю .env из шаблона — ОБЯЗАТЕЛЬНО отредактируй JWT_SECRET и INVITE_CODES!"
  cp .env.production.example .env
  echo "  nano .env"
  echo "  Секреты: openssl rand -base64 48"
  exit 1
fi

grep -q 'REPLACE_ME' .env 2>/dev/null && {
  echo "В .env остались REPLACE_ME — замени JWT_SECRET и JWT_REFRESH_SECRET"
  exit 1
}

if ! command -v docker >/dev/null 2>&1; then
  echo ""
  echo "Docker не установлен. Сначала выполни:"
  echo "  sh scripts/install-docker.sh"
  echo ""
  echo "Потом снова: sh scripts/vps-first-run.sh"
  exit 1
fi

docker compose up -d --build
sleep 3
sh scripts/vps-status.sh

echo ""
echo "API: https://bipmusic.ru/api/health"
