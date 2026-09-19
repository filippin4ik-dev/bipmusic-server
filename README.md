# Как обновить сервер (скопируй в Termius)

```bash
cd /root/server && sh scripts/vps-git-update.sh
```

Эта команда забирает свежий код с GitHub и пересобирает Docker.  
`.env` и папка `data/` (база, треки, обложки) не трогаются.

Проверка, что API жив:

```bash
curl -I https://bipmusic.ru/api/health
```

Должен ответить `200`. Если сборка упала — `cd /root/server && docker compose logs -f api`.

Приложение после сервера пересобирается отдельно: см. `bipmusic-ios/README.md` (Xcode → Archive → Админка → Обнова).

---

# BPMz — сервер (API)

Backend музыкального сервиса BPMz: Node.js + Express + Prisma + SQLite.
Разворачивается в Docker вместе с Caddy (HTTPS от Let's Encrypt) и авто-бэкапами.

- Домен: **https://bipmusic.ru**
- API: **https://bipmusic.ru/api**
- Папка на сервере: **/root/server**

Корень домена — главная страница сервиса (не JSON). Обновляется вместе с API.

---

## 🚑 Треки пропали, каталог пустой — починить одной командой

Скопировать на VPS целиком, дальше всё делается само:

```bash
cd /root/server && git fetch origin && git reset --hard origin/main && sh scripts/fix-db-path.sh
```

Найдёт базу, уехавшую мимо смонтированного тома, вернёт её на правильный путь,
закрепит абсолютный `DATABASE_URL`, пересоберёт контейнеры и напечатает, сколько
в базе треков. Повторный запуск безопасен.

**До этой команды не пересобирай контейнеры** (`docker compose up --build`,
`vps-git-update.sh`): пересборка удаляет старый контейнер вместе со слоем, а
значит и базу внутри него.

Почему так вышло и что делать, если база не нашлась —
[Пропали треки: каталог пустой](#пропали-треки-каталог-пустой).

---

## ⚡ Шпаргалка: обновить сервер

Обновить код с GitHub и пересобрать:

```bash
cd /root/server && sh scripts/vps-git-update.sh
```

Токен Diawi (один раз в `.env`, потом пересборка). Без него админ всё равно может вставить ссылку вручную:

```bash
cd /root/server
grep -q '^DIAWI_TOKEN=' .env || echo 'DIAWI_TOKEN=' >> .env
nano .env   # вставь токен с https://i.diawi.com/profile/api
docker compose up -d --build api
```

IPA кладётся в админке приложения → вкладка «Обнова». Ссылка появляется на bipmusic.ru и в самом приложении. Ставить нужно из Safari.

Если API не отвечает — диагностика:

```bash
cd /root/server && sh scripts/vps-diagnose.sh
```

Каталог пустой, треки пропали — вернуть базу на место и починить `.env`:

```bash
cd /root/server && git fetch origin && git reset --hard origin/main && sh scripts/fix-db-path.sh
```

Восстановить базу из суточного бэкапа:

```bash
cd /root/server && sh scripts/restore-data.sh && docker compose restart api
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

Приложение отправляет `@echo.local`, а в базе учётка на `@bpmz.local`:

```bash
cd /root/server && sh scripts/vps-git-update.sh && sh scripts/admin-credentials.sh --fix
```

Так и должно быть — `echo.local` зашит во всех клиентах (iOS, десктоп, веб),
а `bpmz.local` попал в старый шаблон `.env` по ошибке. Команда переименовывает
существующую учётку, а не заводит вторую: seed пропускает уже созданного админа,
да и ник в базе уникален, поэтому дубль не создался бы.

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

Пишет «Неверный ник или пароль», хотя всё введено верно:

```bash
cd /root/server && sh scripts/vps-git-update.sh && sh scripts/admin-credentials.sh --check
```

Потом пробуешь войти в приложении и сразу смотришь, что решил сервер:

```bash
cd /root/server && docker compose logs --tail 30 api | grep '\[login\]'
```

Будет одна из двух строк: «пользователя нет в базе» или «неверный пароль для».
Если не появилось ни одной — запрос до сервера не дошёл, дело в адресе,
а не в учётке.

Все команды выполняются **на VPS** по SSH (например, через Termius).
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
- Текст песни с необязательной синхронизацией по времени (LRC)
- Публичные ссылки на трек `/t/<id>` с превью для мессенджеров

---

## Текст песни

Текст добавляется в админке приложения: трек → «Изменить» → поле «Текст песни».
Формат выбирать не нужно, клиент определяет его сам:

```
[00:25] Метку можно поставить хотя бы первой строке —
с неё текст и начнётся, а дальше время
[01:48] считается само между метками.
Строки без меток разойдутся пропорционально своей длине.
```

Меток может быть сколько угодно: у всех строк — подсветка точная и тап по
строке перематывает на неё; у части — время между ними рассчитывается по длине
строк; без меток вовсе — по длительности трека с запасом на вступление и
проигрыш. Если текст спешит или отстаёт, добавь метку в то место, где он
разошёлся с песней, — остальное подтянется. Метки, идущие вразрез с порядком
строк, игнорируются.

Метки понимаются в видах `[мм:сс]`, `[мм:сс.хх]` и `[мм:сс:хх]`. Несколько
меток перед одной строкой (повтор припева) дают несколько строк — как в
стандарте LRC. Служебные теги вроде `[ar: артист]` и `[ti: название]`
игнорируются, пустая строка с меткой остаётся паузой между куплетами.
Ограничение — 20 000 символов на трек; пустое поле убирает текст.

## Ссылки на трек

Кнопка «Поделиться» в плеере и в контекстном меню трека даёт ссылку
`https://bipmusic.ru/t/<id>`. Страница отдаёт только название, артиста и
обложку (ни файла, ни ключа расшифровки), показывает превью в мессенджерах
через og-теги и ведёт кнопкой в приложение по схеме `bpmz://track/<id>`.

Universal Links намеренно не используются: им нужны
`apple-app-site-association` и entitlement, а файл ассоциации iOS тянет через
CDN Apple — тот самый, который отваливается при блокировках. Своя схема
работает без обращений к серверам Apple.

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

## Пропали треки: каталог пустой

Обновление кода само по себе треки удалить не может. Папка `data/` (база, треки,
обложки, бэкапы) перечислена в `.gitignore`, ни один файл из неё не отслеживается
git, поэтому `git reset --hard` её не касается. Схема базы при обновлении не
меняется, а значит `prisma db push` ничего не переносит и не удаляет; seed
пропускает уже созданного админа. В скриптах деплоя нет ни `rm -rf data`, ни
`down -v`, ни `migrate reset`.

Пустой каталог означает одно: контейнер не нашёл файл базы `data/bpmz.db`, создал
вместо неё пустую и завёл заново только админа. Сам файл при этом обычно жив —
просто лежит не в той папке, которую монтирует контейнер.

### Известная причина: база уезжала в `/app/prisma/data`

Так было до версии с абсолютным `DATABASE_URL`. Prisma резолвит относительный
`file:`-путь **от папки со схемой** (`/app/prisma`), а не от рабочей папки
процесса. Поэтому `DATABASE_URL="file:./data/bpmz.db"` создавал базу в
`/app/prisma/data/bpmz.db` — в слое контейнера, мимо смонтированного тома.
Пересборка удаляет контейнер вместе со слоем, и каталог оказывается пустым.

Файлы треков и обложек при этом целы: их пути Node резолвит от рабочей папки
(`/app`), то есть они всегда лежали в `/app/data/tracks` на томе. Пропадала
только база — а вместе с ней и ключи расшифровки. По той же причине entrypoint
годами писал «Базы нет» и ни разу не сделал бэкап: он проверял `/app/data/bpmz.db`,
которого никогда не существовало.

### Починка одной командой

```bash
cd /root/server && git fetch origin && git reset --hard origin/main && sh scripts/fix-db-path.sh
```

Первая половина команды забирает свежие скрипты из GitHub, не трогая контейнеры
(пересборки здесь нет, `data/` в `.gitignore`). Дальше `fix-db-path.sh` по шагам:

1. показывает, что сейчас на диске — размер базы на томе и число аудиофайлов;
2. останавливает API, чтобы снимок SQLite не получился битым;
3. ищет базу в `/app/prisma/data` внутри контейнера, а также в `prisma/data`
   и `data/groov.db` на диске, и выбирает самый крупный найденный файл;
4. переносит его в `data/bpmz.db`, положив прежнюю базу в `data/backups`;
5. переписывает `DATABASE_URL` в `.env` на абсолютный, пересобирает контейнеры
   и печатает, сколько в базе треков, альбомов, артистов и пользователей.

Существующую базу скрипт не затирает ничем меньшего размера, `.env` сохраняет в
`data/backups`, так что запускать повторно безопасно.

**Важно: до этой команды не запускай пересборку** (`docker compose up --build`,
`vps-git-update.sh`). Пересборка удаляет старый контейнер вместе со слоем, а
значит и базу — восстанавливать будет уже нечего.

Если предпочитаешь руками, то же самое:

```bash
cd /root/server
docker compose stop api
docker cp bpmz-api:/app/prisma/data/bpmz.db ./data/bpmz.db
docker cp bpmz-api:/app/prisma/data/bpmz.db-wal ./data/bpmz.db-wal 2>/dev/null || true
ls -lh data/bpmz.db
sed -i 's|^DATABASE_URL=.*|DATABASE_URL="file:/app/data/bpmz.db"|' .env
docker compose up -d --build
```

Правильная база — **`bpmz.db`**, одна и только она:

| Где | Путь |
|-----|------|
| На VPS | `/root/server/data/bpmz.db` |
| Внутри контейнера | `/app/data/bpmz.db` |
| В `.env` | `DATABASE_URL="file:/app/data/bpmz.db"` |

Относительный путь в `.env` тоже примут — entrypoint перепишет его на абсолютный
при старте. Но лучше поправить, потому что скрипты, запускаемые через
`docker exec` (например `admin-credentials.sh`), читают `.env` напрямую и без
правки будут смотреть в `/app/prisma/data`:

```bash
sed -i 's|^DATABASE_URL=.*|DATABASE_URL="file:/app/data/bpmz.db"|' /root/server/.env
```

`groov.db` — имя из старой версии проекта, его отсутствие нормально. Entrypoint
один раз скопирует `groov.db` → `bpmz.db`, если второго ещё нет, и больше к нему
не возвращается.

**Ключи шифрования треков хранятся в базе** (`encKey` и `encNonce` в таблице
`Track`, свой ключ на каждый трек). Файлы из `data/tracks/` без базы расшифровать
нельзя, поэтому восстанавливать нужно именно `bpmz.db`.

### Шаг 1. Не пересобирать сервер, пока не разобрался

При каждом старте entrypoint копирует текущую базу в
`data/backups/bpmz-latest.db` и хранит последние 8 снимков. Если сейчас запущена
пустая база, лишние перезапуски вытеснят из этой очереди хорошие копии.

### Шаг 2. Что сказал сервер при старте

```bash
cd /root/server && docker compose logs api | grep '\[entrypoint\]' | head -20
```

Что искать в выводе:

| Строка | Что значит |
|--------|-----------|
| `Volume OK: /app/data смонтирован с хоста` | папка с данными подключена верно |
| `ERROR: /app/data НЕ смонтирован` | данные писались внутрь контейнера и пропали при пересборке |
| `Database OK (N bytes)` | база на месте, причина не в ней |
| `Базы нет — создастся при db push` | файл базы не найден — это наш случай |
| `WARNING: N аудиофайлов на диске, но БД пустая!` | треки целы, потерялась только база |

### Шаг 3. Куда смотрит контейнер и что там лежит

```bash
docker exec bpmz-api sh -c 'echo "$DATABASE_URL"; grep " /app/data " /proc/mounts || echo "НЕТ МОНТИРОВАНИЯ"; ls -la /app/data'
```

### Шаг 4. Найти базу и бэкапы на всей машине

```bash
find / -xdev \( -name 'bpmz*.db' -o -name 'groov*.db' -o -name 'bpmz-data-*.tar.gz' \) -size +1k -exec ls -lh {} \; 2>/dev/null
```

Отдельно тома и слои Docker — на случай, если сервер когда-то стартовал без
volume:

```bash
find /var/lib/docker -name 'bpmz*.db' -size +1k -exec ls -lh {} \; 2>/dev/null
```

Файл от сотен килобайт и больше — это рабочая база. Архив `bpmz-data-*.tar.gz`
содержит и базу, и сами треки с обложками.

### Шаг 5. Проверить `.env`

```bash
grep -E '^(DATABASE_URL|TRACKS_DIR|COVERS_DIR)=' /root/server/.env
```

Должно быть `DATABASE_URL="file:/app/data/bpmz.db"` (относительный
`file:./data/bpmz.db` тоже примут, но он же и был причиной потери — см. выше).
Любой третий вариант entrypoint в production не пропустит и остановит запуск.

### Шаг 6. Восстановить

Автоматически (то же, что «Починка одной командой» выше):

```bash
cd /root/server && sh scripts/fix-db-path.sh
```

Из бэкапов проекта — сам выберет самый свежий снимок:

```bash
cd /root/server && sh scripts/restore-data.sh && docker compose restart api
```

Если база нашлась в другом месте, положить её на канонический путь вручную.
API обязательно остановить, иначе он перетрёт файл своей пустой базой:

```bash
cd /root/server
docker compose stop api
cp /путь/где/нашлась/bpmz.db data/bpmz.db
docker compose start api
docker compose logs --tail 20 api | grep '\[entrypoint\]'
```

Из архива (подставь имя файла из шага 4):

```bash
cd /root/server
docker compose stop api
tar xzf data/backups/bpmz-data-ГГГГММДД-ЧЧММСС.tar.gz -C .
docker compose start api
```

После восстановления в логе должно быть `Database OK (N bytes)`, а треки —
в приложении.

### Шаг 7. Сколько записей реально в базе

```bash
docker exec bpmz-api node -e 'const {PrismaClient}=require("@prisma/client");const p=new PrismaClient();Promise.all([p.track.count(),p.album.count(),p.artist.count(),p.user.count()]).then(([t,a,r,u])=>console.log("треки:",t,"альбомы:",a,"артисты:",r,"пользователи:",u)).finally(()=>p.$disconnect())'
```

### Если база не нашлась

Сначала глубокий поиск — вдруг остался слой удалённого контейнера или старый
контейнер целиком:

```bash
docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.CreatedAt}}'
find /var/lib/docker -name '*.db' -size +20k -exec ls -lh {} \; 2>/dev/null
find / -xdev -name '*.db' -size +20k -exec ls -lh {} \; 2>/dev/null
ls -lh /root/server/data/backups/ 2>/dev/null
```

Найденный файл можно проверить, не подменяя рабочую базу:

```bash
docker cp /НАЙДЕННЫЙ/ПУТЬ/bpmz.db bpmz-api:/tmp/check.db
docker exec -e DATABASE_URL=file:/tmp/check.db bpmz-api node -e 'const {PrismaClient}=require("@prisma/client");const p=new PrismaClient();p.track.count().then(n=>console.log("треков в этой базе:",n)).finally(()=>p.$disconnect())'
```

Если треков там больше, чем сейчас в приложении — положить на место:

```bash
cp /НАЙДЕННЫЙ/ПУТЬ/bpmz.db /root/server/data/bpmz.db.candidate
cd /root/server && sh scripts/fix-db-path.sh   # предпочтёт файл крупнее
```

Шансы невысокие: Docker удаляет writable-слой сразу вместе с контейнером. Если
ничего не нашлось, остаётся снапшот диска у хостера (если включён) или повторная
загрузка треков из оригиналов.

**Файлы из `data/tracks` без базы бесполезны.** Ключ AES у каждого трека свой,
генерируется при загрузке через `crypto.randomBytes` и хранится только в колонках
`encKey`/`encNonce`. Мастер-ключа нет, вывести ключ из чего-либо ещё нельзя,
поэтому расшифровать `.enc` без базы невозможно. Это же причина держать
`data/backups` в порядке: бэкап базы важнее бэкапа аудиофайлов.

### Единственный способ удалить треки из приложения

Удаление артиста в админке (`DELETE /api/admin/artists/:id`) каскадом убирает все
его треки и альбомы. Кроме этого в коде нет ни одного массового удаления треков.

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
DATABASE_URL="file:/app/data/bpmz.db"
CORS_ORIGINS=https://bipmusic.ru
```

Путь к базе абсолютный не случайно — относительный Prisma резолвит от папки со
схемой и уводит базу в слой контейнера, где она пропадает при пересборке
([подробнее](#пропали-треки-каталог-пустой)).

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

### «Неверный ник или пароль», хотя всё введено верно

Это сообщение сервер отдаёт в двух разных случаях — когда пользователя с таким
email нет и когда не совпал пароль. По тексту их не отличить (так задумано:
иначе перебором можно узнать, какие аккаунты существуют). Что произошло на самом
деле, покажет:

```bash
sh scripts/admin-credentials.sh --check
```

Он выведет список пользователей в базе и сверит пароль из `.env` с сохранённым
хешем, после чего подскажет нужную команду — `--fix` или `--reset-password`.

Второй источник правды — лог самого сервера. Наружу причина отказа не
раскрывается специально, а вот в лог она пишется:

```bash
docker compose logs --tail 30 api | grep '\[login\]'
```

```
[login] отказ: пользователя admin@echo.local нет в базе   → --fix
[login] отказ: неверный пароль для admin@echo.local        → --reset-password
```

Пусто — значит запрос до API не дошёл: проверь `[BPMz] API base URL` в консоли
Xcode и то, что домен указывает на этот сервер.

Про пароль стоит помнить одно: пробелы в нём сервер не обрезает, а при
копировании из терминала в буфер часто попадает перенос строки. Вставленный
в поле, он делает пароль другим.

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
| `fix-db-path.sh` | **каталог пустой** — найти базу мимо тома, вернуть на место, починить `.env` |
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
| `DATABASE_URL` | путь к SQLite, только абсолютный: `file:/app/data/bpmz.db` |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | разные секреты, 32+ символа |
| `JWT_EXPIRY` / `JWT_REFRESH_EXPIRY` | время жизни токенов (на сервере 30 дней / 180 дней) |
| `DIAWI_TOKEN` | токен Diawi: админ грузит IPA, сервер сам получает ссылку для установки |
| `PUBLIC_BASE_URL` | публичный адрес сайта, `https://bipmusic.ru` |
| `APP_BUNDLE_ID` | bundle id приложения для OTA-установки (`bipmusic.bip`) |
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

Локально `/app` не существует, поэтому путь к базе нужен другой. Prisma считает
его от папки `prisma/`, так что до `data/bpmz.db` в корне проекта поднимаемся на
уровень выше:

```
DATABASE_URL="file:../data/bpmz.db"
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
