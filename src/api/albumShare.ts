import express, { Request, Response } from 'express';
import { prisma } from '../db.js';
import { APP_SCHEME, PREVIEW_STYLE, VIEWPORT, LOCK_SCRIPT, escapeHtml, publicOrigin, trackRows } from './sharePreview.js';

const router = express.Router();

router.get('/:albumId', async (req: Request, res: Response) => {
  const album = await prisma.album.findUnique({
    where: { id: req.params.albumId },
    include: {
      artist: true,
      tracks: { include: { artist: true } },
    },
  });

  res.type('html');
  if (!album) {
    res.status(404).send(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="${VIEWPORT}"><title>Альбом не найден</title>${PREVIEW_STYLE}</head><body><div class="page"><h1>Альбом не найден</h1></div></body></html>`);
    return;
  }

  const origin = publicOrigin(req);
  const coverFile = album.coverUrl;
  const coverUrl = coverFile ? `${origin}/files/covers/${encodeURIComponent(coverFile)}` : null;
  const deepLink = `${APP_SCHEME}://album/${album.id}`;
  const pageUrl = `${origin}/album/${album.id}`;
  const artistName = album.artist?.name ?? '';
  const tracks = [...album.tracks]
    .sort((a, b) => {
      const left = typeof a.trackNumber === 'number' ? a.trackNumber : Number.MAX_SAFE_INTEGER;
      const right = typeof b.trackNumber === 'number' ? b.trackNumber : Number.MAX_SAFE_INTEGER;
      if (left !== right) return left - right;
      return a.createdAt.getTime() - b.createdAt.getTime();
    })
    .map((t) => ({
      title: t.title,
      duration: t.duration,
      artist: t.artist?.name ?? artistName,
    }));
  const stats = [
    artistName,
    album.year ? String(album.year) : '',
    tracks.length ? `${tracks.length} ${tracks.length === 1 ? 'трек' : 'треков'}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="${VIEWPORT}">
<title>${escapeHtml(album.title)} — ${escapeHtml(artistName || 'bipMusic')}</title>
<meta property="og:type" content="music.album">
<meta property="og:site_name" content="bipMusic">
<meta property="og:title" content="${escapeHtml(album.title)}">
<meta property="og:description" content="${escapeHtml(stats || 'Альбом в bipMusic')}">
<meta property="og:url" content="${escapeHtml(pageUrl)}">
${coverUrl ? `<meta property="og:image" content="${escapeHtml(coverUrl)}">` : ''}
<meta name="twitter:card" content="${coverUrl ? 'summary_large_image' : 'summary'}">
<meta name="theme-color" content="#090a0f">
${PREVIEW_STYLE}
</head>
<body>
${coverUrl ? `<div class="bg" style="background-image:url('${escapeHtml(coverUrl)}')"></div>` : ''}
<div class="veil"></div>
<div class="page">
  <div class="hero">
    ${coverUrl ? `<img class="cover" src="${escapeHtml(coverUrl)}" alt="">` : `<div class="cover cover--empty">♪</div>`}
    <div class="meta">
      <h1>${escapeHtml(album.title)}</h1>
      ${artistName ? `<p class="sub">${escapeHtml(artistName)}</p>` : ''}
      <p class="stats">${escapeHtml(stats)}</p>
    </div>
  </div>
  ${trackRows(tracks)}
  <a class="open" href="${escapeHtml(deepLink)}">Открыть</a>
</div>
${LOCK_SCRIPT}
</body>
</html>`);
});

export default router;
