import express, { Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { prisma } from '../db.js';
import { z } from 'zod';
import { stripCryptoFields } from '../utils/stripCrypto.js';
import { trackInclude, serializeTrack } from '../utils/trackSerialize.js';

const router = express.Router();

const PlaylistSchema = z.object({
  title: z.string().min(1).max(100),
  description: z.string().optional(),
  isPublic: z.boolean().default(false)
});

function serializePlaylist(playlist: any) {
  return stripCryptoFields({
    ...playlist,
    tracks: playlist.tracks.map((pt: any) => ({
      ...pt,
      track: pt.track ? serializeTrack(pt.track) : pt.track,
    })),
  });
}

const playlistDetailInclude = {
  tracks: {
    include: { track: { include: trackInclude } },
    orderBy: { position: 'asc' as const },
  },
};

// GET /api/playlists
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  const playlists = await prisma.playlist.findMany({
    where: { userId: req.userId },
    include: playlistDetailInclude,
    orderBy: { createdAt: 'desc' },
  });

  res.json({ data: playlists.map((p) => serializePlaylist(p)) });
});

// POST /api/playlists
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  const data = PlaylistSchema.parse(req.body);

  const playlist = await prisma.playlist.create({
    data: {
      ...data,
      userId: req.userId!
    }
  });

  res.status(201).json(playlist);
});

// GET /api/playlists/:id
router.get('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  const playlist = await prisma.playlist.findUnique({
    where: { id: req.params.id },
    include: playlistDetailInclude,
  });

  if (!playlist) {
    return res.status(404).json({ error: 'Playlist not found' });
  }

  if (playlist.userId !== req.userId && !playlist.isPublic) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  res.json(serializePlaylist(playlist));
});

const PlaylistUpdateSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  description: z.string().nullable().optional(),
});

// PUT /api/playlists/:id
router.put('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  const data = PlaylistUpdateSchema.parse(req.body);
  if (data.title === undefined && data.description === undefined) {
    return res.status(400).json({ error: 'Нечего менять' });
  }

  const playlist = await prisma.playlist.findUnique({ where: { id: req.params.id } });
  if (!playlist || playlist.userId !== req.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const updated = await prisma.playlist.update({
    where: { id: playlist.id },
    data: {
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
    },
    include: playlistDetailInclude,
  });

  res.json(serializePlaylist(updated));
});

// DELETE /api/playlists/:id
router.delete('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  const playlist = await prisma.playlist.findUnique({ where: { id: req.params.id } });
  if (!playlist || playlist.userId !== req.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  await prisma.playlist.delete({ where: { id: playlist.id } });
  res.json({ message: 'Playlist deleted' });
});

router.post('/:id/share', authenticate, async (req: AuthRequest, res: Response) => {
  const playlist = await prisma.playlist.findUnique({ where: { id: req.params.id } });
  if (!playlist || playlist.userId !== req.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const updated = await prisma.playlist.update({
    where: { id: playlist.id },
    data: { isPublic: true },
  });
  res.json({ id: updated.id, isPublic: true });
});

/** Копия чужого публичного плейлиста в свою библиотеку. */
router.post('/:id/save', authenticate, async (req: AuthRequest, res: Response) => {
  const source = await prisma.playlist.findUnique({
    where: { id: req.params.id },
    include: { tracks: { orderBy: { position: 'asc' } } },
  });
  if (!source) return res.status(404).json({ error: 'Playlist not found' });
  if (source.userId !== req.userId && !source.isPublic) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (source.userId === req.userId) {
    return res.status(400).json({ error: 'Это уже твой плейлист' });
  }

  const copy = await prisma.playlist.create({
    data: {
      title: source.title,
      description: source.description,
      coverUrl: source.coverUrl,
      isPublic: false,
      userId: req.userId!,
      tracks: {
        create: source.tracks.map((row) => ({
          trackId: row.trackId,
          position: row.position,
        })),
      },
    },
    include: playlistDetailInclude,
  });

  res.status(201).json(serializePlaylist(copy));
});

// POST /api/playlists/:id/tracks
router.post('/:id/tracks', authenticate, async (req: AuthRequest, res: Response) => {
  const { trackId } = req.body;

  const playlist = await prisma.playlist.findUnique({
    where: { id: req.params.id }
  });

  if (!playlist || playlist.userId !== req.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const maxPosition = await prisma.playlistTrack.aggregate({
    where: { playlistId: req.params.id },
    _max: { position: true }
  });

  const newPosition = (maxPosition._max.position || 0) + 1;

  const playlistTrack = await prisma.playlistTrack.create({
    data: {
      playlistId: req.params.id,
      trackId,
      position: newPosition
    },
    include: { track: true }
  });

  res.status(201).json(stripCryptoFields(playlistTrack));
});

// DELETE /api/playlists/:id/tracks/:trackId
router.delete('/:id/tracks/:trackId', authenticate, async (req: AuthRequest, res: Response) => {
  const playlist = await prisma.playlist.findUnique({
    where: { id: req.params.id }
  });

  if (!playlist || playlist.userId !== req.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  await prisma.playlistTrack.deleteMany({
    where: {
      playlistId: req.params.id,
      trackId: req.params.trackId
    }
  });

  res.json({ message: 'Track removed' });
});

export default router;
