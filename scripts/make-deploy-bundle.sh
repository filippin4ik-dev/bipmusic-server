#!/usr/bin/env bash
# Собирает bpmz-server.zip — заливай на VPS через Termius (SFTP).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/bpmz-server.zip"

cd "$ROOT"

rm -f "$OUT"

zip -r "$OUT" . \
  -x "node_modules/*" \
  -x "node_modules/**/*" \
  -x "dist/*" \
  -x "dist/**/*" \
  -x "release/*" \
  -x "release/**/*" \
  -x "data/*" \
  -x "data/**/*" \
  -x "prisma/data/*" \
  -x "prisma/data/**/*" \
  -x ".env" \
  -x ".git/*" \
  -x ".git/**/*" \
  -x "bpmz-server.zip" \
  -x "supabase/*" \
  -x "supabase/**/*" \
  -x "*.log" \
  -x ".DS_Store" \
  > /dev/null

SIZE=$(du -h "$OUT" | cut -f1)
echo "✓ $OUT ($SIZE)"
echo ""
echo "Дальше: Termius → SFTP → /root/server/ → загрузить bpmz-server.zip"
echo "        SSH: cd /root/server && unzip -o bpmz-server.zip && sh scripts/vps-update.sh"
