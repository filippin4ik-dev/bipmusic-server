# bpMZ — деплой через Termius

Домен: **https://bipmusic.ru**  
API: **https://bipmusic.ru/api**  
VPS: **root@194.87.104.91**  
Папка на сервере: **/root/server**

---

## Часть 1. Собрать архив на Mac

```bash
cd /Users/roman/Documents/your-private-groov/server
chmod +x scripts/make-deploy-bundle.sh
./scripts/make-deploy-bundle.sh
```

Появится файл **`bpmz-server.zip`** (~1–2 МБ, без базы и без node_modules).

В архиве: Dockerfile, docker-compose, исходники, скрипты.  
**Нет:** `.env`, `data/`, `node_modules` — они остаются только на VPS.

---

## Часть 2. Закинуть файл через Termius

### Вариант A — SFTP (файлы)

1. Открой **Termius** на телефоне/Mac.
2. Хост: **194.87.104.91**, пользователь **root**.
3. Нажми на хост → **SFTP** / **Files** (иконка папки).
4. Перейди в **`/root/server`**  
   (если папки нет — создай: `mkdir -p /root/server`).
5. Загрузи **`bpmz-server.zip`** в `/root/server/`.

### Вариант B — через SSH + терминал на Mac

```bash
scp /Users/roman/Documents/your-private-groov/server/bpmz-server.zip root@194.87.104.91:/root/server/
```

---

## Часть 3. Распаковать и запустить (SSH в Termius)

Подключись к серверу → **SSH** → вставь команды:

### Первый раз (сервера ещё не было)

```bash
cd /root/server
unzip -o bpmz-server.zip
sh scripts/vps-first-run.sh
```

Скрипт попросит настроить `.env`. Открой редактор:

```bash
nano .env
```

Обязательно замени:
- `JWT_SECRET` — сгенерируй: `openssl rand -base64 48`
- `JWT_REFRESH_SECRET` — ещё раз `openssl rand -base64 48`
- `INVITE_CODES` — свои коды приглашения

Должно быть:
```env
DATABASE_URL="file:./data/bpmz.db"
CORS_ORIGINS=https://bipmusic.ru
```

Потом снова:
```bash
sh scripts/vps-first-run.sh
```

### Обновление (сервер уже работает, залил новый zip)

```bash
cd /root/server
unzip -o bpmz-server.zip
sh scripts/vps-update.sh
```

`.env` и папка `data/` **не перезапишутся** — треки и база останутся.

---

## Часть 4. Проверка

```bash
cd /root/server
sh scripts/vps-status.sh
curl -s https://bipmusic.ru/api/health
```

В логах должно быть:
```
[entrypoint] Volume OK: /app/data смонтирован с хоста
[entrypoint] Database OK (… bytes) → bpmz.db
```

---

## Где лежат данные (не пропадут при падении Docker)

| Что | Путь на VPS |
|-----|-------------|
| База | `/root/server/data/bpmz.db` |
| Треки | `/root/server/data/tracks/` |
| Обложки | `/root/server/data/covers/` |
| Бэкапы | `/root/server/data/backups/` |

---

## Полезные команды в Termius

```bash
cd /root/server && docker compose ps          # статус
cd /root/server && docker compose logs -f api   # логи API
cd /root/server && docker compose restart       # перезапуск без сборки
```

### НЕ ДЕЛАЙ

```bash
docker compose down -v    # удалит служебные тома Caddy
rm -rf /root/server/data # убьёт базу и треки
```

`docker compose down` **без** `-v` — безопасно.

---

## npm на VPS не нужен

В Termius ты **не запускаешь** `npm install`.  
Только: залил zip → `unzip` → `sh scripts/vps-update.sh`.  
Сборка идёт внутри Docker.
