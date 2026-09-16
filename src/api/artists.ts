import express from 'express';
import { optional } from '../middleware/auth.js';
import { prisma } from '../db.js';
import {
  trackInclude,
  albumInclude,
  serializeTrack,
  serializeAlbum,
  serializeTracks,
} from '../utils/trackSerialize.js';

const router = express.Router();

// GET /api/artists
router.get('/', optional, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, parseInt(req.query.limit as string) || 20);
  const skip = (page - 1) * limit;

  const [artists, total] = await Promise.all([
    prisma.artist.findMany({
      skip,
      take: limit,
      orderBy: { name: 'asc' }
    }),
    prisma.artist.count()
  ]);

  res.json({
    data: artists,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  });
});

// GET /api/artists/search
router.get('/search', optional, async (req, res) => {
  const q = (req.query.q as string)?.trim();
  if (!q || q.length < 2) return res.json({ data: [] });

  const artists = await prisma.artist.findMany({
    where: { name: { contains: q } },
    take: 50,
    orderBy: { name: 'asc' },
  });

  res.json({ data: artists });
});

// GET /api/artists/:id
router.get('/:id', optional, async (req, res) => {
  const artistId = req.params.id;

  const artist = await prisma.artist.findUnique({
    where: { id: artistId },
    include: {
      albums: { include: albumInclude },
      photos: { orderBy: { position: 'asc' } },
    },
  });

  if (!artist) {
    return res.status(404).json({ error: 'Artist not found' });
  }

  const [primaryTracks, featCredits, featAlbums] = await Promise.all([
    prisma.track.findMany({
      where: { artistId },
      include: trackInclude,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.trackArtist.findMany({
      where: { artistId, role: 'feat' },
      include: { track: { include: trackInclude } },
    }),
    prisma.album.findMany({
      where: { albumArtists: { some: { artistId, role: 'feat' } } },
      include: {
        ...albumInclude,
        tracks: { include: trackInclude, orderBy: { createdAt: 'asc' } },
      },
    }),
  ]);

  const seenTrackIds = new Set(primaryTracks.map((t) => t.id));
  const extraTracks = [];

  for (const credit of featCredits) {
    if (!seenTrackIds.has(credit.trackId)) {
      seenTrackIds.add(credit.trackId);
      extraTracks.push(credit.track);
    }
  }

  for (const album of featAlbums) {
    for (const track of album.tracks) {
      if (track.artistId !== artistId && !seenTrackIds.has(track.id)) {
        seenTrackIds.add(track.id);
        extraTracks.push(track);
      }
    }
  }

  const tracks = [...primaryTracks, ...extraTracks];

  const primaryAlbumIds = new Set(artist.albums.map((a) => a.id));
  const featOnlyAlbums = featAlbums.filter((a) => !primaryAlbumIds.has(a.id));
  const albums = [...artist.albums, ...featOnlyAlbums];

  // Цифры для шапки карточки. Считаем по уже загруженным трекам, чтобы не
  // ходить в базу ещё раз.
  const stats = {
    trackCount: tracks.length,
    albumCount: albums.length,
    totalPlays: tracks.reduce((sum, t) => sum + (t.playCount ?? 0), 0),
  };

  res.json({
    ...artist,
    albums: albums.map(serializeAlbum),
    tracks: serializeTracks(tracks),
    stats,
  });
});

export default router;
