#!/bin/sh
# Run on VPS (outside Docker). Keeps DB + uploads; safe to cron daily.
set -e
ROOT="${1:-/root/server}"
DEST="${ROOT}/data/backups"
STAMP=$(date -u +%Y%m%d-%H%M%S)
ARCHIVE="${DEST}/bpmz-data-${STAMP}.tar.gz"

mkdir -p "$DEST"
cd "$ROOT"

if [ ! -f data/bpmz.db ] || [ ! -s data/bpmz.db ]; then
  echo "[backup] skip — no data/bpmz.db"
  exit 0
fi

tar czf "$ARCHIVE" data/bpmz.db data/tracks data/covers 2>/dev/null \
  || tar czf "$ARCHIVE" data/bpmz.db

echo "[backup] $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
ls -1t "$DEST"/bpmz-data-*.tar.gz 2>/dev/null | tail -n +8 | while read -r f; do rm -f "$f"; done
