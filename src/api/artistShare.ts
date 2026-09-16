import express, { Request, Response } from 'express';
import { prisma } from '../db.js';

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
  return `${req.protocol}://${req.get('host') ?? 'bipmusic.ru'}`;
}

const STYLE = `<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; scrollbar-width: none; -ms-overflow-style: none; }
  *::-webkit-scrollbar { display: none; width: 0; height: 0; }
  html, body {
    margin: 0; height: 100%; background: #090a0f; color: #f7f8fa;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    overflow: hidden; overscroll-behavior: none; touch-action: manipulation;
    -webkit-text-size-adjust: 100%;
  }
  body { display: flex; align-items: center; justify-content: center; padding: 28px 20px; text-align: center; }
  .bg { position: fixed; inset: 0; background-size: cover; background-position: center; filter: blur(36px) saturate(1.15); opacity: .45; pointer-events: none; }
  .veil { position: fixed; inset: 0; background: linear-gradient(180deg, rgba(9,10,15,.3), #090a0f 75%); pointer-events: none; }
  .card { position: relative; z-index: 1; width: 100%; max-width: 340px; }
  .who { font-size: 11px; letter-spacing: 1.8px; text-transform: uppercase; color: #9ea4b0; font-weight: 600; }
  .portrait {
    width: 168px; height: 168px; margin: 18px auto 20px; border-radius: 50%;
    object-fit: cover; display: block; background: #17181f;
    border: 0; outline: none; box-shadow: none;
  }
  .portrait--empty { display: grid; place-items: center; font-size: 64px; }
  h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.15; letter-spacing: -.4px; }
  .bio { margin: 0 auto; max-width: 36ch; font-size: 14px; color: #9ea4b0; }
  .open {
    display: block; margin: 28px 0 0; padding: 15px 20px; border-radius: 999px;
    background: #34d399; color: #10231c; font-size: 16px; font-weight: 600;
    text-decoration: none;
  }
  @media (min-width: 800px) {
    .portrait { width: 196px; height: 196px; }
    h1 { font-size: 32px; }
  }
</style>`;

router.get('/:artistId', async (req: Request, res: Response) => {
  const artist = await prisma.artist.findUnique({
    where: { id: req.params.artistId },
    include: { photos: { orderBy: { position: 'asc' }, take: 1 } },
  });

  res.type('html');
  if (!artist) {
    res.status(404).send(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Артист не найден</title>${STYLE}</head><body><div class="card"><h1>Артист не найден</h1></div></body></html>`);
    return;
  }

  const origin = publicOrigin(req);
  const photo = artist.imageUrl || artist.photos[0]?.imageUrl || null;
  const coverUrl = photo ? `${origin}/files/covers/${encodeURIComponent(photo)}` : null;
  const deepLink = `${APP_SCHEME}://artist/${artist.id}`;
  const pageUrl = `${origin}/a/${artist.id}`;
  const bio = artist.bio?.trim() || '';

  res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>${escapeHtml(artist.name)} — bipMusic</title>
<meta property="og:type" content="profile">
<meta property="og:site_name" content="bipMusic">
<meta property="og:title" content="${escapeHtml(artist.name)}">
<meta property="og:description" content="${escapeHtml(bio || 'Артист в bipMusic')}">
<meta property="og:url" content="${escapeHtml(pageUrl)}">
${coverUrl ? `<meta property="og:image" content="${escapeHtml(coverUrl)}">` : ''}
<meta name="twitter:card" content="${coverUrl ? 'summary_large_image' : 'summary'}">
<meta name="theme-color" content="#090a0f">
${STYLE}
</head>
<body>
${coverUrl ? `<div class="bg" style="background-image:url('${escapeHtml(coverUrl)}')"></div>` : ''}
<div class="veil"></div>
<div class="card">
  <div class="who">артист</div>
  ${coverUrl ? `<img class="portrait" src="${escapeHtml(coverUrl)}" alt="">` : `<div class="portrait portrait--empty">♪</div>`}
  <h1>${escapeHtml(artist.name)}</h1>
  ${bio ? `<p class="bio">${escapeHtml(bio)}</p>` : ''}
  <a class="open" href="${escapeHtml(deepLink)}">Открыть в приложении</a>
</div>
<script>addEventListener('gesturestart',function(e){e.preventDefault()});addEventListener('gesturechange',function(e){e.preventDefault()});</script>
</body>
</html>`);
});

export default router;
