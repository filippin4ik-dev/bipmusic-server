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
#   --check           показывает, что реально лежит в базе, и проверяет пароль
#                     из .env против сохранённого хеша. Нужен потому, что сервер
#                     на «нет такого пользователя» и «неверный пароль» отвечает
#                     одинаково — по сообщению причину не отличить.
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
echo "  Приложение отправит:        ${WANT}"
echo "======================================================"

require_api() {
  docker compose ps --services --filter status=running 2>/dev/null | grep -q '^api$' && return 0
  echo "Контейнер api не запущен. Сначала: docker compose up -d"
  exit 1
}

# Node ищет node_modules только вверх от папки самого файла, поэтому скрипт
# обязан лежать внутри /app — из /tmp он до /app/node_modules не доберётся и
# упадёт с "Cannot find package '@prisma/client'". /app/data всегда доступен
# на запись: это смонтированный том.
MJS=/app/data/.admin-op.mjs
RUN_MJS="cat > $MJS && node $MJS; rc=\$?; rm -f $MJS; exit \$rc"

if [ "$1" = "--check" ]; then
  require_api
  echo ""
  echo "=== Что в базе ==="
  docker compose exec -T -e CHECK_EMAIL="$WANT" -e CHECK_PASS="$PASS" api \
    sh -c "$RUN_MJS" <<'JS'
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const email = process.env.CHECK_EMAIL;

const users = await prisma.user.findMany({
  include: { profile: true },
  orderBy: { createdAt: 'asc' },
});

console.log(`  Пользователей: ${users.length}`);
for (const u of users) {
  console.log(
    `   - ${u.email}  ник=${u.profile?.nickname ?? '—'}  роль=${u.role}  статус=${u.profile?.status ?? '—'}`
  );
}

console.log('');
const target = users.find((u) => u.email === email);
if (!target) {
  console.log(`  ✗ Пользователя ${email} в базе НЕТ`);
  console.log('    Приложение получит «Неверный ник или пароль» независимо от пароля.');
  console.log('    Починить: sh scripts/admin-credentials.sh --fix');
} else if (await bcrypt.compare(process.env.CHECK_PASS ?? '', target.password)) {
  console.log(`  ✓ Пароль из .env подходит к ${email} — вход должен работать`);
} else {
  console.log(`  ✗ Пароль из .env НЕ совпадает с хешем в базе`);
  console.log('    Учётка создавалась с другим паролем.');
  console.log('    Починить: sh scripts/admin-credentials.sh --reset-password');
}

await prisma.$disconnect();
JS
  exit 0
fi

if [ "$1" = "--reset-password" ]; then
  require_api
  [ -n "$PASS" ] || { echo "ADMIN_PASSWORD в .env пуст"; exit 1; }
  echo ""
  echo "=== Применяю пароль из .env к учётке ${EMAIL} ==="
  docker compose exec -T -e RESET_EMAIL="$EMAIL" -e RESET_PASS="$PASS" api \
    sh -c "$RUN_MJS" <<'JS'
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
  echo "  Если вход всё равно не проходит: sh scripts/admin-credentials.sh --check"
  exit 0
fi

echo ""
echo "⚠️  ADMIN_EMAIL должен быть ${WANT}, иначе вход из приложений не сработает."

if [ "$1" != "--fix" ]; then
  echo "   Починить: sh scripts/admin-credentials.sh --fix"
  exit 0
fi

require_api
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
  sh -c "$RUN_MJS" <<'JS'
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
