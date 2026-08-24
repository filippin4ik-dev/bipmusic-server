#!/bin/sh
# Привязка сервера к приватному репозиторию GitHub через deploy key.
#
# Запускать НА VPS. Скрипт можно выполнить и до клонирования репозитория —
# скачай его отдельно или скопируй команды из README.
#
#   sh scripts/vps-git-setup.sh
set -e

REPO_SSH="git@github.com:filippin4ik-dev/bipmusic-server.git"
TARGET="/root/server"
KEY="$HOME/.ssh/id_ed25519_bipmusic"

echo "=== Настройка доступа к GitHub ==="

# --- git ---
if ! command -v git >/dev/null 2>&1; then
  echo "→ Ставлю git…"
  apt-get update -qq && apt-get install -y git >/dev/null 2>&1
fi

# --- ключ ---
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"

if [ ! -f "$KEY" ]; then
  ssh-keygen -t ed25519 -C "bipmusic-vps" -f "$KEY" -N "" >/dev/null
  echo "→ Создан новый ключ"
else
  echo "→ Ключ уже существует, использую его"
fi

# Всегда использовать этот ключ для github.com
if ! grep -q "IdentityFile $KEY" "$HOME/.ssh/config" 2>/dev/null; then
  cat >> "$HOME/.ssh/config" <<EOF

Host github.com
    HostName github.com
    User git
    IdentityFile $KEY
    IdentitiesOnly yes
EOF
  chmod 600 "$HOME/.ssh/config"
fi

# Доверенный ключ хоста github.com
ssh-keygen -F github.com >/dev/null 2>&1 || \
  ssh-keyscan -t ed25519 github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null

echo ""
echo "==================== DEPLOY KEY ===================="
cat "${KEY}.pub"
echo "===================================================="
echo ""
echo "Скопируй строку выше и добавь её на GitHub:"
echo "  https://github.com/filippin4ik-dev/bipmusic-server/settings/keys"
echo "  → Add deploy key → вставь ключ → Add key"
echo "  Галочку «Allow write access» НЕ ставь (серверу нужно только чтение)."
echo ""
printf "Добавил ключ на GitHub? Нажми Enter для продолжения… "
read -r _

echo ""
echo "→ Проверяю доступ к GitHub…"
if ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -T git@github.com 2>&1 | grep -q "successfully authenticated"; then
  echo "  ✓ Доступ есть"
else
  echo "  ✗ GitHub не принял ключ. Проверь, что deploy key добавлен, и запусти скрипт снова." >&2
  exit 1
fi

# --- репозиторий ---
mkdir -p "$TARGET"
cd "$TARGET"

if [ -d .git ]; then
  echo "→ Репозиторий уже подключён, обновляю…"
  git remote set-url origin "$REPO_SSH"
  git fetch origin
  git reset --hard origin/main
else
  echo "→ Подключаю репозиторий к $TARGET (файлы data/ и .env сохранятся)…"
  git init -q -b main
  git remote add origin "$REPO_SSH"
  git fetch origin
  git reset --hard origin/main
fi

chmod +x scripts/*.sh docker-entrypoint.sh 2>/dev/null || true

echo ""
echo "✓ Код из GitHub развёрнут в $TARGET"
echo ""
echo "Дальше:"
echo "  cd /root/server && sh scripts/quick-setup.sh     # первый запуск"
echo "  cd /root/server && sh scripts/vps-git-update.sh  # обновления"
