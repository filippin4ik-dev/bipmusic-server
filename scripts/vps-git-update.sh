#!/bin/sh
# Обновление сервера из GitHub.
#   cd /root/server && sh scripts/vps-git-update.sh
#
# Забирает свежий код из репозитория и пересобирает контейнеры.
# .env, data/ (база, треки, обложки, бэкапы) не трогаются — они в .gitignore.
set -e
cd /root/server

echo "=== Обновление bipMusic из GitHub ==="

if [ ! -d .git ]; then
  echo "Здесь нет git-репозитория. Сначала выполни первичную настройку из README" >&2
  echo "(раздел «Деплой через GitHub»)." >&2
  exit 1
fi

echo "→ Забираю изменения…"
git fetch origin

BEFORE=$(git rev-parse --short HEAD)

# Приводим рабочую копию к состоянию origin/main.
# Локальные правки ОТСЛЕЖИВАЕМЫХ файлов будут отброшены;
# .env и data/ не затрагиваются, они игнорируются git.
git reset --hard origin/main

AFTER=$(git rev-parse --short HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  echo "→ Уже актуальная версия ($AFTER)"
else
  echo "→ Обновлено: $BEFORE → $AFTER"
  git log --oneline "$BEFORE..$AFTER" 2>/dev/null | head -10 || true
fi

chmod +x scripts/*.sh docker-entrypoint.sh 2>/dev/null || true

echo ""
echo "→ Пересборка и перезапуск…"
docker compose up -d --build

sleep 5
echo ""
sh scripts/vps-status.sh

echo ""
echo -n "Проверка API: "
curl -s --max-time 20 https://bipmusic.ru/api/health || echo "нет ответа"
echo ""
