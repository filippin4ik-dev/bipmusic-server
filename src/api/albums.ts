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

// GET /api/albums
router.get('/', optional, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, parseInt(req.query.limit as string) || 20);
  const skip = (page - 1) * limit;

  const [albums, total] = await Promise.all([
    prisma.album.findMany({
      include: albumInclude,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' }
    }),
    prisma.album.count()
  ]);

  res.json({
    data: albums.map(serializeAlbum),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  });
});

// GET /api/albums/search
router.get('/search', optional, async (req, res) => {
  const q = (req.query.q as string)?.trim();
  if (!q || q.length < 2) return res.json({ data: [] });

  const albums = await prisma.album.findMany({
    where: {
      OR: [
        { title: { contains: q } },
        { artist: { name: { contains: q } } },
      ],
    },
    include: albumInclude,
    take: 50,
    orderBy: { createdAt: 'desc' },
  });

  res.json({ data: albums.map(serializeAlbum) });
});

// GET /api/albums/:id
router.get('/:id', optional, async (req, res) => {
  const album = await prisma.album.findUnique({
    where: { id: req.params.id },
    include: {
      ...albumInclude,
      tracks: { include: trackInclude, orderBy: { createdAt: 'asc' } },
    },
  });

  if (!album) {
    return res.status(404).json({ error: 'Album not found' });
  }

  res.json(serializeAlbum(album));
});

export default router;
