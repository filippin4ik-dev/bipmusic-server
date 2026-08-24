import express from 'express';
import path from 'path';
import fs from 'fs';
import { authenticate, optional, AuthRequest, requireApproved } from '../middleware/auth.js';
import { prisma } from '../db.js';
import { keyLimiter } from '../middleware/rateLimits.js';
import { trackInclude, serializeTrack, serializeTracks } from '../utils/trackSerialize.js';

const router = express.Router();

const TRACKS_DIR = path.resolve(process.env.TRACKS_DIR || './data/tracks');

const KEY_GRANTS_LIMIT_PER_USER_PER_MIN = 60;

function clientIp(req: express.Request): string | undefined {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0].trim();
  return req.ip;
}

// GET /api/tracks
router.get('/', optional, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(500, parseInt(req.query.limit as string) || 20);
  const skip = (page - 1) * limit;

  const [tracks, total] = await Promise.all([
    prisma.track.findMany({
      include: trackInclude,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.track.count(),
  ]);

  res.json({
    data: serializeTracks(tracks),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

// GET /api/tracks/search
router.get('/search', optional, async (req, res) => {
  const q = (req.query.q as string)?.trim();
  if (!q || q.length < 2) return res.json({ data: [] });

  const tracks = await prisma.track.findMany({
    where: {
      OR: [
        { title: { contains: q } },
        { artist: { name: { contains: q } } },
        {
          trackArtists: {
            some: { role: 'feat', artist: { name: { contains: q } } },
          },
        },
      ],
    },
    include: trackInclude,
    take: 50,
  });

  res.json({ data: serializeTracks(tracks) });
});

// GET /api/tracks/:id
router.get('/:id', optional, async (req, res) => {
  const track = await prisma.track.findUnique({
    where: { id: req.params.id },
    include: trackInclude,
  });
  if (!track) return res.status(404).json({ error: 'Track not found' });

  res.json(serializeTrack(track));
});

// GET /api/tracks/:id/key
// Returns the AES-256-CTR key + nonce so the client can decrypt the ciphertext.
// Rate-limited per IP (express-rate-limit) AND per-user (DB key_grants).
router.get('/:id/key', authenticate, requireApproved, keyLimiter, async (req: AuthRequest, res) => {
  const trackId = req.params.id;
  const track = await prisma.track.findUnique({ where: { id: trackId } });
  if (!track) {
    console.error(`[key] track not found id=${trackId} user=${req.userId}`);
    return res.status(404).json({ error: 'Track not found' });
  }
  if (!track.encrypted || !track.encKey || !track.encNonce) {
    console.error(`[key] not encrypted id=${trackId} user=${req.userId}`);
    return res.status(409).json({ error: 'Track is not encrypted' });
  }

  // Per-user rate limit on key handouts (defense against scraping).
  const since = new Date(Date.now() - 60 * 1000);
  const recentGrants = await prisma.keyGrant.count({
    where: { userId: req.userId!, grantedAt: { gte: since } },
  });
  if (recentGrants >= KEY_GRANTS_LIMIT_PER_USER_PER_MIN) {
    return res.status(429).json({ error: 'Слишком много запросов ключей' });
  }

  await prisma.keyGrant.create({
    data: { userId: req.userId!, trackId: track.id, ip: clientIp(req) },
  });

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.json({
    keyHex: track.encKey,
    nonceHex: track.encNonce,
    algorithm: 'AES-256-CTR',
  });
});

// GET /api/tracks/:id/stream
// For encrypted tracks: returns ciphertext bytes (client decrypts).
// For legacy unencrypted: returns plaintext.
// Supports HTTP Range requests in both cases.
router.get('/:id/stream', authenticate, requireApproved, async (req: AuthRequest, res) => {
  const trackId = req.params.id;
  const track = await prisma.track.findUnique({ where: { id: trackId } });
  if (!track) {
    console.error(`[stream] track not found id=${trackId} user=${req.userId}`);
    return res.status(404).json({ error: 'Track not found' });
  }

  const filePath = path.resolve(TRACKS_DIR, track.filePath);
  if (!fs.existsSync(filePath)) {
    console.error(
      `[stream] file missing id=${trackId} path=${track.filePath} resolved=${filePath} user=${req.userId}`
    );
    return res.status(404).json({ error: 'Audio file not found on disk' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  if (fileSize === 0) {
    console.error(`[stream] empty file id=${trackId} path=${filePath} user=${req.userId}`);
    return res.status(500).json({ error: 'Audio file is empty on server — please re-upload' });
  }

  console.log(
    `[stream] ok id=${trackId} title="${track.title}" bytes=${fileSize} encrypted=${track.encrypted} user=${req.userId}`
  );
  const range = req.headers.range;
  const contentType = track.encrypted ? 'application/octet-stream' : 'audio/mpeg';

  // Record play (best-effort).
  prisma.trackPlay
    .create({ data: { userId: req.userId!, trackId: track.id, durationListened: 0 } })
    .catch(() => {});
  prisma.track
    .update({ where: { id: track.id }, data: { playCount: { increment: 1 } } })
    .catch(() => {});

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

export default router;
