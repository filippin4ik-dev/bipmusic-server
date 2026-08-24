#!/bin/sh
# Диагностика: почему API не отвечает.
#   cd /root/server && sh scripts/vps-diagnose.sh
set -e
cd /root/server

DOMAIN="bipmusic.ru"

echo "==================== ДИАГНОСТИКА bipMusic ===================="
echo ""

# --- 1. Контейнеры ---------------------------------------------------------
echo "1) Контейнеры:"
docker compose ps 2>/dev/null || echo "   docker compose недоступен"
echo ""

# --- 2. API изнутри --------------------------------------------------------
echo "2) API внутри контейнера (порт 3000 наружу НЕ опубликован — это норма):"
printf '   '
docker exec bpmz-api node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(t=>console.log('OK',t)).catch(e=>console.log('НЕ ОТВЕЧАЕТ:',e.message))" 2>/dev/null \
  || echo "контейнер bpmz-api не запущен"
echo ""

# --- 3. DNS ----------------------------------------------------------------
echo "3) DNS:"
SERVER_IP=$(curl -s --max-time 10 https://api.ipify.org 2>/dev/null || echo "?")
DOMAIN_IP=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1)
[ -z "$DOMAIN_IP" ] && DOMAIN_IP="не определён"
echo "   IP этого сервера : $SERVER_IP"
echo "   $DOMAIN → $DOMAIN_IP"
if [ "$SERVER_IP" = "$DOMAIN_IP" ]; then
  echo "   ✓ домен указывает сюда"
else
  echo "   ✗ ДОМЕН УКАЗЫВАЕТ НЕ НА ЭТОТ СЕРВЕР — это и есть причина ошибок TLS/404."
  echo "     Исправь A-запись $DOMAIN → $SERVER_IP в панели регистратора."
fi
echo ""

# --- 4. Порты --------------------------------------------------------------
echo "4) Кто занимает порты 80/443:"
(ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null) | grep -E ':80 |:443 ' || echo "   никто не слушает — Caddy не запущен?"
echo ""

# --- 5. Кто реально отвечает по домену -------------------------------------
echo "5) Ответ по https://$DOMAIN :"
SRV=$(curl -sS -o /dev/null -D - --max-time 15 "https://$DOMAIN/health" 2>&1 | grep -i '^server:' || echo "server: ?")
echo "   $SRV"
echo "   (если здесь не 'Caddy' — трафик уходит на чужой сервер, см. пункт 3)"
echo ""

# --- 6. Логи ---------------------------------------------------------------
echo "6) Последние ошибки API:"
docker logs bpmz-api 2>&1 | tail -15 || echo "   логов нет"
echo ""
echo "7) Последние строки Caddy (выпуск сертификата):"
docker logs bpmz-caddy 2>&1 | tail -10 || echo "   логов нет"
echo ""
echo "=============================================================="
