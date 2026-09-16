#!/bin/sh
set -e

# Единственный путь к БД в проде — не менять после заливки треков.
# Путь абсолютный намеренно: относительный file:-путь Prisma резолвит от папки
# со схемой (/app/prisma), а не от рабочей папки процесса, поэтому
# file:./data/bpmz.db создавал базу в /app/prisma/data — внутри контейнера,
# мимо смонтированного тома, и она пропадала при каждой пересборке.
CANONICAL_DB="/app/data/bpmz.db"
CANONICAL_URL="file:/app/data/bpmz.db"
LEGACY_DB="/app/data/groov.db"
MISPLACED_DIR="/app/prisma/data"
BACKUP_DIR="/app/data/backups"

mkdir -p /app/data/tracks /app/data/covers /app/data/tmp /app/data/backups /app/data/app

# Старый .env держал access-токен 24 часа — приложение выкидывало из аккаунта.
if [ "${JWT_EXPIRY:-}" = "24h" ]; then
  export JWT_EXPIRY=30d
  echo "[entrypoint] JWT_EXPIRY 24h → 30d"
fi
if [ "${JWT_REFRESH_EXPIRY:-}" = "30d" ] || [ -z "${JWT_REFRESH_EXPIRY:-}" ]; then
  export JWT_REFRESH_EXPIRY=180d
  echo "[entrypoint] JWT_REFRESH_EXPIRY → 180d"
fi

# --- volume: данные должны жить на диске VPS, не в слое контейнера ---
DATA_MOUNTED=0
if grep -q ' /app/data ' /proc/mounts 2>/dev/null; then
  DATA_MOUNTED=1
  echo "[entrypoint] Volume OK: /app/data смонтирован с хоста"
else
  echo "[entrypoint] ERROR: /app/data НЕ смонтирован — треки и БД пропадут при пересборке!"
  if [ "${NODE_ENV:-}" = "production" ]; then
    echo "[entrypoint] Отказ запуска (production без volume)."
    exit 1
  fi
fi

# --- DATABASE_URL: всегда один файл ---
# Старые относительные значения из уже развёрнутых .env принимаются и
# переписываются на абсолютный путь — иначе Prisma снова уйдёт в /app/prisma/data.
case "${DATABASE_URL:-}" in
  file:/app/data/bpmz.db)
    ;;
  file:./data/bpmz.db|file:data/bpmz.db|"")
    export DATABASE_URL="$CANONICAL_URL"
    ;;
  *)
    echo "[entrypoint] WARNING: DATABASE_URL=${DATABASE_URL}"
    echo "[entrypoint] Ожидается: ${CANONICAL_URL}"
    if [ "${NODE_ENV:-}" = "production" ]; then
      echo "[entrypoint] В production должен быть file:/app/data/bpmz.db в .env"
      exit 1
    fi
    ;;
esac

DB_FILE="$CANONICAL_DB"
echo "[entrypoint] DATABASE_URL=${DATABASE_URL}"
echo "[entrypoint] DB file: ${DB_FILE}"

db_nonempty() {
  [ -f "$1" ] && [ -s "$1" ]
}

# База из /app/prisma/data → на том (один раз).
# Туда её уводил относительный file:-путь; папка лежит в слое контейнера, так что
# успеть перенести можно только до пересборки — при ней слой удаляется вместе с базой.
for misplaced in "$MISPLACED_DIR/bpmz.db" "$MISPLACED_DIR/groov.db"; do
  if ! db_nonempty "$DB_FILE" && db_nonempty "$misplaced"; then
    echo "[entrypoint] База найдена в ${misplaced} → переносим на том"
    cp "$misplaced" "$DB_FILE"
    cp "$misplaced-wal" "$DB_FILE-wal" 2>/dev/null || true
    cp "$misplaced-shm" "$DB_FILE-shm" 2>/dev/null || true
  fi
done

# Старый groov.db → bpmz.db (один раз)
if ! db_nonempty "$DB_FILE" && db_nonempty "$LEGACY_DB"; then
  echo "[entrypoint] Копируем legacy groov.db → bpmz.db"
  cp "$LEGACY_DB" "$DB_FILE"
fi

restore_database() {
  if db_nonempty "$DB_FILE"; then
    return 0
  fi

  echo "[entrypoint] База пуста — пробуем восстановить из backup…"

  if db_nonempty "$BACKUP_DIR/bpmz-latest.db"; then
    echo "[entrypoint] Restore: bpmz-latest.db"
    cp "$BACKUP_DIR/bpmz-latest.db" "$DB_FILE"
    return 0
  fi

  NEWEST_DB=$(ls -1t "$BACKUP_DIR"/bpmz-2*.db 2>/dev/null | head -1)
  if [ -n "$NEWEST_DB" ] && db_nonempty "$NEWEST_DB"; then
    echo "[entrypoint] Restore: $(basename "$NEWEST_DB")"
    cp "$NEWEST_DB" "$DB_FILE"
    return 0
  fi

  NEWEST_TAR=$(ls -1t "$BACKUP_DIR"/bpmz-data-*.tar.gz 2>/dev/null | head -1)
  if [ -n "$NEWEST_TAR" ]; then
    echo "[entrypoint] Restore from: $(basename "$NEWEST_TAR")"
    tar xzf "$NEWEST_TAR" -C /app data/bpmz.db 2>/dev/null || true
    if db_nonempty "$DB_FILE"; then
      return 0
    fi
  fi

  return 1
}

restore_database || true

if db_nonempty "$DB_FILE"; then
  DB_BYTES=$(wc -c < "$DB_FILE" | tr -d ' ')
  echo "[entrypoint] Database OK (${DB_BYTES} bytes) → $(basename "$DB_FILE")"
  STAMP=$(date -u +%Y%m%d-%H%M%S)
  cp "$DB_FILE" "$BACKUP_DIR/bpmz-${STAMP}.db"
  cp "$DB_FILE" "$BACKUP_DIR/bpmz-latest.db"
  ls -1t "$BACKUP_DIR"/bpmz-2*.db 2>/dev/null | tail -n +8 | while read -r f; do rm -f "$f"; done
else
  echo "[entrypoint] Базы нет — создастся при db push; admin из seed"
fi

TRACK_FILES=$(find /app/data/tracks -type f 2>/dev/null | wc -l | tr -d ' ')
if [ "$TRACK_FILES" -gt 0 ] && ! db_nonempty "$DB_FILE"; then
  echo "[entrypoint] WARNING: ${TRACK_FILES} аудиофайлов на диске, но БД пустая!"
  echo "[entrypoint] Восстанови: sh scripts/restore-data.sh или backup из data/backups/"
fi

echo "[entrypoint] prisma db push…"
node ./node_modules/prisma/build/index.js db push --skip-generate
echo "[entrypoint] db push OK"
node dist/seed.js || true
export SKIP_BOOT_MIGRATIONS=1
echo "[entrypoint] starting API…"
exec node --enable-source-maps dist/server.js
