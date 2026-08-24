#!/bin/sh
# Optional: install host cron (in addition to docker backup sidecar).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRON_LINE="0 3 * * * ${ROOT}/scripts/backup-data.sh ${ROOT} >> ${ROOT}/data/backups/backup.log 2>&1"
mkdir -p "${ROOT}/data/backups"
(crontab -l 2>/dev/null | grep -v backup-data.sh; echo "$CRON_LINE") | crontab -
echo "Installed cron: $CRON_LINE"
