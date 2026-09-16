import express, { Request, Response } from 'express';
import { prisma } from '../db.js';
import { publicRelease, readRelease } from '../services/appRelease.js';

/**
 * Главная страница bipmusic.ru.
 *
 * Весь домен проксируется в этот сервер, поэтому на корне раньше отдавался
 * JSON «Route not found». Страница собирается здесь же, без сборщика и без
 * отдельного хостинга — как и страница трека в share.ts.
 *
 * Ничего приватного тут нет: только количество загруженного и обложки, которые
 * и так лежат в открытой статике. Ни имён пользователей, ни названий треков,
 * ни названий артистов — каталог остаётся закрытым.
 */
const router = express.Router();

const APP_SCHEME = 'bpmz';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function publicOriginFrom(req: Request): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host') ?? 'bipmusic.ru'}`;
}

function publicOrigin(req: Request): string {
  return publicOriginFrom(req);
}

/** «трек», «трека», «треков» — иначе подписи под цифрами читаются криво. */
function pluralWord(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

const STYLE = `<style>
  :root {
    color-scheme: dark;
    --bg: #090a0f;
    --fg: #f7f8fa;
    --muted: #9ea4b0;
    --primary: #34d399;
    --line: rgba(255,255,255,.08);
  }
  * { box-sizing: border-box; scrollbar-width: none; -ms-overflow-style: none; }
  *::-webkit-scrollbar { display: none; width: 0; height: 0; }
  html, body {
    margin: 0; height: 100%; background: var(--bg); color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.45; overflow: hidden; overscroll-behavior: none;
    touch-action: manipulation; -webkit-text-size-adjust: 100%;
  }
  .scroll {
    height: 100%; overflow: auto; overscroll-behavior: none; -webkit-overflow-scrolling: touch;
    touch-action: pan-y;
  }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 0 28px 64px; }
  header {
    display: flex; align-items: center; gap: 10px; padding: 20px 0 0;
  }
  .mark {
    width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center;
    background: var(--primary); color: #10231c; font-size: 16px; flex: none;
  }
  .brand { font-size: 17px; font-weight: 700; }
  .brand span { color: var(--primary); }
  header .spacer { flex: 1; }
  header a { color: var(--muted); text-decoration: none; font-size: 14px; }
  header a:hover { color: var(--fg); }

  .hero {
    display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 56px;
    align-items: center; padding: 56px 0 8px;
  }
  .hero h1 { margin: 0 0 12px; font-size: clamp(36px, 5vw, 52px); line-height: 1.05; letter-spacing: -1.2px; font-weight: 750; }
  .hero p { margin: 0; font-size: 17px; color: var(--muted); max-width: 38ch; }

  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 28px 0 0; }
  .btn {
    display: inline-flex; align-items: center; justify-content: center;
    padding: 13px 22px; border-radius: 12px; font-size: 15px; font-weight: 600; text-decoration: none;
  }
  .btn--primary { background: var(--primary); color: #0d2119; }
  .btn--ghost { border: 1px solid var(--line); color: var(--fg); }

  .stats { display: flex; gap: 28px; margin: 32px 0 0; }
  .stat b { display: block; font-size: 24px; letter-spacing: -.6px; }
  .stat small { color: var(--muted); font-size: 13px; }
  .update { margin: 24px 0 0; font-size: 14px; color: var(--muted); }
  .update a { color: var(--primary); text-decoration: none; font-weight: 600; }

  .phone { width: 100%; max-width: 300px; margin: 0 auto; }
  .screen { border-radius: 28px; background: #0c0d12; border: 1px solid var(--line); overflow: hidden; }
  .screen__stage {
    position: relative; display: flex; flex-direction: column; align-items: center;
    padding: 40px 20px 28px; min-height: 320px;
  }
  .screen__blur {
    position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: cover; filter: blur(28px) saturate(.55); opacity: .5;
  }
  .screen__fill { position: absolute; inset: 0; background: #14151c; }
  .screen__veil {
    position: absolute; inset: 0;
    background: linear-gradient(180deg, transparent 20%, #0c0d12 100%);
  }
  .screen__portrait {
    position: relative; z-index: 1;
    width: 148px; height: 148px; border-radius: 50%; object-fit: cover; object-position: center top;
    display: block; background: #17181f;
  }
  .screen__portrait--empty { display: grid; place-items: center; font-size: 52px; color: #6f6f7a; }
  .screen__caption { position: relative; z-index: 1; text-align: center; margin-top: 16px; }
  .screen__caption h3 { margin: 0 0 4px; font-size: 22px; }
  .screen__caption p { margin: 0; font-size: 13px; color: var(--muted); }

  .faces { margin: 48px 0 0; display: flex; justify-content: center; }
  .faces__row { display: flex; align-items: center; }
  .faces__row img {
    width: 76px; height: 76px; border-radius: 50%; object-fit: cover; flex: none;
    border: 3px solid var(--bg); margin-left: -14px; background: #14151c;
  }
  .faces__row > :first-child { margin-left: 0; }

  .marquee { margin: 24px 0 0; overflow: hidden; }
  .marquee__row { display: flex; gap: 12px; width: max-content; animation: drift 48s linear infinite; }
  .marquee__row + .marquee__row { margin-top: 12px; animation-duration: 64s; animation-direction: reverse; }
  .marquee__row img {
    width: 96px; height: 96px; border-radius: 12px; object-fit: cover; flex: none; background: #14151c;
  }
  .marquee__row img.round { border-radius: 50%; }
  @keyframes drift { from { transform: translateX(0); } to { transform: translateX(-50%); } }

  h2 { margin: 64px 0 16px; font-size: 13px; color: var(--muted); font-weight: 600; }
  .cards { display: grid; gap: 1px; grid-template-columns: 1fr 1fr 1fr; background: var(--line); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
  .card { padding: 20px 22px; background: var(--bg); }
  .card h3 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
  .card p { margin: 0; font-size: 13px; color: var(--muted); }

  ol.steps { margin: 0; padding: 0; list-style: none; }
  ol.steps li { padding: 12px 0; border-bottom: 1px solid var(--line); font-size: 15px; }
  ol.steps li:last-child { border-bottom: 0; }
  ol.steps b { display: inline-block; width: 1.4em; color: var(--muted); font-variant-numeric: tabular-nums; }

  footer { margin: 56px 0 0; padding-top: 20px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
  footer a { color: var(--fg); text-decoration: none; }

  @media (prefers-reduced-motion: reduce) {
    .marquee__row { animation: none; }
  }
  @media (max-width: 860px) {
    .hero { grid-template-columns: 1fr; gap: 36px; padding-top: 36px; }
    .phone { max-width: 260px; }
    .cards { grid-template-columns: 1fr 1fr; }
  }
  @media (max-width: 560px) {
    .wrap { padding: 0 16px 48px; }
    .hero h1 { font-size: 32px; }
    .btn { flex: 1 1 auto; }
    .stats { gap: 18px; }
    .cards { grid-template-columns: 1fr; }
    .faces__row img { width: 60px; height: 60px; margin-left: -12px; }
    .screen__portrait { width: 120px; height: 120px; }
  }
</style>`;

type FeaturedArtist = {
  name: string;
  photo: string | null;
  albums: number;
  tracks: number;
};

type Catalogue = {
  tracks: number;
  artists: number;
  albums: number;
  covers: string[];
  portraits: string[];
  featured: FeaturedArtist | null;
};

/** Пустой каталог вместо падения: главная не должна зависеть от базы. */
async function readCatalogue(): Promise<Catalogue> {
  const empty: Catalogue = { tracks: 0, artists: 0, albums: 0, covers: [], portraits: [], featured: null };
  try {
    const [tracks, albums, artists, recentAlbums, recentArtists, galleryPhotos] = await Promise.all([
      prisma.track.count(),
      prisma.album.count(),
      prisma.artist.count(),
      prisma.album.findMany({
        where: { coverUrl: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 14,
        select: { coverUrl: true },
      }),
      prisma.artist.findMany({
        where: { OR: [{ imageUrl: { not: null } }, { photos: { some: {} } }] },
        orderBy: { updatedAt: 'desc' },
        take: 10,
        select: {
          name: true,
          imageUrl: true,
          photos: { orderBy: { position: 'asc' }, take: 1, select: { imageUrl: true } },
          _count: { select: { tracks: true, albums: true } },
        },
      }),
      prisma.artistPhoto.findMany({
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: { imageUrl: true },
      }),
    ]);
    const portraits = [
      ...recentArtists.map((a) => a.imageUrl || a.photos[0]?.imageUrl || '').filter(Boolean),
      ...galleryPhotos.map((p) => p.imageUrl),
    ].filter((v, i, arr) => v && arr.indexOf(v) === i);
    const lead = recentArtists[0];
    return {
      tracks,
      albums,
      artists,
      covers: recentAlbums.map((a) => a.coverUrl).filter((c): c is string => Boolean(c)),
      portraits,
      featured: lead
        ? {
            name: lead.name,
            photo: lead.imageUrl || lead.photos[0]?.imageUrl || null,
            albums: lead._count.albums,
            tracks: lead._count.tracks,
          }
        : null,
    };
  } catch {
    return empty;
  }
}

const FEATURES = [
  { title: 'Офлайн', text: 'Скачанное играет без сети.' },
  { title: 'Тексты', text: 'Строка идёт за песней.' },
  { title: 'Ссылки', text: 'Альбом, плейлист, трек, артист.' },
  { title: 'Шифрование', text: 'Файлы на диске закрыты.' },
  { title: 'Статистика', text: 'Что слушаешь чаще всего.' },
  { title: 'Без рекламы', text: 'И без подписки.' },
];

// GET /
router.get('/', async (req: Request, res: Response) => {
  const catalogue = await readCatalogue();
  const origin = publicOrigin(req);
  const coverUrl = (file: string) => `${origin}/files/covers/${encodeURIComponent(file)}`;
  const description = 'bipMusic — своя музыка на iPhone.';

  // Ряд должен быть шире экрана, иначе сдвиг на половину виден как прыжок.
  const marqueeRow = (items: Array<{ file: string; round?: boolean }>) => {
    let filled = items;
    while (filled.length && filled.length < 10) filled = [...filled, ...items];
    const html = [...filled, ...filled]
      .map((item) =>
        `<img class="${item.round ? 'round' : ''}" src="${escapeHtml(coverUrl(item.file))}" alt="" loading="lazy">`
      )
      .join('');
    return `<div class="marquee__row">${html}</div>`;
  };

  const marqueeItems = [
    ...catalogue.portraits.map((file) => ({ file, round: true })),
    ...catalogue.covers.map((file) => ({ file, round: false })),
  ];
  const marquee = marqueeItems.length
    ? `<div class="marquee" aria-hidden="true">
    ${marqueeRow(marqueeItems)}
    ${marqueeRow([...marqueeItems].reverse())}
  </div>`
    : '';

  const faces = catalogue.portraits.slice(0, 6);
  const facesHtml = faces.length
    ? `<div class="faces" aria-hidden="true"><div class="faces__row">${faces
        .map((file) => `<img src="${escapeHtml(coverUrl(file))}" alt="">`)
        .join('')}</div></div>`
    : '';

  const statCards: Array<[number, string]> = [
    [catalogue.tracks, pluralWord(catalogue.tracks, 'трек', 'трека', 'треков')],
    [catalogue.albums, pluralWord(catalogue.albums, 'альбом', 'альбома', 'альбомов')],
    [catalogue.artists, pluralWord(catalogue.artists, 'артист', 'артиста', 'артистов')],
  ];
  const stats = catalogue.tracks
    ? `<div class="stats">
      ${statCards
        .map(([value, word]) => `<div class="stat"><b>${value}</b><small>${word}</small></div>`)
        .join('\n      ')}
    </div>`
    : '';

  const heroPhoto = catalogue.featured?.photo || catalogue.portraits[0] || null;
  const photoSrc = heroPhoto ? escapeHtml(coverUrl(heroPhoto)) : '';
  const screenHero = heroPhoto
    ? `<img class="screen__blur" src="${photoSrc}" alt="">
            <div class="screen__veil"></div>
            <img class="screen__portrait" src="${photoSrc}" alt="">`
    : `<div class="screen__fill"></div>
            <div class="screen__veil"></div>
            <div class="screen__portrait screen__portrait--empty">♪</div>`;
  const mockName = catalogue.featured?.name || 'Артист';
  const mockStats = catalogue.featured
    ? `${pluralWord(catalogue.featured.albums, 'альбом', 'альбома', 'альбомов')} · ${pluralWord(catalogue.featured.tracks, 'трек', 'трека', 'треков')}`
    : 'альбомы · треки · фото';
  const ogImage = heroPhoto ? coverUrl(heroPhoto) : '';
  const release = readRelease();
  const install = release
    ? publicRelease(release, origin)
    : null;
  const installHref = install?.url || '#app';
  const installBtn = `<a class="btn btn--primary" href="${escapeHtml(installHref)}">${install ? `Установить ${escapeHtml(install.version)}` : 'Установить'}</a>`;
  const updateBanner = install
    ? `<div class="update">Версия ${escapeHtml(install.version)}${install.notes ? ` — ${escapeHtml(install.notes)}` : ''}. <a href="${escapeHtml(install.url)}">Скачать</a></div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover">
<title>bipMusic</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="theme-color" content="#090a0f">
<meta property="og:type" content="website">
<meta property="og:site_name" content="bipMusic">
<meta property="og:title" content="bipMusic">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(origin)}">
${ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}">\n<meta name="twitter:card" content="summary_large_image">` : '<meta name="twitter:card" content="summary">'}
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>♪</text></svg>">
${STYLE}
</head>
<body>
<div class="scroll">
<div class="wrap">
  <header>
    <div class="mark">♪</div>
    <div class="brand">bip<span>Music</span></div>
    <div class="spacer"></div>
    <a href="#app">Установить</a>
  </header>

  <main>
    <section class="hero">
      <div>
        <h1>bipMusic</h1>
        <p>Своя музыка на iPhone. Без рекламы.</p>
        <div class="actions">
          ${installBtn}
          <a class="btn btn--ghost" href="${APP_SCHEME}://">Открыть</a>
        </div>
        ${stats}
        ${updateBanner}
      </div>

      <div class="phone" aria-hidden="true">
        <div class="screen">
          <div class="screen__stage">
            ${screenHero}
            <div class="screen__caption">
              <h3>${escapeHtml(mockName)}</h3>
              <p>${escapeHtml(mockStats)}</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    ${facesHtml}
    ${marquee}

    <div class="cards">
      ${FEATURES.map(
        (f) => `<div class="card">
        <h3>${escapeHtml(f.title)}</h3>
        <p>${escapeHtml(f.text)}</p>
      </div>`
      ).join('\n      ')}
    </div>

    <h2 id="app">Установка</h2>
    <ol class="steps">
      <li><b>1</b> Safari на iPhone</li>
      <li><b>2</b> Установить</li>
      <li><b>3</b> Если спросит — доверь разработчика в Настройках</li>
    </ol>
  </main>

  <footer>
    bipMusic${install ? ` · ${escapeHtml(install.version)}` : ''} · <a href="${APP_SCHEME}://">открыть</a>
  </footer>
</div>
</div>
<script>
addEventListener('gesturestart',function(e){e.preventDefault()});
addEventListener('gesturechange',function(e){e.preventDefault()});
</script>
</body>
</html>`;

  res.type('html');
  // Цифры каталога живые, но меняются редко — минута кеша снимает нагрузку с
  // базы, если по домену пройдётся бот.
  res.set('Cache-Control', 'public, max-age=60');
  res.send(html);
});

/** Страница установки. Diawi надо открывать в Safari — редиректим туда, если ссылка есть. */
router.get('/app', (req: Request, res: Response) => {
  const release = readRelease();
  if (!release) {
    res.status(404).type('html').send('<!DOCTYPE html><html lang="ru"><meta charset="utf-8"><title>Нет сборки</title><body style="background:#090a0f;color:#f7f8fa;font-family:sans-serif;padding:40px">Сборку ещё не выложили.</body></html>');
    return;
  }
  if (release.diawiUrl) {
    res.redirect(302, release.diawiUrl);
    return;
  }
  const origin = publicOrigin(req);
  const manifest = `${origin}/api/app/manifest.plist`;
  const itms = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifest)}`;
  res.type('html').send(`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>Установить bipMusic ${escapeHtml(release.version)}</title>
<meta name="theme-color" content="#090a0f">
<style>
  * { scrollbar-width: none; }
  *::-webkit-scrollbar { display: none; }
  html, body { margin:0; height:100%; overflow:hidden; overscroll-behavior:none; touch-action:manipulation; }
  body { display:grid; place-items:center; background:#090a0f; color:#f7f8fa; font-family:-apple-system,BlinkMacSystemFont,sans-serif; text-align:center; padding:32px; }
  a { display:inline-block; margin-top:24px; padding:14px 28px; border-radius:12px; background:#34d399; color:#10231c; font-weight:700; text-decoration:none; }
  p { color:#9ea4b0; max-width:36ch; }
</style>
</head>
<body>
  <div>
    <h1>bipMusic ${escapeHtml(release.version)}</h1>
    <a href="${escapeHtml(itms)}">Установить</a>
  </div>
</body>
</html>`);
});

export default router;
