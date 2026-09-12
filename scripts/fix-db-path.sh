#!/bin/sh
# Починка расположения базы: перенести SQLite на смонтированный том,
# закрепить абсолютный DATABASE_URL и перезапустить сервер.
#
#   cd /root/server && sh scripts/fix-db-path.sh
#
# Prisma резолвит относительный file:-путь от папки со схемой (/app/prisma),
# а не от рабочей папки процесса. Поэтому DATABASE_URL=file:./data/bpmz.db
# создавал базу в /app/prisma/data — в слое контейнера, мимо тома, и она
# пропадала при каждой пересборке. Файлы треков не страдали: их пути Node
# считает от рабочей папки, они всегда лежали в /app/data/tracks на томе.
#
# Скрипт безопасен для повторного запуска: существующую базу он не затирает
# ничем меньшего размера, а перед заменой кладёт копию в data/backups.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CANONICAL="$ROOT/data/bpmz.db"
CANONICAL_URL='file:/app/data/bpmz.db'
CONTAINER=bpmz-api
BACKUP_DIR="$ROOT/data/backups"
STAMP=$(date -u +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR" data/tracks data/covers data/tmp

size_of() {
  if [ -f "$1" ]; then wc -c < "$1" | tr -d ' '; else echo 0; fi
}

echo "=== 1/5. Что сейчас на диске ==="
echo "  data/bpmz.db на томе:      $(size_of "$CANONICAL") байт"
echo "  аудиофайлов в data/tracks: $(find data/tracks -type f 2>/dev/null | wc -l | tr -d ' ')"

echo ""
echo "=== 2/5. Останавливаю API ==="
# Останавливаем до копирования: у работающего SQLite снимок вышел бы битым.
docker compose stop api >/dev/null 2>&1 || echo "  (контейнер не запущен)"
echo "  готово"

echo ""
echo "=== 3/5. Ищу базу, уехавшую мимо тома ==="
RESCUED=""

if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  for name in bpmz.db groov.db; do
    TMP="$ROOT/data/.rescue-$name"
    rm -f "$TMP" "$TMP-wal"
    if docker cp "$CONTAINER:/app/prisma/data/$name" "$TMP" >/dev/null 2>&1 && [ -s "$TMP" ]; then
      docker cp "$CONTAINER:/app/prisma/data/$name-wal" "$TMP-wal" >/dev/null 2>&1 || true
      echo "  в контейнере: /app/prisma/data/$name — $(size_of "$TMP") байт"
      if [ "$(size_of "$TMP")" -gt "$(size_of "$RESCUED")" ]; then
        RESCUED="$TMP"
      fi
    else
      rm -f "$TMP"
    fi
  done
else
  echo "  контейнер $CONTAINER не создан — пропускаю"
fi

for cand in "$ROOT/prisma/data/bpmz.db" "$ROOT/prisma/data/groov.db" "$ROOT/data/groov.db"; do
  if [ -s "$cand" ]; then
    echo "  на диске: $cand — $(size_of "$cand") байт"
    if [ "$(size_of "$cand")" -gt "$(size_of "$RESCUED")" ]; then
      RESCUED="$cand"
    fi
  fi
done

[ -n "$RESCUED" ] || echo "  ничего не найдено"

echo ""
echo "=== 4/5. Ставлю базу на канонический путь ==="
if [ -n "$RESCUED" ] && [ "$(size_of "$RESCUED")" -gt "$(size_of "$CANONICAL")" ]; then
  if [ -s "$CANONICAL" ]; then
    cp "$CANONICAL" "$BACKUP_DIR/bpmz-before-fix-$STAMP.db"
    echo "  прежняя база сохранена: data/backups/bpmz-before-fix-$STAMP.db"
  fi
  cp "$RESCUED" "$CANONICAL"
  if [ -s "$RESCUED-wal" ]; then cp "$RESCUED-wal" "$CANONICAL-wal"; fi
  cp "$CANONICAL" "$BACKUP_DIR/bpmz-latest.db"
  echo "  перенесено → data/bpmz.db ($(size_of "$CANONICAL") байт)"
elif [ -s "$CANONICAL" ]; then
  echo "  база на томе уже на месте и не меньше найденных — оставляю как есть"
else
  echo "  переносить нечего, база не найдена"
  echo "  дальше: раздел «Пропали треки» в README, шаг 4 (поиск по всей машине)"
fi
rm -f "$ROOT"/data/.rescue-*

echo ""
echo "=== 5/5. Абсолютный DATABASE_URL и пересборка ==="
if [ -f .env ]; then
  cp .env "$BACKUP_DIR/env-$STAMP.bak"
  # Любой путь к bpmz.db приводим к абсолютному: относительный Prisma уведёт
  # обратно в /app/prisma/data. Строки с другой СУБД не трогаем.
  # Через временный файл, а не sed -i: у BSD sed этот флаг требует аргумент.
  TMP_ENV="$BACKUP_DIR/.env-$STAMP.tmp"
  if sed -E 's@^DATABASE_URL=.*(bpmz|groov)\.db"?[[:space:]]*$@DATABASE_URL="'"$CANONICAL_URL"'"@' .env > "$TMP_ENV"; then
    cat "$TMP_ENV" > .env   # перезапись содержимого сохраняет права и inode
  fi
  rm -f "$TMP_ENV"
  grep -q '^DATABASE_URL=' .env || echo "DATABASE_URL=\"$CANONICAL_URL\"" >> .env
  grep '^DATABASE_URL=' .env | sed 's/^/  /'
else
  echo "  нет .env — сначала sh scripts/quick-setup.sh"
  exit 1
fi

echo ""
docker compose up -d --build

sleep 5
echo ""
echo "=== Лог запуска ==="
docker compose logs --tail 40 api 2>/dev/null | grep '\[entrypoint\]' || true

echo ""
echo "=== Что в базе ==="
docker exec "$CONTAINER" node -e 'const {PrismaClient}=require("@prisma/client");const p=new PrismaClient();Promise.all([p.track.count(),p.album.count(),p.artist.count(),p.user.count()]).then(([t,a,r,u])=>console.log("  треки:",t," альбомы:",a," артисты:",r," пользователи:",u)).finally(()=>p.$disconnect())' 2>/dev/null \
  || echo "  API ещё поднимается — проверь через минуту: sh scripts/vps-status.sh"
echo ""
