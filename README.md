# BPMz — сервер (API)

Backend музыкального сервиса BPMz: Node.js + Express + Prisma + SQLite.
Разворачивается в Docker вместе с Caddy (HTTPS от Let's Encrypt) и авто-бэкапами.

- Домен: **https://bipmusic.ru**
- API: **https://bipmusic.ru/api**
- Папка на сервере: **/root/server**

## Возможности

- Регистрация по инвайт-кодам, подтверждение пользователей админом
- JWT-аутентификация с ротацией refresh-токенов (одноразовые, хранятся хешами)
- Защита от брутфорса (лимиты по email и IP) и rate limiting на всех маршрутах
- Хранение треков в зашифрованном виде (AES-256-CTR, отдельный ключ на трек)
- Выдача ключей расшифровки через отдельный лимитируемый и аудируемый endpoint
- Стриминг с поддержкой HTTP Range
- Админка: артисты, альбомы, треки, пользователи, журнал аудита

## Стек

- Node.js 20 + Express + TypeScript
- Prisma ORM + SQLite
- Docker + Docker Compose + Caddy

---

# Деплой на VPS (через Termius или любой SSH)

## Шаг 0. Настроить DNS (обязательно!)

Домен должен указывать на IP твоего VPS — иначе Caddy не получит HTTPS-сертификат
и приложения не смогут подключиться.

Узнай IP сервера (выполнить на VPS):

```bash
curl -s https://api.ipify.org; echo
```

Затем в панели регистратора (reg.ru) → DNS-записи домена `bipmusic.ru`:

| Тип | Имя | Значение |
|-----|-----|----------|
| A | `@` | IP твоего VPS |
| A | `www` | IP твоего VPS |

Удали конфликтующие A/CNAME-записи, которые ведут на парковку регистратора.
Обновление занимает от 10 минут до пары часов. Проверить:

```bash
dig +short bipmusic.ru
```

Должен вернуться IP твоего VPS.

---

## Быстрый способ: одна команда

Если файлы уже на сервере в `/root/server`:

```bash
cd /root/server && sh scripts/quick-setup.sh
```

Скрипт сам поставит Docker, создаст `.env`, сгенерирует все секреты и пароль
администратора, проверит DNS, соберёт и запустит контейнеры, а в конце покажет
данные для входа. Повторный запуск безопасен — существующие секреты и данные
не перезаписываются.

Ниже — то же самое по шагам, если хочешь контролировать каждый этап.

---

## Шаг 1. Залить файлы

Скопируй содержимое этого репозитория в `/root/server` на сервере
(через SFTP в Termius или командой с локальной машины):

```bash
rsync -av --exclude 'node_modules' --exclude 'dist' --exclude 'data' \
  ./ root@ВАШ_IP:/root/server/
```

## Шаг 2. Установить Docker (один раз)

```bash
cd /root/server
sh scripts/install-docker.sh
```

## Шаг 3. Настроить `.env`

```bash
cd /root/server
cp .env.production.example .env
```

Заполнить секреты (можно одной вставкой):

```bash
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -base64 48)|" .env
sed -i "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=$(openssl rand -base64 48)|" .env
sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$(openssl rand -base64 18)|" .env
sed -i "s|^INVITE_CODES=.*|INVITE_CODES=мой_секретный_код|" .env

# запиши пароль администратора — он понадобится для входа:
grep '^ADMIN_PASSWORD=' .env
```

Проверить, что верны ключевые строки:

```
DATABASE_URL="file:./data/bpmz.db"
CORS_ORIGINS=https://bipmusic.ru
```

Сервер **намеренно не запустится**, если остались заглушки `REPLACE_ME`,
`ADMIN_PASSWORD` не задан, равен `admin123` или короче 10 символов.

## Шаг 4. Запустить

```bash
sh scripts/vps-first-run.sh
```

## Шаг 5. Проверить

```bash
sh scripts/vps-status.sh
curl -s https://bipmusic.ru/api/health
```

В логах должно быть:

```
[entrypoint] Volume OK: /app/data смонтирован с хоста
🔒 Security check passed
🎵 bpMZ Backend running...
```

## Обновление

```bash
cd /root/server
# залить новые файлы, затем:
sh scripts/vps-update.sh
```

`.env` и папка `data/` не перезаписываются — база и треки сохраняются.

---

## Где лежат данные

| Что | Путь на VPS |
|-----|-------------|
| База | `/root/server/data/bpmz.db` |
| Треки (зашифрованы) | `/root/server/data/tracks/` |
| Обложки | `/root/server/data/covers/` |
| Бэкапы | `/root/server/data/backups/` |

## Частые команды

```bash
cd /root/server && docker compose ps           # статус
cd /root/server && docker compose logs -f api  # логи API
cd /root/server && docker compose restart      # перезапуск
```

## Чего не делать

```bash
docker compose down -v      # удалит тома Caddy (HTTPS-сертификаты)
rm -rf /root/server/data    # уничтожит базу и треки
```

`docker compose down` без `-v` — безопасно.

---

## Переменные окружения

| Переменная | Назначение |
|------------|-----------|
| `NODE_ENV` | `production` на сервере |
| `PORT` / `HOST` | порт и адрес API (по умолчанию 3000 / 0.0.0.0) |
| `DATABASE_URL` | путь к SQLite: `file:./data/bpmz.db` |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | разные секреты, 32+ символа |
| `JWT_EXPIRY` / `JWT_REFRESH_EXPIRY` | время жизни токенов |
| `CORS_ORIGINS` | список разрешённых origin (в проде нельзя `*`) |
| `INVITE_CODES` | коды приглашения через запятую |
| `ADMIN_EMAIL` / `ADMIN_NICKNAME` / `ADMIN_PASSWORD` | учётка администратора (создаётся при первом старте) |
| `TRACKS_DIR` / `COVERS_DIR` / `TMP_DIR` | пути хранения файлов |
| `BCRYPT_ROUNDS` | стоимость bcrypt (10–12, по умолчанию 11) |

## Локальная разработка

```bash
npm install
cp .env.production.example .env   # и поправить под локальные значения
npx prisma db push
npm run dev
```

## Безопасность

- Пароли — bcrypt; refresh-токены хранятся только в виде SHA-256 хешей и одноразовы
- Наружу открыт только Caddy (80/443); API-контейнер не публикует порт
- Загружаемые аудиофайлы проверяются по magic bytes
- Все админ-действия и выдачи ключей пишутся в журнал аудита
