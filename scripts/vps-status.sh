#!/bin/sh
# Данные и БД на VPS — проверка перед/после деплоя (запускать в Termius).
set -e
ROOT="${1:-/root/server}"
cd "$ROOT"

echo "=== Папка data на диске VPS (не в контейнере) ==="
ls -lah data/ 2>/dev/null || { echo "Нет папки $ROOT/data"; exit 1; }

echo ""
echo "=== База данных ==="
for f in data/bpmz.db data/groov.db; do
  if [ -f "$f" ]; then
    echo "  $f — $(wc -c < "$f" | tr -d ' ') bytes"
  else
    echo "  $f — нет"
  fi
done

echo ""
echo "=== .env DATABASE_URL ==="
grep '^DATABASE_URL=' .env 2>/dev/null || echo "  (нет .env или DATABASE_URL)"

# Относительный file:-путь Prisma резолвит от папки со схемой, поэтому база могла
# уехать в /app/prisma/data — в слой контейнера, где пропадёт при пересборке.
echo ""
echo "=== База внутри контейнера, мимо тома (/app/prisma/data) ==="
if docker exec bpmz-api sh -c 'ls -l /app/prisma/data/*.db' 2>/dev/null; then
  echo "  ВНИМАНИЕ: база лежит в слое контейнера — перенеси её ДО пересборки:"
  echo "  docker compose stop api && docker cp bpmz-api:/app/prisma/data/bpmz.db $ROOT/data/bpmz.db && docker compose start api"
else
  echo "  чисто (или контейнер не запущен)"
fi

echo ""
echo "=== Docker ==="
docker compose ps 2>/dev/null || docker ps --filter name=bpmz

echo ""
echo "=== Последние строки entrypoint API ==="
docker logs bpmz-api 2>&1 | grep '\[entrypoint\]' | tail -8 || true
