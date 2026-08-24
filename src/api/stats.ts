import express, { Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { prisma } from '../db.js';
import { stripCryptoFields } from '../utils/stripCrypto.js';

const router = express.Router();

// GET /api/stats/plays
router.get('/plays', authenticate, async (req: AuthRequest, res: Response) => {
  const plays = await prisma.trackPlay.findMany({
    where: { userId: req.userId },
    include: {
      track: { include: { artist: true } }
    },
    orderBy: { playedAt: 'desc' },
    take: 100
  });

  res.json({ data: stripCryptoFields(plays) });
});

// GET /api/stats/top-artists
router.get('/top-artists', authenticate, async (req: AuthRequest, res: Response) => {
  const limit = Math.min(50, parseInt(req.query.limit as string) || 10);

  const topArtists = await prisma.trackPlay.groupBy({
    by: ['trackId'],
    where: { userId: req.userId },
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
    take: limit * 2 // Get more to avoid duplicates after grouping by artist
  });

  // Map to artists
  const artistCounts = new Map<string, number>();

  for (const play of topArtists) {
    const track = await prisma.track.findUnique({
      where: { id: play.trackId },
      select: { artistId: true }
    });

    if (track) {
      const current = artistCounts.get(track.artistId) || 0;
      artistCounts.set(track.artistId, current + play._count.id);
    }
  }

  const sorted = Array.from(artistCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  const artists = await Promise.all(
    sorted.map(([artistId, count]) =>
      prisma.artist.findUnique({ where: { id: artistId } }).then(artist => ({
        artist,
        playCount: count
      }))
    )
  );

  res.json({ data: artists });
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

  const tracks = await Promise.all(
    topTracks.map(({ trackId, _count }) =>
      prisma.track.findUnique({
        where: { id: trackId },
        include: { artist: true }
      }).then(track => ({
        track,
        playCount: _count.id
      }))
    )
  );

  res.json({ data: stripCryptoFields(tracks) });
});

// POST /api/stats/play
router.post('/play', authenticate, async (req: AuthRequest, res: Response) => {
  const { trackId, durationListened } = req.body;

  const play = await prisma.trackPlay.create({
    data: {
      userId: req.userId!,
      trackId,
      durationListened: durationListened || 0
    }
  });

  // Increment play count
  await prisma.track.update({
    where: { id: trackId },
    data: { playCount: { increment: 1 } }
  });

  res.status(201).json(play);
});

export default router;
