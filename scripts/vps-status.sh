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

echo ""
echo "=== Docker ==="
docker compose ps 2>/dev/null || docker ps --filter name=bpmz

echo ""
echo "=== Последние строки entrypoint API ==="
docker logs bpmz-api 2>&1 | grep '\[entrypoint\]' | tail -8 || true
