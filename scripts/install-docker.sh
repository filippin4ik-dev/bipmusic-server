#!/bin/sh
# Установка Docker на VPS (Ubuntu/Debian). Запускать в Termius один раз:
#   sh scripts/install-docker.sh
set -e

if command -v docker >/dev/null 2>&1; then
  echo "Docker уже установлен: $(docker --version)"
  docker compose version 2>/dev/null || docker-compose --version 2>/dev/null || true
  exit 0
fi

echo "=== Установка Docker ==="

if [ -f /etc/os-release ]; then
  . /etc/os-release
else
  echo "Неизвестная ОС. Установи Docker вручную: https://docs.docker.com/engine/install/"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y ca-certificates curl gnupg

case "$ID" in
  ubuntu|debian)
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    ;;
  *)
    echo "Для $ID попробуй: apt-get install -y docker.io docker-compose-plugin"
    apt-get install -y docker.io docker-compose-plugin 2>/dev/null || apt-get install -y docker.io
    ;;
esac

systemctl enable docker
systemctl start docker

echo ""
echo "✓ $(docker --version)"
docker compose version

echo ""
echo "Дальше:"
echo "  cd /root/server && sh scripts/vps-first-run.sh"
