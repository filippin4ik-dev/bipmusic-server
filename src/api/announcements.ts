import express, { Response } from 'express';
import { authenticate, requireApproved, AuthRequest } from '../middleware/auth.js';
import { prisma } from '../db.js';

const router = express.Router();

router.get('/', authenticate, requireApproved, async (_req: AuthRequest, res: Response) => {
  const data = await prisma.announcement.findMany({
    orderBy: { createdAt: 'desc' },
    take: 30,
  });
  res.json({ data });
});

router.get('/latest', authenticate, requireApproved, async (_req: AuthRequest, res: Response) => {
  const announcement = await prisma.announcement.findFirst({
    orderBy: { createdAt: 'desc' },
  });
  res.json({ announcement });
});

export default router;
