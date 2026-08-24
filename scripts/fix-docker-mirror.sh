#!/bin/sh
# Настройка зеркал Docker Hub.
#
# Зачем: Docker Hub блокирует доступ с российских IP (ошибка вида
#   "failed to load metadata for docker.io/library/node:20-alpine"
#   или "403 Forbidden"), поэтому сборка не может скачать базовый образ.
# Решение: скачивать образы через зеркала.
#
#   cd /root/server && sh scripts/fix-docker-mirror.sh
set -e

CONF=/etc/docker/daemon.json
MIRRORS='["https://mirror.gcr.io","https://dh-mirror.gitverse.ru","https://dockerhub1.beget.com"]'

echo "=== Настройка зеркал Docker Hub ==="

if [ "$(id -u)" != "0" ]; then
  echo "Нужны права root. Запусти от root или через sudo." >&2
  exit 1
fi

mkdir -p /etc/docker

if ! command -v jq >/dev/null 2>&1; then
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y jq >/dev/null 2>&1 || true
fi

if [ -s "$CONF" ]; then
  cp "$CONF" "${CONF}.bak"
  echo "→ Текущий конфиг сохранён: ${CONF}.bak"
  if command -v jq >/dev/null 2>&1 && jq empty "$CONF" >/dev/null 2>&1; then
    # Сохраняем остальные настройки, меняем только registry-mirrors.
    jq --argjson m "$MIRRORS" '. + {"registry-mirrors": $m}' "$CONF" > "${CONF}.tmp" \
      && mv "${CONF}.tmp" "$CONF"
  else
    printf '{\n  "registry-mirrors": %s\n}\n' "$MIRRORS" > "$CONF"
  fi
else
  printf '{\n  "registry-mirrors": %s\n}\n' "$MIRRORS" > "$CONF"
fi

# Проверяем, что получился валидный JSON — иначе Docker не стартует.
if command -v jq >/dev/null 2>&1 && ! jq empty "$CONF" >/dev/null 2>&1; then
  echo "✗ Получился некорректный JSON, откатываю." >&2
  [ -f "${CONF}.bak" ] && mv "${CONF}.bak" "$CONF"
  exit 1
fi

echo "→ Конфиг:"
cat "$CONF"

echo ""
echo "→ Перезапускаю Docker…"
systemctl restart docker
sleep 4

echo ""
echo "→ Проверяю зеркала (тяну node:20-alpine)…"
if docker pull node:20-alpine >/dev/null 2>&1; then
  echo "  ✓ Образ скачался — зеркала работают."
  echo ""
  echo "Дальше: cd /root/server && sh scripts/quick-setup.sh"
else
  echo "  ✗ Скачать не удалось."
  echo ""
  echo "  Что можно сделать:"
  echo "   1) Проверить интернет и DNS на сервере:"
  echo "        ping -c2 8.8.8.8 && nslookup mirror.gcr.io"
  echo "   2) Попробовать другое зеркало — открой $CONF,"
  echo "      оставь одно рабочее в registry-mirrors и выполни:"
  echo "        systemctl restart docker && docker pull node:20-alpine"
  echo "   3) Посмотреть точную ошибку:"
  echo "        docker pull node:20-alpine"
  exit 1
fi
