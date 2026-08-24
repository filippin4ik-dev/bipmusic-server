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

// GET /api/playlists
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  const playlists = await prisma.playlist.findMany({
    where: { userId: req.userId },
    include: { tracks: true },
    orderBy: { createdAt: 'desc' }
  });

  res.json({ data: stripCryptoFields(playlists) });
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
    include: {
      tracks: {
        include: { track: { include: trackInclude } },
        orderBy: { position: 'asc' }
      }
    }
  });

  if (!playlist) {
    return res.status(404).json({ error: 'Playlist not found' });
  }

  if (playlist.userId !== req.userId && !playlist.isPublic) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const serialized = {
    ...playlist,
    tracks: playlist.tracks.map((pt) => ({
      ...pt,
      track: pt.track ? serializeTrack(pt.track) : pt.track,
    })),
  };

  res.json(stripCryptoFields(serialized));
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
