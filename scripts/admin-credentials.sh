#!/bin/sh
# Показывает данные для входа в админку.
#
#   --fix             приводит email существующего админа к виду <ник>@echo.local:
#                     клиенты входят по нику и сами достраивают его до этого
#                     адреса, а сервер ищет пользователя строго по email, поэтому
#                     расхождение делает вход невозможным.
#   --reset-password  применяет текущий ADMIN_PASSWORD из .env к уже созданной
#                     учётке (смены пароля в API нет, а seed существующего
#                     админа пропускает).
set -e
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "Нет .env в $(pwd)"; exit 1; }

get() { grep "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2-; }

NICK=$(get ADMIN_NICKNAME)
[ -z "$NICK" ] && NICK="admin"
EMAIL=$(get ADMIN_EMAIL)
PASS=$(get ADMIN_PASSWORD)
WANT="${NICK}@echo.local"

echo "=================== ВХОД В АДМИНКУ ==================="
echo "  Ник (вводить в приложении): ${NICK}"
echo "  Пароль:                     ${PASS}"
echo "  Email в базе:               ${EMAIL:-не задан}"
echo "======================================================"

if [ "$1" = "--reset-password" ]; then
  [ -n "$PASS" ] || { echo "ADMIN_PASSWORD в .env пуст"; exit 1; }
  echo ""
  echo "=== Применяю пароль из .env к учётке ${EMAIL} ==="
  docker compose exec -T -e RESET_EMAIL="$EMAIL" -e RESET_PASS="$PASS" api \
    sh -c 'cat > /tmp/reset-admin.mjs && node /tmp/reset-admin.mjs' <<'JS'
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const email = process.env.RESET_EMAIL;

const user = await prisma.user.findUnique({ where: { email } });
if (!user) {
  console.log(`  Пользователя ${email} нет в базе`);
} else {
  const hash = await bcrypt.hash(process.env.RESET_PASS, 12);
  await prisma.user.update({ where: { id: user.id }, data: { password: hash } });
  console.log(`  Пароль обновлён для ${email}`);
}

await prisma.$disconnect();
JS
  echo "Готово. Новый пароль: ${PASS}"
  exit 0
fi

if [ "$EMAIL" = "$WANT" ]; then
  echo "✓ ADMIN_EMAIL согласован с тем, что отправляют приложения"
  exit 0
fi

echo ""
echo "⚠️  ADMIN_EMAIL должен быть ${WANT}, иначе вход из приложений не сработает."

if [ "$1" != "--fix" ]; then
  echo "   Починить: sh scripts/admin-credentials.sh --fix"
  exit 0
fi

echo ""
echo "=== Чиню ==="
if grep -q '^ADMIN_EMAIL=' .env; then
  sed -i "s|^ADMIN_EMAIL=.*|ADMIN_EMAIL=${WANT}|" .env
else
  printf 'ADMIN_EMAIL=%s\n' "$WANT" >> .env
fi
echo "  .env обновлён → ADMIN_EMAIL=${WANT}"

# Учётка уже могла быть создана со старым email — переименовываем её, а не
# заводим вторую: nickname уникален, и seed молча не смог бы создать дубль.
docker compose exec -T -e FIX_NICK="$NICK" -e FIX_EMAIL="$WANT" api \
  sh -c 'cat > /tmp/fix-admin.mjs && node /tmp/fix-admin.mjs' <<'JS'
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const nickname = process.env.FIX_NICK;
const email = process.env.FIX_EMAIL;

const already = await prisma.user.findUnique({ where: { email } });
if (already) {
  console.log(`  В базе уже есть ${email} — ничего менять не нужно`);
} else {
  const profile = await prisma.profile.findUnique({
    where: { nickname },
    include: { user: true },
  });
  if (!profile) {
    console.log(`  Админа с ником "${nickname}" в базе нет — он создастся при старте`);
  } else {
    await prisma.user.update({ where: { id: profile.userId }, data: { email } });
    console.log(`  Email админа изменён: ${profile.user.email} → ${email}`);
  }
}

await prisma.$disconnect();
JS

docker compose restart api >/dev/null
echo "  api перезапущен"
echo ""
echo "Готово. Входи в приложении: ник «${NICK}», пароль «${PASS}»."
