import express, { Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { prisma } from '../db.js';
import { trackInclude, serializeTrack } from '../utils/trackSerialize.js';

const router = express.Router();

// GET /api/stats/plays
router.get('/plays', authenticate, async (req: AuthRequest, res: Response) => {
  const plays = await prisma.trackPlay.findMany({
    where: { userId: req.userId },
    include: {
      track: { include: trackInclude }
    },
    orderBy: { playedAt: 'desc' },
    take: 100
  });

  res.json({
    data: plays.map((p) => ({
      ...p,
      track: p.track ? serializeTrack(p.track) : p.track,
    })),
  });
});

// GET /api/stats/summary
// Итоги по всей истории, а не по первой странице: клиент раньше показывал в
// карточках длину топ-листа (максимум 10), что статистикой можно назвать с трудом.
router.get('/summary', authenticate, async (req: AuthRequest, res: Response) => {
  const userId = req.userId;

  const [totalPlays, listened, playedTracks] = await Promise.all([
    prisma.trackPlay.count({ where: { userId } }),
    prisma.trackPlay.aggregate({
      where: { userId },
      _sum: { durationListened: true },
    }),
    prisma.trackPlay.findMany({
      where: { userId },
      distinct: ['trackId'],
      select: { trackId: true },
    }),
  ]);

  const trackIds = playedTracks.map((p) => p.trackId);
  const artists = trackIds.length
    ? await prisma.track.findMany({
        where: { id: { in: trackIds } },
        distinct: ['artistId'],
        select: { artistId: true },
      })
    : [];

  res.json({
    totalPlays,
    uniqueTracks: trackIds.length,
    uniqueArtists: artists.length,
    totalSeconds: listened._sum.durationListened ?? 0,
  });
});

// GET /api/stats/top-artists
router.get('/top-artists', authenticate, async (req: AuthRequest, res: Response) => {
  const limit = Math.min(50, parseInt(req.query.limit as string) || 10);

  const playsByTrack = await prisma.trackPlay.groupBy({
    by: ['trackId'],
    where: { userId: req.userId },
    _count: { id: true },
  });
  if (!playsByTrack.length) return res.json({ data: [] });

  // Один запрос на все треки вместо findUnique в цикле: иначе на длинной
  // истории прослушиваний это сотни обращений к SQLite подряд.
  const tracks = await prisma.track.findMany({
    where: { id: { in: playsByTrack.map((p) => p.trackId) } },
    select: { id: true, artistId: true },
  });
  const artistByTrack = new Map(tracks.map((t) => [t.id, t.artistId]));

  const artistCounts = new Map<string, number>();
  for (const play of playsByTrack) {
    const artistId = artistByTrack.get(play.trackId);
    if (!artistId) continue;
    artistCounts.set(artistId, (artistCounts.get(artistId) ?? 0) + play._count.id);
  }

  const sorted = [...artistCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const artistRows = await prisma.artist.findMany({
    where: { id: { in: sorted.map(([id]) => id) } },
  });
  const artistById = new Map(artistRows.map((a) => [a.id, a]));

  res.json({
    data: sorted
      .map(([artistId, playCount]) => ({ artist: artistById.get(artistId) ?? null, playCount }))
      .filter((row) => row.artist !== null),
  });
});

// GET /api/stats/top-tracks
router.get('/top-tracks', authenticate, async (req: AuthRequest, res: Response) => {
  const limit = Math.min(50, parseInt(req.query.limit as string) || 10);

  const topTracks = await prisma.trackPlay.groupBy({
    by: ['trackId'],
    where: { userId: req.userId },
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
    take: limit
  });

  const rows = await prisma.track.findMany({
    where: { id: { in: topTracks.map((t) => t.trackId) } },
    include: trackInclude,
  });
  const byId = new Map(rows.map((t) => [t.id, t]));

  res.json({
    data: topTracks
      .filter(({ trackId }) => byId.has(trackId))
      .map(({ trackId, _count }) => ({
        track: serializeTrack(byId.get(trackId)!),
        playCount: _count.id,
      })),
  });
});

// POST /api/stats/play
// Единственное место, где прослушивание попадает в статистику. Клиент
// присылает его, когда трек действительно послушали, а не когда начали
// качать файл, — поэтому /tracks/:id/stream ничего больше не считает.
router.post('/play', authenticate, async (req: AuthRequest, res: Response) => {
  const trackId = typeof req.body?.trackId === 'string' ? req.body.trackId : '';
  if (!trackId) return res.status(400).json({ error: 'trackId обязателен' });

  const track = await prisma.track.findUnique({
    where: { id: trackId },
    select: { id: true, duration: true },
  });
  if (!track) return res.status(404).json({ error: 'Track not found' });

  // Длительность из клиента — подсказка, а не истина: секунды больше самого
  // трека (или отрицательные) сломали бы сумму в /summary.
  const raw = Number(req.body?.durationListened ?? 0);
  const cap = track.duration > 0 ? track.duration : 24 * 60 * 60;
  const durationListened = Number.isFinite(raw) ? Math.min(Math.max(0, Math.round(raw)), cap) : 0;

  const play = await prisma.trackPlay.create({
    data: { userId: req.userId!, trackId, durationListened },
  });

  await prisma.track.update({
    where: { id: trackId },
    data: { playCount: { increment: 1 } },
  });

  res.status(201).json(play);
});

export default router;
