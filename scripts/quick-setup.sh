#!/bin/sh
# Полная настройка и запуск сервера одной командой.
#   cd /root/server && sh scripts/quick-setup.sh
#
# Скрипт безопасен для повторного запуска: уже заданные секреты не перезаписываются,
# база и треки в data/ не трогаются.
set -e
cd /root/server

DOMAIN="bipmusic.ru"

echo "=== bipMusic: настройка сервера ==="
echo ""

# --- 1. Базовые утилиты и Docker -------------------------------------------
if ! command -v curl >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1; then
  echo "Ставлю curl/openssl…"
  apt-get update -qq && apt-get install -y curl openssl >/dev/null 2>&1 || true
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker не найден — устанавливаю…"
  sh scripts/install-docker.sh
fi
echo "✓ Docker: $(docker --version)"

# --- 2. Папки данных -------------------------------------------------------
mkdir -p data/tracks data/covers data/tmp data/backups
echo "✓ Папки данных готовы"

# --- 3. .env ---------------------------------------------------------------
if [ ! -f .env ]; then
  cp .env.production.example .env
  echo "✓ Создан .env из шаблона"
else
  echo "✓ .env уже существует — секреты не перезаписываю"
fi

# Подставляем значение, только если там ещё заглушка REPLACE_ME.
fill_if_placeholder() {
  key="$1"
  value="$2"
  current=$(grep "^${key}=" .env 2>/dev/null | head -1 | cut -d= -f2-)
  case "$current" in
    ''|*REPLACE_ME*)
      # Экранируем | чтобы не сломать sed
      escaped=$(printf '%s' "$value" | sed 's/[|]/\\|/g')
      if grep -q "^${key}=" .env; then
        sed -i "s|^${key}=.*|${key}=${escaped}|" .env
      else
        printf '%s=%s\n' "$key" "$value" >> .env
      fi
      echo "  → ${key} сгенерирован"
      ;;
    *)
      echo "  → ${key} уже задан, пропускаю"
      ;;
  esac
}

echo "Проверяю секреты:"
fill_if_placeholder JWT_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
fill_if_placeholder JWT_REFRESH_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
fill_if_placeholder ADMIN_PASSWORD "$(openssl rand -hex 12)"
fill_if_placeholder INVITE_CODES "invite-$(openssl rand -hex 4)"

# Домен и путь к базе — приводим к актуальным значениям.
sed -i "s|^CORS_ORIGINS=.*|CORS_ORIGINS=https://${DOMAIN}|" .env
grep -q '^DATABASE_URL=' .env || echo 'DATABASE_URL="file:./data/bpmz.db"' >> .env

# --- 4. Проверка DNS -------------------------------------------------------
echo ""
echo "=== Проверка DNS ==="
SERVER_IP=$(curl -s --max-time 10 https://api.ipify.org 2>/dev/null || echo "?")
DOMAIN_IP=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1)
[ -z "$DOMAIN_IP" ] && DOMAIN_IP="не определён"

echo "  IP этого сервера: ${SERVER_IP}"
echo "  ${DOMAIN} указывает на: ${DOMAIN_IP}"

if [ "$SERVER_IP" != "$DOMAIN_IP" ]; then
  echo ""
  echo "  ⚠️  ВНИМАНИЕ: домен не указывает на этот сервер."
  echo "     HTTPS-сертификат получить не удастся."
  echo "     Исправь A-запись ${DOMAIN} → ${SERVER_IP} в панели reg.ru,"
  echo "     подожди 10–30 минут и запусти этот скрипт снова."
  echo ""
  printf "  Продолжить всё равно? [y/N] "
  read -r answer
  case "$answer" in
    [yY]*) echo "  Продолжаю…" ;;
    *) echo "  Остановлено. Настрой DNS и повтори."; exit 1 ;;
  esac
else
  echo "  ✓ DNS настроен верно"
fi

# --- 5. Запуск -------------------------------------------------------------
echo ""
echo "=== Сборка и запуск (2–5 минут при первом запуске) ==="
docker compose up -d --build

echo ""
echo "Жду старта API…"
sleep 10

# --- 6. Итог ---------------------------------------------------------------
echo ""
echo "=================== ДАННЫЕ ДЛЯ ВХОДА ==================="
grep '^ADMIN_NICKNAME=' .env || echo "ADMIN_NICKNAME=admin"
grep '^ADMIN_EMAIL=' .env
grep '^ADMIN_PASSWORD=' .env
grep '^INVITE_CODES=' .env
echo "========================================================"
echo "Сохрани эти данные! Пароль админа больше нигде не показывается."
echo ""

echo "=== Статус ==="
docker compose ps

echo ""
echo "=== Логи запуска API ==="
docker logs bpmz-api 2>&1 | tail -20

echo ""
echo "=== Проверка API ==="
echo -n "локально:  "
curl -s --max-time 10 http://localhost:3000/health || echo "нет ответа"
echo ""
echo -n "снаружи:   "
curl -s --max-time 20 "https://${DOMAIN}/api/health" || echo "нет ответа (проверь DNS и подожди выпуск сертификата)"
echo ""
echo ""
echo "Готово. Приложение подключается к https://${DOMAIN}/api"
