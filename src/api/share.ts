import express, { Request, Response } from 'express';
import { prisma } from '../db.js';

/**
 * Публичная страница трека для ссылок из приложения: https://<домен>/t/<id>.
 *
 * Мессенджеры показывают по ней превью (og-теги), а человек попадает на кнопку
 * «Открыть в приложении», которая уводит в bpmz://track/<id>. Universal Links не
 * используем намеренно: они требуют apple-app-site-association и entitlement, а
 * приложение раздаётся не через App Store.
 *
 * Данные трека здесь не секретные — только название, артист и обложка; ни
 * файла, ни ключа расшифровки страница не отдаёт.
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

function publicOrigin(req: Request): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  // `trust proxy` включён, поэтому req.protocol учитывает X-Forwarded-Proto от Caddy.
  return `${req.protocol}://${req.get('host') ?? 'bipmusic.ru'}`;
}

function page(body: { title: string; content: string }): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>${escapeHtml(body.title)}</title>
${body.content}
</html>`;
}

const STYLE = `<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; scrollbar-width: none; -ms-overflow-style: none; }
  *::-webkit-scrollbar { display: none; width: 0; height: 0; }
  html, body {
    margin: 0; height: 100%; background: #131318; color: #f7f7f8;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    overflow: hidden; overscroll-behavior: none; touch-action: manipulation;
    -webkit-text-size-adjust: 100%;
  }
  body { display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; }
  .card { width: 100%; max-width: 340px; }
  .cover {
    width: 240px; height: 240px; margin: 0 auto 24px; border-radius: 16px;
    object-fit: cover; display: block; background: #23232b;
    box-shadow: 0 18px 40px rgba(0,0,0,.45);
  }
  .cover--empty { display: flex; align-items: center; justify-content: center; font-size: 64px; }
  h1 { margin: 0 0 6px; font-size: 22px; line-height: 1.25; }
  .artist { margin: 0 0 4px; font-size: 15px; color: #a1a1ac; }
  .album { margin: 0; font-size: 13px; color: #6f6f7a; }
  .open {
    display: block; margin: 28px 0 0; padding: 15px 20px; border-radius: 12px;
    background: #34d399; color: #10231c; font-size: 16px; font-weight: 600;
    text-decoration: none;
  }
  @media (min-width: 800px) {
    .cover { width: 280px; height: 280px; }
  }
  @media (max-width: 420px) {
    .cover { width: min(72vw, 240px); height: min(72vw, 240px); }
  }
</style>`;

// GET /t/:trackId
router.get('/:trackId', async (req: Request, res: Response) => {
  const track = await prisma.track.findUnique({
    where: { id: req.params.trackId },
    include: { artist: true, album: true },
  });

  res.type('html');

  if (!track) {
    res.status(404).send(
      page({
        title: 'Трек не найден — bipMusic',
        content: `${STYLE}
<body><div class="card">
  <div class="cover cover--empty">🎵</div>
  <h1>Трек не найден</h1>
  <p class="artist">Возможно, его удалили или ссылка неполная.</p>
</div></body>`,
      })
    );
    return;
  }

  const origin = publicOrigin(req);
  const deepLink = `${APP_SCHEME}://track/${track.id}`;
  const title = track.title;
  const artist = track.artist?.name ?? 'Неизвестный артист';
  const album = track.album?.title ?? null;
  // Обложка альбома приоритетнее своей — та же логика, что в serializeTrack.
  const coverFile = track.album?.coverUrl || track.coverUrl;
  const coverUrl = coverFile ? `${origin}/files/covers/${encodeURIComponent(coverFile)}` : null;

  const meta = [
    `<meta property="og:type" content="music.song">`,
    `<meta property="og:site_name" content="bipMusic">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(artist)}">`,
    `<meta property="og:url" content="${escapeHtml(`${origin}/t/${track.id}`)}">`,
    coverUrl ? `<meta property="og:image" content="${escapeHtml(coverUrl)}">` : '',
    `<meta name="twitter:card" content="${coverUrl ? 'summary_large_image' : 'summary'}">`,
    `<meta name="theme-color" content="#131318">`,
  ]
    .filter(Boolean)
    .join('\n');

  const coverTag = coverUrl
    ? `<img class="cover" src="${escapeHtml(coverUrl)}" alt="">`
    : `<div class="cover cover--empty">🎵</div>`;

  res.send(
    page({
      title: `${title} — ${artist}`,
      content: `${meta}
${STYLE}
<body><div class="card">
  ${coverTag}
  <h1>${escapeHtml(title)}</h1>
  <p class="artist">${escapeHtml(artist)}</p>
  ${album ? `<p class="album">${escapeHtml(album)}</p>` : ''}
  <a class="open" href="${escapeHtml(deepLink)}">Открыть в приложении</a>
</div>
<script>addEventListener('gesturestart',function(e){e.preventDefault()});addEventListener('gesturechange',function(e){e.preventDefault()});</script>
</body>`,
    })
  );
});

export default router;
