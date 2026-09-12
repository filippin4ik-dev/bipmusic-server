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

# Docker Hub блокирует российские IP → базовый образ не скачается и сборка упадёт
# с "failed to load metadata for docker.io/...". Проверяем заранее.
echo "→ Проверяю доступ к Docker Hub…"
if docker pull node:20-alpine >/dev/null 2>&1; then
  echo "✓ Docker Hub доступен"
else
  echo "⚠️  Docker Hub недоступен (частая причина — блокировка по стране)."
  echo "   Настраиваю зеркала…"
  sh scripts/fix-docker-mirror.sh || {
    echo "" >&2
    echo "Не удалось настроить зеркала. Реши это и запусти скрипт снова." >&2
    exit 1
  }
fi

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
grep -q '^DATABASE_URL=' .env || echo 'DATABASE_URL="file:/app/data/bpmz.db"' >> .env
# Относительный путь уводил базу в /app/prisma/data (Prisma резолвит его от папки
# со схемой) — там она жила в слое контейнера и пропадала при пересборке.
sed -i -E 's|^DATABASE_URL="?file:(\./)?data/bpmz\.db"?[[:space:]]*$|DATABASE_URL="file:/app/data/bpmz.db"|' .env

# Клиенты входят по нику и сами достраивают его до <ник>@echo.local, а сервер
# ищет пользователя строго по email. Любой другой домен здесь = вход в админку
# невозможен ни из iOS, ни из десктопа.
ADMIN_NICK=$(grep '^ADMIN_NICKNAME=' .env 2>/dev/null | head -1 | cut -d= -f2-)
[ -z "$ADMIN_NICK" ] && ADMIN_NICK="admin"
WANT_EMAIL="${ADMIN_NICK}@echo.local"
HAVE_EMAIL=$(grep '^ADMIN_EMAIL=' .env 2>/dev/null | head -1 | cut -d= -f2-)
if [ "$HAVE_EMAIL" != "$WANT_EMAIL" ]; then
  if grep -q '^ADMIN_EMAIL=' .env; then
    sed -i "s|^ADMIN_EMAIL=.*|ADMIN_EMAIL=${WANT_EMAIL}|" .env
  else
    printf 'ADMIN_EMAIL=%s\n' "$WANT_EMAIL" >> .env
  fi
  echo "  → ADMIN_EMAIL приведён к ${WANT_EMAIL} (было: ${HAVE_EMAIL:-пусто})"
fi

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
# Порт 3000 намеренно НЕ опубликован наружу (в docker-compose стоит expose,
# а не ports), поэтому проверяем изнутри контейнера — снаружи он недоступен.
echo -n "внутри контейнера: "
docker exec bpmz-api node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(t=>console.log(t)).catch(e=>console.log('НЕТ ОТВЕТА:',e.message))" 2>/dev/null \
  || echo "контейнер bpmz-api не запущен — смотри 'docker compose logs api'"

echo -n "снаружи (https): "
EXT=$(curl -s --max-time 20 "https://${DOMAIN}/health" 2>/dev/null || echo "")
if echo "$EXT" | grep -q '"status"'; then
  echo "$EXT"
else
  echo "нет корректного ответа"
  echo ""
  echo "  Если внутри контейнера ответ есть, а снаружи нет — проблема НЕ в сервере."
  echo "  Почти всегда причина одна: A-запись домена ${DOMAIN} не указывает на этот VPS."
  echo "  Сейчас ${DOMAIN} → ${DOMAIN_IP}, а этот сервер → ${SERVER_IP}"
  echo "  Исправь DNS в панели регистратора и запусти скрипт снова."
fi
echo ""
echo "Готово. Приложение подключается к https://${DOMAIN}/api"
