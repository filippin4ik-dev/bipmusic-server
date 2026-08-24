#!/bin/sh
# Restore DB (+ optional tracks/covers) on VPS. Run from /root/server
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DEST="$ROOT/data/backups"

echo "=== Backups available ==="
ls -lh "$DEST" 2>/dev/null || { echo "No backups in $DEST"; exit 1; }

if [ -f "$DEST/bpmz-latest.db" ] && [ -s "$DEST/bpmz-latest.db" ]; then
  echo "Restoring data/bpmz.db from bpmz-latest.db"
  cp "$DEST/bpmz-latest.db" "$ROOT/data/bpmz.db"
  echo "Done. Restart: docker compose restart api"
  exit 0
fi

NEWEST=$(ls -1t "$DEST"/bpmz-2*.db 2>/dev/null | head -1)
if [ -n "$NEWEST" ] && [ -s "$NEWEST" ]; then
  echo "Restoring from $NEWEST"
  cp "$NEWEST" "$ROOT/data/bpmz.db"
  echo "Done. Restart: docker compose restart api"
  exit 0
fi

NEWEST_TAR=$(ls -1t "$DEST"/bpmz-data-*.tar.gz 2>/dev/null | head -1)
if [ -n "$NEWEST_TAR" ]; then
  echo "Restoring from $NEWEST_TAR"
  tar xzf "$NEWEST_TAR" -C "$ROOT"
  echo "Done. Restart: docker compose restart api"
  exit 0
fi

echo "No usable backup found."
exit 1
