#!/bin/sh
# Подключение сервера к репозиторию GitHub (первичная настройка).
#
# Запускать НА VPS:
#   sh scripts/vps-git-setup.sh
#
# Для ПУБЛИЧНОГО репозитория ничего дополнительно настраивать не нужно.
# Если репозиторий приватный — см. раздел про deploy key в README.
set -e

REPO_URL="https://github.com/filippin4ik-dev/bipmusic-server.git"
TARGET="/root/server"

echo "=== Подключение $TARGET к GitHub ==="

if ! command -v git >/dev/null 2>&1; then
  echo "→ Ставлю git…"
  apt-get update -qq && apt-get install -y git >/dev/null 2>&1
fi

mkdir -p "$TARGET"
cd "$TARGET"

if [ -d .git ]; then
  echo "→ Репозиторий уже подключён, обновляю…"
  git remote set-url origin "$REPO_URL"
else
  # git init вместо git clone: папка может быть непустой (data/, .env),
  # и эти файлы должны сохраниться — они в .gitignore.
  echo "→ Подключаю репозиторий (data/ и .env сохранятся)…"
  git init -q -b main
  git remote add origin "$REPO_URL"
fi

git fetch origin
git reset --hard origin/main

chmod +x scripts/*.sh docker-entrypoint.sh 2>/dev/null || true

echo ""
echo "✓ Код развёрнут в $TARGET ($(git rev-parse --short HEAD))"
echo ""
echo "Дальше:"
echo "  cd /root/server && sh scripts/quick-setup.sh     # первый запуск"
echo "  cd /root/server && sh scripts/vps-git-update.sh  # обновления"
