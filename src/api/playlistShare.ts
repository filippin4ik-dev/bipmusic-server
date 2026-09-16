import express, { Request, Response } from 'express';
import { prisma } from '../db.js';
import { APP_SCHEME, PREVIEW_STYLE, VIEWPORT, LOCK_SCRIPT, escapeHtml, publicOrigin, trackRows } from './sharePreview.js';

const router = express.Router();

router.get('/:playlistId', async (req: Request, res: Response) => {
  const playlist = await prisma.playlist.findUnique({
    where: { id: req.params.playlistId },
    include: {
      user: { include: { profile: true } },
      tracks: {
        orderBy: { position: 'asc' },
        include: {
          track: { include: { artist: true, album: true } },
        },
      },
    },
  });

  res.type('html');
  if (!playlist || !playlist.isPublic) {
    res.status(404).send(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="${VIEWPORT}"><title>Плейлист не найден</title>${PREVIEW_STYLE}</head><body><div class="page"><h1>Плейлист не найден</h1></div></body></html>`);
    return;
  }

  const origin = publicOrigin(req);
  const coverFile =
    playlist.coverUrl ||
    playlist.tracks.find((row) => row.track?.album?.coverUrl)?.track?.album?.coverUrl ||
    playlist.tracks.find((row) => row.track?.coverUrl)?.track?.coverUrl ||
    null;
  const coverUrl = coverFile ? `${origin}/files/covers/${encodeURIComponent(coverFile)}` : null;
  const deepLink = `${APP_SCHEME}://playlist/${playlist.id}`;
  const pageUrl = `${origin}/playlist/${playlist.id}`;
  const owner = playlist.user.profile?.nickname ? `@${playlist.user.profile.nickname}` : '';
  const tracks = playlist.tracks
    .map((row) => row.track)
    .filter((t): t is NonNullable<typeof t> => Boolean(t))
    .map((t) => ({
      title: t.title,
      duration: t.duration,
      artist: t.artist?.name ?? null,
    }));
  const stats = [owner, tracks.length ? `${tracks.length} ${tracks.length === 1 ? 'трек' : 'треков'}` : '']
    .filter(Boolean)
    .join(' · ');

  res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="${VIEWPORT}">
<title>${escapeHtml(playlist.title)} — bipMusic</title>
<meta property="og:type" content="music.playlist">
<meta property="og:site_name" content="bipMusic">
<meta property="og:title" content="${escapeHtml(playlist.title)}">
<meta property="og:description" content="${escapeHtml(stats || 'Плейлист в bipMusic')}">
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
      <h1>${escapeHtml(playlist.title)}</h1>
      ${playlist.description ? `<p class="sub">${escapeHtml(playlist.description)}</p>` : ''}
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
