import express, { Request, Response } from 'express';
import { prisma } from '../db.js';
import { hostedIpaFilename, publicRelease, readRelease, type AppRelease } from '../services/appRelease.js';

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
    --surface: #14151c;
    --fg: #f7f8fa;
    --muted: #9ea4b0;
    --primary: #34d399;
    --sky: #6aa9f0;
    --border: rgba(52, 211, 153, .16);
  }
  @supports (color: oklch(0.7 0.1 160)) {
    :root {
      --bg: oklch(0.12 0.012 260);
      --surface: oklch(0.17 0.014 260);
      --fg: oklch(0.98 0.005 260);
      --muted: oklch(0.68 0.015 260);
      --primary: oklch(0.69 0.17 162);
      --sky: oklch(0.72 0.11 230);
      --border: oklch(0.69 0.04 162 / 0.16);
    }
  }
  * { box-sizing: border-box; scrollbar-width: none; -ms-overflow-style: none; }
  *::-webkit-scrollbar { display: none; width: 0; height: 0; }
  html {
    -webkit-text-size-adjust: 100%;
    height: 100%;
    overflow: hidden;
    overscroll-behavior: none;
  }
  body {
    margin: 0; height: 100%; background: var(--bg); color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.5; overflow: hidden; overscroll-behavior: none; touch-action: manipulation;
  }
  .scroll {
    height: 100%; overflow: auto; overscroll-behavior: none;
    -webkit-overflow-scrolling: touch; touch-action: pan-y;
  }
  a:focus-visible, .btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; border-radius: 6px; }

  .glow { position: fixed; border-radius: 50%; filter: blur(110px); pointer-events: none; z-index: 0; }
  .glow--primary { width: 560px; height: 560px; top: -220px; right: -160px; background: var(--primary); opacity: .22; }
  .glow--sky { width: 460px; height: 460px; bottom: -200px; left: -160px; background: var(--sky); opacity: .16; }
  .grain {
    position: fixed; inset: 0; pointer-events: none; z-index: 2; opacity: .045;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='4' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='.55'/></svg>");
  }
  .wrap { position: relative; z-index: 1; max-width: 1120px; margin: 0 auto; padding: 0 24px 88px; }

  header {
    display: flex; align-items: center; gap: 12px; padding: 22px 0 0;
    position: sticky; top: 0; z-index: 4;
    background: linear-gradient(180deg, var(--bg) 70%, transparent);
  }
  .mark {
    width: 36px; height: 36px; border-radius: 12px; display: grid; place-items: center;
    background: linear-gradient(140deg, var(--primary), var(--sky)); color: #10231c;
    font-size: 18px; flex: none; box-shadow: 0 8px 24px rgba(52, 211, 153, .28);
  }
  .brand { font-size: 18px; font-weight: 700; letter-spacing: -.3px; }
  .brand span { color: var(--primary); }
  header .spacer { flex: 1; }
  header a { color: var(--muted); text-decoration: none; font-size: 14px; font-weight: 500; }
  header a:hover { color: var(--fg); }

  .hero { display: grid; grid-template-columns: minmax(0, 1.05fr) 340px; gap: 64px; align-items: center; padding: 72px 0 12px; }
  .eyebrow {
    margin: 0 0 16px; font-size: 12px; letter-spacing: 2px; text-transform: uppercase;
    color: var(--primary); font-weight: 600;
  }
  .hero h1 { margin: 0 0 20px; font-size: clamp(40px, 6.4vw, 64px); line-height: 1.02; letter-spacing: -1.8px; font-weight: 800; }
  .hero h1 em { font-style: normal; background: linear-gradient(120deg, var(--primary), var(--sky)); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .hero p { margin: 0 0 12px; font-size: clamp(16px, 2.2vw, 19px); color: var(--muted); max-width: 46ch; }
  .hero .note { font-size: 14px; }

  .actions { display: flex; flex-wrap: wrap; gap: 12px; margin: 32px 0 0; }
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 15px 24px; border-radius: 999px;
    font-size: 15px; font-weight: 600; text-decoration: none; transition: transform .15s ease, box-shadow .15s ease;
  }
  .btn:hover { transform: translateY(-1px); }
  .btn--primary { background: var(--primary); color: #0d2119; box-shadow: 0 14px 36px rgba(52, 211, 153, .28); }
  .btn--ghost { border: 1px solid var(--border); color: var(--fg); background: rgba(255,255,255,.04); }

  .stats { display: flex; flex-wrap: wrap; gap: 12px; margin: 40px 0 0; }
  .stat {
    flex: 1 1 120px; padding: 18px 18px 16px; border-radius: 18px; border: 1px solid var(--border);
    background: linear-gradient(160deg, rgba(255,255,255,.05), rgba(255,255,255,.012));
  }
  .stat b { display: block; font-size: 28px; line-height: 1.1; letter-spacing: -1.2px; }
  .stat small { display: block; margin-top: 4px; font-size: 11px; letter-spacing: 1.2px; text-transform: uppercase; color: var(--muted); }

  /* Макет карточки артиста, не альбома: круглое фото, имя, цифры. */
  .phone {
    width: 100%; max-width: 340px; margin: 0 auto; padding: 11px; border-radius: 42px;
    border: 1px solid rgba(255,255,255,.12);
    background: linear-gradient(170deg, rgba(255,255,255,.12), rgba(255,255,255,.02));
    box-shadow: 0 48px 90px rgba(0,0,0,.58);
  }
  .screen { border-radius: 32px; background: var(--bg); overflow: hidden; }
  .screen__stage {
    position: relative; display: flex; flex-direction: column; align-items: center;
    padding: 44px 20px 22px; min-height: 360px; overflow: hidden;
  }
  .screen__blur, .screen__fill {
    position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: cover; filter: blur(34px) saturate(.6); transform: scale(1.28);
    background: #14151c;
  }
  .screen__veil {
    position: absolute; inset: 0;
    background:
      radial-gradient(ellipse 70% 55% at 50% 32%, transparent 0%, rgba(9,10,15,.35) 55%, var(--bg) 100%),
      linear-gradient(180deg, rgba(9,10,15,.25) 0%, rgba(9,10,15,.6) 62%, var(--bg) 100%);
  }
  .screen__portrait {
    position: relative; z-index: 1;
    width: 168px; height: 168px; border-radius: 50%; object-fit: cover; object-position: center top;
    display: block; flex: none; border: 0; outline: none; box-shadow: none;
    background: #17181f;
  }
  .screen__portrait--empty { display: grid; place-items: center; font-size: 64px; color: #6f6f7a; }
  .screen__caption { position: relative; z-index: 1; text-align: center; margin-top: 18px; }
  .screen__caption .who { font-size: 10px; letter-spacing: 1.8px; text-transform: uppercase; color: var(--muted); font-weight: 600; }
  .screen__caption h3 { margin: 6px 0 4px; font-size: 24px; letter-spacing: -.5px; }
  .screen__caption p { margin: 0; font-size: 12px; color: var(--muted); }
  .update {
    margin: 28px 0 0; padding: 14px 18px; border-radius: 16px;
    border: 1px solid rgba(52, 211, 153, .35); background: rgba(52, 211, 153, .1);
    font-size: 14px;
  }
  .update a { color: var(--primary); font-weight: 600; text-decoration: none; }
  .screen__body { padding: 8px 18px 22px; }
  .screen__play {
    display: flex; gap: 8px; margin-bottom: 16px;
  }
  .screen__play span {
    flex: 1; text-align: center; padding: 9px 0; border-radius: 999px; font-size: 12px; font-weight: 600;
  }
  .screen__play .go { background: var(--primary); color: #0d2119; }
  .screen__play .alt { background: rgba(255,255,255,.08); }
  .screen__track { display: flex; align-items: center; gap: 10px; padding: 7px 0; }
  .screen__track b { width: 18px; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .screen__track span { font-size: 13px; }
  .screen__track i { margin-left: auto; width: 28px; height: 4px; border-radius: 99px; background: rgba(255,255,255,.12); }

  .faces { margin: 64px 0 0; display: flex; justify-content: center; }
  .faces__row { display: flex; align-items: center; }
  .faces__row img, .faces__row .blank {
    width: 92px; height: 92px; border-radius: 50%; object-fit: cover; flex: none;
    border: 3px solid var(--bg); margin-left: -18px; background: var(--surface);
    box-shadow: 0 16px 32px rgba(0,0,0,.45);
  }
  .faces__row > :first-child { margin-left: 0; }
  .faces__row .blank { background: linear-gradient(140deg, var(--primary), var(--sky)); }

  .marquee { margin: 28px 0 0; overflow: hidden; mask-image: linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent); -webkit-mask-image: linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent); }
  .marquee__row { display: flex; gap: 14px; width: max-content; animation: drift 52s linear infinite; }
  .marquee__row + .marquee__row { margin-top: 14px; animation-duration: 68s; animation-direction: reverse; }
  .marquee__row img, .marquee__row div {
    width: 112px; height: 112px; border-radius: 18px; object-fit: cover; flex: none;
    background: var(--surface); box-shadow: 0 16px 32px rgba(0,0,0,.42);
  }
  .marquee__row img.round, .marquee__row div.round { border-radius: 50%; }
  @keyframes drift { from { transform: translateX(0); } to { transform: translateX(-50%); } }

  h2 { margin: 88px 0 22px; font-size: 13px; letter-spacing: 1.8px; text-transform: uppercase; color: var(--muted); font-weight: 600; }

  .cards { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); }
  .card {
    padding: 24px; border-radius: 20px; border: 1px solid var(--border);
    background: linear-gradient(160deg, rgba(255,255,255,.05), rgba(255,255,255,.012));
    transition: border-color .2s ease, transform .2s ease;
  }
  .card:hover { border-color: rgba(52, 211, 153, .4); transform: translateY(-2px); }
  .card .icon {
    width: 40px; height: 40px; border-radius: 13px; display: grid; place-items: center;
    background: rgba(52, 211, 153, .12); color: var(--primary);
  }
  .card h3 { margin: 14px 0 6px; font-size: 16px; }
  .card p { margin: 0; font-size: 14px; color: var(--muted); }

  ol.steps { margin: 0; padding: 0; list-style: none; counter-reset: step; display: grid; gap: 12px; }
  ol.steps li {
    counter-increment: step; position: relative; padding: 18px 20px 18px 58px; border-radius: 18px;
    border: 1px solid var(--border); background: rgba(255,255,255,.025); font-size: 15px;
  }
  ol.steps li::before {
    content: counter(step); position: absolute; left: 18px; top: 16px; width: 26px; height: 26px;
    border-radius: 9px; display: grid; place-items: center; font-size: 13px; font-weight: 700;
    background: var(--primary); color: #0d2119;
  }
  ol.steps small { display: block; margin-top: 4px; color: var(--muted); font-size: 13px; }

  footer { margin: 88px 0 0; padding-top: 24px; border-top: 1px solid var(--border); font-size: 13px; color: var(--muted); }
  footer a { color: var(--primary); text-decoration: none; }

  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    .btn:hover, .card:hover { transform: none; }
    .marquee__row { animation: none; }
  }
  @media (max-width: 900px) {
    .hero { grid-template-columns: 1fr; gap: 44px; padding-top: 48px; }
    .phone { max-width: 300px; }
  }
  @media (max-width: 560px) {
    .btn { flex: 1 1 100%; }
    .faces__row img, .faces__row .blank { width: 72px; height: 72px; margin-left: -14px; }
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

/** Иконки рисуем контуром в один цвет: эмодзи в каждой системе свои. */
const ICON = {
  lock: '<path d="M8 10V7a4 4 0 0 1 8 0v3"/><rect x="4.5" y="10" width="15" height="10" rx="2.5"/><path d="M12 14v2"/>',
  offline: '<path d="M12 4v10"/><path d="M8.5 10.5 12 14l3.5-3.5"/><path d="M4.5 19h15"/>',
  lyrics: '<path d="M4.5 7h15"/><path d="M4.5 12h9"/><path d="M4.5 17h12"/>',
  stats: '<path d="M5 20V11"/><path d="M12 20V4"/><path d="M19 20v-6"/>',
  link: '<path d="M9.5 14.5l5-5"/><path d="M13.5 7.5H16a4 4 0 0 1 0 8h-1"/><path d="M10.5 16.5H8a4 4 0 0 1 0-8h1"/>',
  ban: '<circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/>',
};

function icon(path: string): string {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

const FEATURES = [
  {
    icon: ICON.lock,
    title: 'Файлы зашифрованы',
    text: 'Каждый трек лежит на диске под своим ключом AES-256. Без базы файлы не читаются даже с доступом к серверу.',
  },
  {
    icon: ICON.offline,
    title: 'Работает без сети',
    text: 'Скачанные треки, обложки и лайки остаются под рукой в самолёте и в метро.',
  },
  {
    icon: ICON.lyrics,
    title: 'Текст за песней',
    text: 'Строка, которая звучит, подсвечивается сама. Метки времени можно поставить сколько угодно — остальное рассчитается.',
  },
  {
    icon: ICON.stats,
    title: 'Статистика прослушиваний',
    text: 'Любимые треки и артисты за всё время, а не «рекомендации» неизвестно откуда.',
  },
  {
    icon: ICON.link,
    title: 'Ссылки на треки и артистов',
    text: 'Карточка с фото и именем открывается из любого мессенджера — и сразу ведёт в приложение.',
  },
  {
    icon: ICON.ban,
    title: 'Ни рекламы, ни подписки',
    text: 'Ни баннеров, ни «попробуй премиум». Только музыка.',
  },
];

// GET /
router.get('/', async (req: Request, res: Response) => {
  const catalogue = await readCatalogue();
  const origin = publicOrigin(req);
  const coverUrl = (file: string) => `${origin}/files/covers/${encodeURIComponent(file)}`;
  const description = 'bipMusic — музыка, которую хочется слушать. Артисты, альбомы, текст за песней, офлайн.';

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
  const installBtn = `<a class="btn btn--primary" href="${escapeHtml(installHref)}">${install ? `Установить ${escapeHtml(install.version)}` : 'Установить на iPhone'}</a>`;
  const updateBanner = install
    ? `<div class="update">Вышла версия ${escapeHtml(install.version)}${install.notes ? ` — ${escapeHtml(install.notes)}` : ''}. <a href="${escapeHtml(install.url)}">Скачать на iPhone</a></div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover">
<title>bipMusic</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="theme-color" content="#0e0f14">
<meta property="og:type" content="website">
<meta property="og:site_name" content="bipMusic">
<meta property="og:title" content="bipMusic">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(origin)}">
${ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}">\n<meta name="twitter:card" content="summary_large_image">` : '<meta name="twitter:card" content="summary">'}
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop stop-color='%2334d399'/%3E%3Cstop offset='1' stop-color='%236aa9f0'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='32' height='32' rx='10' fill='url(%23g)'/%3E%3Ctext x='16' y='23' text-anchor='middle' font-size='18' font-family='-apple-system,BlinkMacSystemFont,sans-serif' fill='%2310231c'%3E%E2%99%AA%3C/text%3E%3C/svg%3E">
${STYLE}
</head>
<body>
<div class="scroll">
<div class="glow glow--primary"></div>
<div class="glow glow--sky"></div>
<div class="grain"></div>

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
        <p class="eyebrow">bipMusic</p>
        <h1>Музыка, которую <em>хочется слушать</em></h1>
        <p>Артисты, альбомы и текст, который идёт за песней. Офлайн — с тобой, даже без сети.</p>
        <div class="actions">
          ${installBtn}
          <a class="btn btn--ghost" href="${APP_SCHEME}://">Открыть приложение</a>
        </div>
        ${stats}
        ${updateBanner}
      </div>

      <div class="phone" aria-hidden="true">
        <div class="screen">
          <div class="screen__stage">
            ${screenHero}
            <div class="screen__caption">
              <div class="who">артист</div>
              <h3>${escapeHtml(mockName)}</h3>
              <p>${escapeHtml(mockStats)}</p>
            </div>
          </div>
          <div class="screen__body">
            <div class="screen__play"><span class="go">Слушать</span><span class="alt">Перемешать</span></div>
            <div class="screen__track"><b>1</b><span>трек из альбома</span><i></i></div>
            <div class="screen__track"><b>2</b><span>ещё один трек</span><i></i></div>
            <div class="screen__track"><b>3</b><span>и следующий</span><i></i></div>
          </div>
        </div>
      </div>
    </section>

    ${facesHtml}
    ${marquee}

    <h2>Что внутри</h2>
    <div class="cards">
      ${FEATURES.map(
        (f) => `<div class="card">
        <div class="icon">${icon(f.icon)}</div>
        <h3>${escapeHtml(f.title)}</h3>
        <p>${escapeHtml(f.text)}</p>
      </div>`
      ).join('\n      ')}
    </div>

    <h2 id="app">Приложение</h2>
    <ol class="steps">
      <li>Открой эту страницу на iPhone в Safari.<small>Из других браузеров установка не проходит — так устроен iOS.</small></li>
      <li>Нажми «Установить» и подтверди загрузку.<small>${install ? `Сейчас на сайте версия ${escapeHtml(install.version)}.` : 'Когда админ выложит сборку, кнопка появится сверху.'}</small></li>
      <li>После установки доверь разработчика в Настройках, если iOS попросит.<small>Настройки → Основные → VPN и управление устройством.</small></li>
    </ol>
  </main>

  <footer>
    bipMusic${install ? ` · версия ${escapeHtml(install.version)}` : ''} · <a href="${APP_SCHEME}://">открыть приложение</a>
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
  // Кнопка «Установить» не должна жить в Safari со старым Diawi.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.send(html);
});

function noStoreInstall(res: Response): void {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
}

function sendInstallPage(req: Request, res: Response): void {
  const release = readRelease();
  noStoreInstall(res);
  if (!release) {
    res.status(404).type('html').send('<!DOCTYPE html><html lang="ru"><meta charset="utf-8"><title>Нет сборки</title><body style="background:#090a0f;color:#f7f8fa;font-family:sans-serif;padding:40px">Сборку ещё не выложили.</body></html>');
    return;
  }
  const origin = publicOrigin(req);
  const ipa = hostedIpaFilename(release);
  const href = ipa
    ? `itms-services://?action=download-manifest&url=${encodeURIComponent(`${origin}/api/app/manifest.plist`)}`
    : (release.diawiUrl || '');
  const hint = ipa
    ? 'Открой эту страницу в Safari и нажми кнопку. Другие браузеры установку не запускают.'
    : 'Сборки на сервере нет — установка идёт через Diawi. Открой ссылку в Safari.';
  res.type('html').send(installPageHtml(release, href, hint));
}

function installPageHtml(release: AppRelease, href: string, hint: string): string {
  const button = href
    ? `<a href="${escapeHtml(href)}">Установить</a>`
    : '<p>Сборку ещё не выложили.</p>';
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Cache-Control" content="no-store">
<title>Установить bipMusic ${escapeHtml(release.version)}</title>
<meta name="theme-color" content="#090a0f">
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#090a0f; color:#f7f8fa; font-family:-apple-system,BlinkMacSystemFont,sans-serif; text-align:center; padding:32px; }
  a { display:inline-block; margin-top:24px; padding:14px 28px; border-radius:999px; background:#34d399; color:#10231c; font-weight:700; text-decoration:none; }
  p { color:#9ea4b0; max-width:36ch; margin:12px auto 0; }
</style>
</head>
<body>
  <div>
    <h1>bipMusic ${escapeHtml(release.version)}</h1>
    <p>${escapeHtml(hint)}</p>
    ${button}
  </div>
</body>
</html>`;
}

/** Старый путь. Редиректа на Diawi больше нет — Safari кэшировал 303 и открывал прошлый билд. */
router.get('/app', sendInstallPage);

/** Новая страница установки: Safari на ней ещё не держал редирект. */
router.get('/install', sendInstallPage);

export default router;
