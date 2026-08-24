#!/bin/sh
set -e

# Единственный путь к БД в проде — не менять после заливки треков.
CANONICAL_DB="/app/data/bpmz.db"
CANONICAL_URL="file:./data/bpmz.db"
LEGACY_DB="/app/data/groov.db"
BACKUP_DIR="/app/data/backups"

mkdir -p /app/data/tracks /app/data/covers /app/data/tmp /app/data/backups

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
case "${DATABASE_URL:-}" in
  file:./data/bpmz.db|file:data/bpmz.db|"")
    export DATABASE_URL="$CANONICAL_URL"
    ;;
  *)
    echo "[entrypoint] WARNING: DATABASE_URL=${DATABASE_URL}"
    echo "[entrypoint] Ожидается: ${CANONICAL_URL}"
    if [ "${NODE_ENV:-}" = "production" ]; then
      echo "[entrypoint] В production должен быть file:./data/bpmz.db в .env"
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
