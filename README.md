# BPMz — сервер (API)

Backend музыкального сервиса BPMz: Node.js + Express + Prisma + SQLite.
Разворачивается в Docker вместе с Caddy (HTTPS от Let's Encrypt) и авто-бэкапами.

- Домен: **https://bipmusic.ru**
- API: **https://bipmusic.ru/api**
- Папка на сервере: **/root/server**

---

## ⚡ Шпаргалка: обновить сервер

Обновить код с GitHub и пересобрать:

```bash
cd /root/server && sh scripts/vps-git-update.sh
```

Если API не отвечает — диагностика:

```bash
cd /root/server && sh scripts/vps-diagnose.sh
```

Если сборка падает с `failed to load metadata for docker.io/...`
(Docker Hub блокирует российские IP):

```bash
cd /root/server && sh scripts/fix-docker-mirror.sh
```

Перезапустить Caddy и посмотреть выпуск HTTPS-сертификата
(нужно после того, как DNS домена начал указывать на сервер):

```bash
cd /root/server && docker compose restart caddy && docker compose logs -f caddy
```

Выйти из просмотра логов — `Ctrl+C`.

Забыл логин или пароль от админки:

```bash
grep -E '^ADMIN_(NICKNAME|EMAIL|PASSWORD)=' /root/server/.env
```

Работает всегда, даже если код на сервере ещё не обновлён. В приложении
вводится **ник**, а не email.

То же самое, но с проверкой, что `ADMIN_EMAIL` согласован с приложениями:

```bash
cd /root/server && sh scripts/admin-credentials.sh
```

Если скрипт ругается на email — `sh scripts/admin-credentials.sh --fix`.

Обе команды выполняются **на VPS** по SSH (например, через Termius).
`.env` и папка `data/` (база, треки, бэкапы) при обновлении не затрагиваются.

Первый запуск на чистом сервере — см. [Деплой через GitHub](#деплой-через-github-основной-способ).

---

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

# Деплой через GitHub (основной способ)

Репозиторий публичный, поэтому серверу не нужны ни ключи, ни токены.
Секреты хранятся только в `.env` на самом сервере — этот файл в `.gitignore`
и в репозиторий никогда не попадает.

## Первичная настройка (один раз)

Подключись к VPS по SSH и выполни:

```bash
apt-get update -qq && apt-get install -y git

mkdir -p /root/server && cd /root/server
git init -q -b main
git remote add origin https://github.com/filippin4ik-dev/bipmusic-server.git
git fetch origin
git reset --hard origin/main
chmod +x scripts/*.sh docker-entrypoint.sh
```

Используется `git init` + `reset`, а не `git clone`, потому что папка
`/root/server` может быть непустой (база и треки в `data/`, файл `.env`) —
эти файлы сохранятся, они в `.gitignore`.

## Запуск

```bash
cd /root/server && sh scripts/quick-setup.sh
```

Скрипт поставит Docker, создаст `.env`, сгенерирует секреты и пароль
администратора, проверит DNS, соберёт и запустит контейнеры, а в конце покажет
данные для входа. Повторный запуск безопасен — существующие секреты, база и
треки не перезаписываются.

---

# Как обновить код на VPS

Схема работы: код правится на компьютере → уходит в GitHub → сервер забирает
его оттуда. На самом VPS файлы редактировать не нужно.

```
компьютер  →  git push  →  GitHub  →  git pull на VPS  →  пересборка Docker
```

## Обновление одной командой

Подключись к серверу по SSH (Termius) и выполни:

```bash
cd /root/server && sh scripts/vps-git-update.sh
```

Что делает скрипт:

1. забирает свежий код из GitHub (`git fetch` + `git reset --hard origin/main`);
2. показывает, какие коммиты приехали;
3. пересобирает и перезапускает контейнеры (`docker compose up -d --build`);
4. выводит статус и проверяет API изнутри контейнера и снаружи.

**Данные не пострадают.** Файл `.env` и папка `data/` (база, треки, обложки,
бэкапы) перечислены в `.gitignore`, поэтому git их не трогает ни при каких
обновлениях.

**Важно:** скрипт делает `git reset --hard`, то есть любые правки
**отслеживаемых** файлов, сделанные прямо на сервере, будут стёрты. Это
сделано намеренно, чтобы состояние сервера всегда точно совпадало с GitHub.
Меняй код у себя на компьютере и пушь в репозиторий.

## Если менялись переменные окружения

Когда в `.env.production.example` появляются новые переменные, добавь их
в рабочий `.env` на сервере вручную, затем перезапусти:

```bash
cd /root/server
nano .env
docker compose up -d --build
```

## Ручной вариант (то же самое по шагам)

```bash
cd /root/server
git fetch origin
git reset --hard origin/main
chmod +x scripts/*.sh docker-entrypoint.sh
docker compose up -d --build
docker compose logs -f api      # выйти: Ctrl+C
```

## HTTPS-сертификат: выпуск и перевыпуск

Caddy получает сертификат Let's Encrypt автоматически при первом запуске.
Обязательное условие — домен уже должен указывать на этот сервер, иначе
проверка владения доменом не пройдёт.

Перезапустить Caddy и следить за выпуском:

```bash
cd /root/server && docker compose restart caddy && docker compose logs -f caddy
```

Выход из логов — `Ctrl+C`.

Признак успеха в логах:

```
certificate obtained successfully
```

Если сертификат не выпускается, проверь по порядку:

1. **DNS указывает на этот сервер.** Сравни вывод двух команд — они должны
   совпадать:
   ```bash
   curl -s https://api.ipify.org; echo     # IP этого сервера
   getent hosts bipmusic.ru                # куда смотрит домен
   ```
2. **Порты 80 и 443 открыты.** Let's Encrypt проверяет владение доменом через
   порт 80. Если у хостинга включён внешний фаервол — открой оба порта.
   ```bash
   ss -lntp | grep -E ':80 |:443 '
   ```
3. **Порты не заняты другим веб-сервером** (nginx, apache). Если заняты:
   ```bash
   systemctl stop nginx apache2 && systemctl disable nginx apache2
   docker compose restart caddy
   ```

Сертификаты хранятся в docker-томе `caddy_data` и переживают пересборку.
Поэтому **никогда не выполняй `docker compose down -v`** — флаг `-v` удалит том
вместе с сертификатами, и Let's Encrypt может упереться в лимит на повторные
выпуски.

## Ошибка сборки: `failed to load metadata for docker.io/...`

Полный текст обычно такой:

```
ERROR: failed to solve: node:20-alpine: failed to resolve source metadata
for docker.io/library/node:20-alpine: ... 403 Forbidden
```

Причина не в проекте: **Docker Hub блокирует доступ с российских IP-адресов**,
поэтому Docker не может скачать базовый образ Node.js. Решается зеркалами
реестра:

```bash
cd /root/server && sh scripts/fix-docker-mirror.sh
```

Скрипт пропишет зеркала в `/etc/docker/daemon.json` (существующие настройки
сохранятся, старый файл забэкапится в `daemon.json.bak`), перезапустит Docker
и проверит, что образ скачивается. После успеха запусти сборку снова:

```bash
sh scripts/quick-setup.sh
```

`quick-setup.sh` теперь и сам проверяет доступ к Docker Hub перед сборкой и при
необходимости настраивает зеркала автоматически.

Используются зеркала `mirror.gcr.io` (Google), `dh-mirror.gitverse.ru` и
`dockerhub1.beget.com`. Учти: публичные зеркала — сторонние сервисы, они отдают
образы «как есть» и могут быть нестабильны. Если проект станет коммерческим,
надёжнее поднять собственный pull-through cache на образе `registry:2` или
использовать управляемый реестр (Yandex Container Registry, Selectel).

## Если после обновления что-то не работает

```bash
cd /root/server && sh scripts/vps-diagnose.sh
```

Диагностика по пунктам покажет: запущены ли контейнеры, отвечает ли API внутри
контейнера, совпадает ли DNS домена с IP этого сервера, кто занимает порты
80/443, какой сервер реально отвечает по домену, и последние строки логов API
и Caddy.

Частая ситуация: **API внутри контейнера отвечает, а снаружи нет.** Это значит,
что с сервером всё в порядке, а домен указывает не на него — нужно поправить
A-запись у регистратора.

Откатиться на предыдущую версию, если новая сломалась:

```bash
cd /root/server
git log --oneline -5          # найти нужный коммит
git reset --hard <хеш>
docker compose up -d --build
```

---

## Если сделать репозиторий приватным

Тогда серверу понадобится ключ на чтение (deploy key). На VPS:

```bash
ssh-keygen -t ed25519 -C "bipmusic-vps" -f ~/.ssh/id_ed25519_bipmusic -N ""
cat >> ~/.ssh/config <<'EOF'

Host github.com
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519_bipmusic
    IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
cat ~/.ssh/id_ed25519_bipmusic.pub
```

Выведенный ключ добавь в **Settings → Deploy keys** репозитория (без права
записи), затем переключи remote на SSH:

```bash
cd /root/server
git remote set-url origin git@github.com:filippin4ik-dev/bipmusic-server.git
git fetch origin && git reset --hard origin/main
```

---

# Альтернатива: залить файлы вручную

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
curl -s https://bipmusic.ru/health
```

В логах должно быть:

```
[entrypoint] Volume OK: /app/data смонтирован с хоста
🔒 Security check passed
🎵 bpMZ Backend running...
```

---

## Вход в админку

Посмотреть учётные данные напрямую в `.env`:

```bash
grep -E '^ADMIN_(NICKNAME|EMAIL|PASSWORD)=' /root/server/.env
```

Или то же самое плюс проверка на частую ошибку с email:

```bash
sh scripts/admin-credentials.sh
```

В приложении вводится **ник** (по умолчанию `admin`) и пароль из `ADMIN_PASSWORD`.

Про email важно знать одну вещь: клиенты (iOS, десктоп, веб) не спрашивают
адрес — они берут ник и достраивают его до `<ник>@echo.local`. Сервер в
`/api/auth/login` ищет пользователя строго по email. Поэтому `ADMIN_EMAIL`
обязан быть именно `<ADMIN_NICKNAME>@echo.local`; с любым другим доменом
учётка создастся, но зайти в неё из приложения будет нельзя.

Если сервер поднимался со старым `.env`, где стоял другой домен:

```bash
sh scripts/admin-credentials.sh --fix
```

Скрипт поправит `.env` и переименует уже созданную учётку, а не заведёт вторую
(ник уникален, поэтому дубль просто не создался бы).

Сменить пароль: смены пароля в API нет, а seed пропускает уже существующего
админа — то есть просто поправить `ADMIN_PASSWORD` в `.env` недостаточно.
Впиши новый пароль в `.env` и применяй его так:

```bash
sh scripts/admin-credentials.sh --reset-password
```

---

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

grep -E '^ADMIN_(NICKNAME|EMAIL|PASSWORD)=' /root/server/.env   # логин админа
```

## Скрипты

Все запускаются из `/root/server` командой `sh scripts/ИМЯ.sh`.

| Скрипт | Когда нужен |
|--------|-------------|
| `vps-git-setup.sh` | один раз — подключить папку к репозиторию GitHub |
| `quick-setup.sh` | первый запуск: Docker, `.env`, секреты, сборка, старт |
| `vps-git-update.sh` | **обновить код с GitHub и пересобрать** |
| `vps-diagnose.sh` | если API не отвечает — диагностика по пунктам |
| `vps-status.sh` | краткий статус: данные, база, контейнеры |
| `admin-credentials.sh` | показать логин/пароль админа, починить email, сменить пароль |
| `install-docker.sh` | установка Docker (вызывается автоматически) |
| `backup-data.sh` | резервная копия `data/` |
| `restore-data.sh` | восстановление из бэкапа |

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
| `LOGIN_RATE_LIMIT` | попыток входа в минуту с одного IP (по умолчанию выключено) |
| `LOGIN_MAX_FAILS_PER_EMAIL` | неудачных входов в аккаунт за 15 минут до блокировки (выключено) |
| `LOGIN_MAX_FAILS_PER_IP` | неудачных входов с IP за 15 минут до блокировки (выключено) |
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

### Ограничения на вход

Сообщения «Слишком много попыток входа. Подожди минуту.» и «Слишком много
неудачных попыток входа. Подожди 15 минут.» по умолчанию **выключены** — на
маленьком приватном сервере они чаще мешают своим, чем защищают от чужих.

Общий лимит 300 запросов в минуту на IP продолжает действовать, а вход закрыт
кодом приглашения, так что перебор снаружи всё равно упирается в потолок.
Если сервер станет публичнее, включи защиту обратно в `.env`:

```
LOGIN_RATE_LIMIT=20
LOGIN_MAX_FAILS_PER_EMAIL=5
LOGIN_MAX_FAILS_PER_IP=20
```

Затем `docker compose up -d` (перечитает `.env`).

Неудачные попытки продолжают записываться в журнал в любом случае — историю
видно, просто она никого не блокирует.
