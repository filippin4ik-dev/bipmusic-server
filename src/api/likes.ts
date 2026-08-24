import express, { Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { prisma } from '../db.js';
import { trackInclude, serializeLikes, serializeTrack } from '../utils/trackSerialize.js';

const router = express.Router();

// GET /api/likes
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  const likes = await prisma.likedTrack.findMany({
    where: { userId: req.userId },
    include: {
      track: { include: trackInclude },
    },
    orderBy: { likedAt: 'desc' }
  });

  res.json({ data: serializeLikes(likes) });
});

// POST /api/likes/:trackId
router.post('/:trackId', authenticate, async (req: AuthRequest, res: Response) => {
  await prisma.likedTrack.upsert({
    where: {
      userId_trackId: {
        userId: req.userId!,
        trackId: req.params.trackId,
      },
    },
    update: {},
    create: {
      userId: req.userId!,
      trackId: req.params.trackId,
    },
  });

  const like = await prisma.likedTrack.findUnique({
    where: {
      userId_trackId: {
        userId: req.userId!,
        trackId: req.params.trackId,
      },
    },
    include: {
      track: { include: trackInclude },
    },
  });

  res.status(201).json(like ? { ...like, track: like.track ? serializeTrack(like.track) : like.track } : like);
});

// DELETE /api/likes/:trackId
router.delete('/:trackId', authenticate, async (req: AuthRequest, res: Response) => {
  await prisma.likedTrack.delete({
    where: {
      userId_trackId: {
        userId: req.userId!,
        trackId: req.params.trackId
      }
    }
  }).catch(() => {
    // Already deleted
  });

  res.json({ message: 'Like removed' });
});

export default router;
