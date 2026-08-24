import express, { Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authenticate, requireAdmin, AuthRequest } from '../middleware/auth.js';
import { prisma } from '../db.js';
import { z } from 'zod';
import { encryptFile, generateKeyMaterial } from '../services/cryptoService.js';
import { isLikelyAudioFile } from '../services/audioValidator.js';
import { audit } from '../services/auditService.js';
import { revokeAllForUser } from '../services/refreshTokenService.js';
import {
  trackInclude,
  albumInclude,
  serializeTrack,
  serializeTracks,
  serializeAlbum,
  parseFeatArtistIds,
  getAlbumFeatArtistIds,
  syncTrackFeatArtists,
  syncAlbumFeatArtists,
} from '../utils/trackSerialize.js';

const router = express.Router();

const TRACKS_DIR = path.resolve(process.env.TRACKS_DIR || './data/tracks');
const COVERS_DIR = path.resolve(process.env.COVERS_DIR || './data/covers');
const TMP_DIR = path.resolve(process.env.TMP_DIR || './data/tmp');

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
if (!fs.existsSync(TRACKS_DIR)) fs.mkdirSync(TRACKS_DIR, { recursive: true });
if (!fs.existsSync(COVERS_DIR)) fs.mkdirSync(COVERS_DIR, { recursive: true });

const trackUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, TMP_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.mp3';
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.aac'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

const coverUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, COVERS_DIR),
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname).toLowerCase() || '.jpg');
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

const UpdateUserSchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
});

function safeUnlink(p: string) {
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}

// =====================================================================
// USERS
// =====================================================================

router.get('/users', requireAdmin, async (_req: AuthRequest, res: Response) => {
  const users = await prisma.user.findMany({
    include: { profile: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ data: users.map((u) => ({ ...u, password: undefined })) });
});

router.put('/users/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  const data = UpdateUserSchema.parse(req.body);
  const profile = await prisma.profile.update({
    where: { userId: req.params.id },
    data: { status: data.status },
  });
  // If rejecting, revoke all sessions immediately.
  if (data.status === 'REJECTED') {
    await revokeAllForUser(req.params.id);
  }
  await audit({
    userId: req.userId,
    event: data.status === 'APPROVED' ? 'USER_APPROVED' : data.status === 'REJECTED' ? 'USER_REJECTED' : 'USER_PENDING',
    payload: { targetUserId: req.params.id },
  });
  res.json(profile);
});

router.delete('/users/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  if (req.params.id === req.userId) {
    return res.status(400).json({ error: 'Нельзя удалить самого себя' });
  }
  await revokeAllForUser(req.params.id);
  await prisma.user.delete({ where: { id: req.params.id } });
  await audit({ userId: req.userId, event: 'USER_DELETED', payload: { targetUserId: req.params.id } });
  res.json({ success: true });
});

// =====================================================================
// ARTISTS
// =====================================================================

router.get('/artists', requireAdmin, async (_req: AuthRequest, res: Response) => {
  const artists = await prisma.artist.findMany({
    include: { albums: true, _count: { select: { tracks: true } } },
    orderBy: { name: 'asc' },
  });
  res.json({ data: artists });
});

router.post('/artists', requireAdmin, async (req: AuthRequest, res: Response) => {
  const { name, bio } = req.body;
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
  const artist = await prisma.artist.create({ data: { name: name.trim(), bio: bio || null } });
  await audit({ userId: req.userId, event: 'ARTIST_CREATED', payload: { artistId: artist.id, name: artist.name } });
  res.status(201).json(artist);
});

router.put('/artists/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  const { name, bio } = req.body;
  const artist = await prisma.artist.update({
    where: { id: req.params.id },
    data: { name: name?.trim(), bio: bio ?? null },
  });
  await audit({ userId: req.userId, event: 'ARTIST_UPDATED', payload: { artistId: artist.id } });
  res.json(artist);
});

router.delete('/artists/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  // Cascade: delete artist tracks (with their files) first.
  const tracks = await prisma.track.findMany({ where: { artistId: req.params.id } });
  for (const t of tracks) {
    safeUnlink(path.resolve(TRACKS_DIR, t.filePath));
    if (t.coverUrl) safeUnlink(path.resolve(COVERS_DIR, t.coverUrl));
  }
  await prisma.track.deleteMany({ where: { artistId: req.params.id } });
  await prisma.album.deleteMany({ where: { artistId: req.params.id } });
  await prisma.artist.delete({ where: { id: req.params.id } });
  await audit({ userId: req.userId, event: 'ARTIST_DELETED', payload: { artistId: req.params.id } });
  res.json({ success: true });
});

// =====================================================================
// ALBUMS
// =====================================================================

router.get('/albums', requireAdmin, async (_req: AuthRequest, res: Response) => {
  const albums = await prisma.album.findMany({
    include: { ...albumInclude, _count: { select: { tracks: true } } },
    orderBy: { title: 'asc' },
  });
  res.json({ data: albums.map(serializeAlbum) });
});

router.post('/albums', requireAdmin, async (req: AuthRequest, res: Response) => {
  const { title, artistId, year, coverUrl } = req.body;
  if (!title || !artistId) return res.status(400).json({ error: 'title and artistId are required' });
  const featArtistIds = parseFeatArtistIds(req.body.featArtistIds);
  const album = await prisma.album.create({
    data: {
      title: title.trim(),
      artistId,
      year: year ? parseInt(String(year), 10) : null,
      coverUrl: coverUrl || null,
    },
    include: albumInclude,
  });
  if (featArtistIds.length) {
    await syncAlbumFeatArtists(album.id, featArtistIds);
  }
  const full = await prisma.album.findUnique({ where: { id: album.id }, include: albumInclude });
  await audit({ userId: req.userId, event: 'ALBUM_CREATED', payload: { albumId: album.id, title: album.title } });
  res.status(201).json(serializeAlbum(full!));
});

router.put('/albums/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  const { title, artistId, year, coverUrl } = req.body;
  const data: Record<string, unknown> = {};
  if (title !== undefined) data.title = String(title).trim();
  if (artistId !== undefined) data.artistId = artistId;
  if (year !== undefined) data.year = year ? parseInt(String(year), 10) : null;
  if (coverUrl !== undefined) data.coverUrl = coverUrl || null;

  await prisma.album.update({ where: { id: req.params.id }, data });
  if (req.body.featArtistIds !== undefined) {
    await syncAlbumFeatArtists(req.params.id, parseFeatArtistIds(req.body.featArtistIds));
  }
  const updated = await prisma.album.findUnique({
    where: { id: req.params.id },
    include: albumInclude,
  });
  if (!updated) return res.status(404).json({ error: 'Album not found' });
  await audit({ userId: req.userId, event: 'ALBUM_UPDATED', payload: { albumId: req.params.id } });
  res.json(serializeAlbum(updated));
});

router.delete('/albums/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  await prisma.track.updateMany({ where: { albumId: req.params.id }, data: { albumId: null } });
  await prisma.album.delete({ where: { id: req.params.id } });
  await audit({ userId: req.userId, event: 'ALBUM_DELETED', payload: { albumId: req.params.id } });
  res.json({ success: true });
});

router.post('/albums/:id/cover', requireAdmin, coverUpload.single('cover'), async (req: AuthRequest, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'Обложка не получена' });
  const album = await prisma.album.findUnique({ where: { id: req.params.id } });
  if (!album) {
    safeUnlink(req.file.path);
    return res.status(404).json({ error: 'Album not found' });
  }
  if (album.coverUrl) {
    safeUnlink(path.resolve(COVERS_DIR, album.coverUrl));
  }
  const updated = await prisma.album.update({
    where: { id: album.id },
    data: { coverUrl: req.file.filename },
    include: { artist: true },
  });
  await audit({ userId: req.userId, event: 'ALBUM_UPDATED', payload: { albumId: album.id } });
  res.json(updated);
});

router.post('/artists/:id/image', requireAdmin, coverUpload.single('image'), async (req: AuthRequest, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'Фото не получено' });
  const artist = await prisma.artist.findUnique({ where: { id: req.params.id } });
  if (!artist) {
    safeUnlink(req.file.path);
    return res.status(404).json({ error: 'Artist not found' });
  }
  if (artist.imageUrl) {
    safeUnlink(path.resolve(COVERS_DIR, artist.imageUrl));
  }
  const updated = await prisma.artist.update({
    where: { id: artist.id },
    data: { imageUrl: req.file.filename },
  });
  await audit({ userId: req.userId, event: 'ARTIST_UPDATED', payload: { artistId: artist.id } });
  res.status(200).json(updated);
});

// =====================================================================
// TRACKS
// =====================================================================

// GET before /tracks/:id — иначе на старых Express-конфигах маршрут мог не сработать.
router.get('/tracks', requireAdmin, async (_req: AuthRequest, res: Response) => {
  const tracks = await prisma.track.findMany({
    include: trackInclude,
    orderBy: { createdAt: 'desc' },
  });
  res.json({ data: serializeTracks(tracks) });
});

/**
 * POST /api/admin/tracks/upload
 * multipart fields: audio (file), title, artistId, albumId?, duration?, cover (file, optional)
 *
 * Flow:
 *   1. Multer drops plaintext + cover into TMP/COVERS.
 *   2. Magic-byte sniff the audio (defence against renamed-executable uploads).
 *   3. Generate per-track AES-256 key + 16-byte nonce.
 *   4. Stream-encrypt plaintext → TRACKS_DIR/<name>.enc, delete plaintext.
 *   5. Persist Track with encrypted=true and key+nonce stored in DB.
 *   6. Strip key/nonce before responding.
 */
router.post(
  '/tracks/upload',
  requireAdmin,
  trackUpload.fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }]),
  async (req: AuthRequest, res: Response) => {
    const logPrefix = '[upload]';
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const audioFile = files?.audio?.[0];
    const coverFile = files?.cover?.[0];

    console.log(
      `${logPrefix} start user=${req.userId} content-type=${req.headers['content-type'] ?? 'none'} ` +
        `audioField=${audioFile ? 'yes' : 'no'} coverField=${coverFile ? 'yes' : 'no'}`
    );

    if (!audioFile) {
      console.error(`${logPrefix} fail: no audio field user=${req.userId}`);
      if (coverFile) safeUnlink(coverFile.path);
      return res.status(400).json({ error: 'Аудиофайл не получен' });
    }

    // Empty file → client bug or interrupted upload.
    let audioSize = 0;
    try { audioSize = fs.statSync(audioFile.path).size; } catch {}
    console.log(
      `${logPrefix} received audio original="${audioFile.originalname}" tmp="${audioFile.path}" bytes=${audioSize}`
    );
    if (audioSize === 0) {
      console.error(`${logPrefix} fail: empty audio user=${req.userId}`);
      safeUnlink(audioFile.path);
      if (coverFile) safeUnlink(coverFile.path);
      return res.status(400).json({ error: 'Файл пустой — повтори загрузку' });
    }

    // Magic-byte validation.
    if (!isLikelyAudioFile(audioFile.path)) {
      console.error(`${logPrefix} fail: not audio magic bytes user=${req.userId} file=${audioFile.originalname}`);
      safeUnlink(audioFile.path);
      if (coverFile) safeUnlink(coverFile.path);
      return res.status(400).json({ error: 'Файл не похож на аудио' });
    }

    const { title, artistId, albumId, duration } = req.body;
    const featArtistIds = parseFeatArtistIds(req.body.featArtistIds);
    console.log(
      `${logPrefix} meta title="${title}" artistId=${artistId} albumId=${albumId ?? 'null'} duration=${duration ?? 0}`
    );
    if (!title || !artistId) {
      console.error(`${logPrefix} fail: missing title or artistId user=${req.userId}`);
      safeUnlink(audioFile.path);
      if (coverFile) safeUnlink(coverFile.path);
      return res.status(400).json({ error: 'title and artistId are required' });
    }

    const material = generateKeyMaterial();
    const encName = `${path.basename(audioFile.filename, path.extname(audioFile.filename))}.enc`;
    const encPath = path.join(TRACKS_DIR, encName);

    try {
      await encryptFile(audioFile.path, encPath, material, { deletePlaintext: true });
      const encSize = fs.statSync(encPath).size;
      console.log(`${logPrefix} encrypted → ${encName} bytes=${encSize}`);
    } catch (e) {
      console.error(`${logPrefix} fail: encrypt error user=${req.userId}`, e);
      safeUnlink(audioFile.path);
      safeUnlink(encPath);
      if (coverFile) safeUnlink(coverFile.path);
      throw e;
    }

    const coverName = coverFile ? path.basename(coverFile.path) : null;

    let track;
    try {
      track = await prisma.track.create({
        data: {
          title: String(title).trim(),
          artistId: String(artistId),
          albumId: albumId ? String(albumId) : null,
          duration: parseInt(String(duration ?? 0), 10) || 0,
          filePath: encName,
          coverUrl: coverName,
          encrypted: true,
          encKey: material.keyHex,
          encNonce: material.nonceHex,
        },
        include: trackInclude,
      });
      let resolvedFeatIds = featArtistIds;
      if (!resolvedFeatIds.length && albumId) {
        resolvedFeatIds = await getAlbumFeatArtistIds(String(albumId));
      }
      if (resolvedFeatIds.length) {
        await syncTrackFeatArtists(track.id, resolvedFeatIds);
      }
      track = await prisma.track.findUnique({ where: { id: track.id }, include: trackInclude }) ?? track;
      console.log(
        `${logPrefix} saved track id=${track.id} title="${track.title}" filePath=${encName} user=${req.userId}`
      );
    } catch (e) {
      console.error(`${logPrefix} fail: db create user=${req.userId} artistId=${artistId}`, e);
      safeUnlink(encPath);
      if (coverFile) safeUnlink(coverFile.path);
      throw e;
    }

    await audit({
      userId: req.userId,
      event: 'TRACK_UPLOADED',
      payload: { trackId: track.id, title: track.title, encrypted: true },
    });

    res.status(201).json(serializeTrack(track));
  }
);

router.post('/tracks/:id/cover', requireAdmin, coverUpload.single('cover'), async (req: AuthRequest, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'No cover file provided' });
  const track = await prisma.track.findUnique({ where: { id: req.params.id } });
  if (!track) {
    safeUnlink(req.file.path);
    return res.status(404).json({ error: 'Track not found' });
  }
  if (track.coverUrl) {
    safeUnlink(path.resolve(COVERS_DIR, track.coverUrl));
  }
  const updated = await prisma.track.update({
    where: { id: track.id },
    data: { coverUrl: req.file.filename },
    include: trackInclude,
  });
  res.json(serializeTrack(updated));
});

router.put('/tracks/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  const { title, artistId, albumId, duration } = req.body;
  await prisma.track.update({
    where: { id: req.params.id },
    data: {
      title: title?.trim(),
      artistId,
      albumId: albumId === undefined ? undefined : (albumId || null),
      duration: duration === undefined ? undefined : parseInt(String(duration), 10),
    },
  });
  if (req.body.featArtistIds !== undefined) {
    await syncTrackFeatArtists(req.params.id, parseFeatArtistIds(req.body.featArtistIds));
  }
  const updated = await prisma.track.findUnique({
    where: { id: req.params.id },
    include: trackInclude,
  });
  if (!updated) return res.status(404).json({ error: 'Track not found' });
  await audit({ userId: req.userId, event: 'TRACK_UPDATED', payload: { trackId: req.params.id } });
  res.json(serializeTrack(updated));
});

router.delete('/tracks/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  const track = await prisma.track.findUnique({ where: { id: req.params.id } });
  if (!track) return res.status(404).json({ error: 'Track not found' });
  safeUnlink(path.resolve(TRACKS_DIR, track.filePath));
  if (track.coverUrl) safeUnlink(path.resolve(COVERS_DIR, track.coverUrl));
  await prisma.track.delete({ where: { id: track.id } });
  await audit({ userId: req.userId, event: 'TRACK_DELETED', payload: { trackId: req.params.id } });
  res.json({ success: true });
});

// =====================================================================
// AUDIT LOG (read-only, for the admin UI)
// =====================================================================

router.get('/audit', requireAdmin, async (req: AuthRequest, res: Response) => {
  const take = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const events = await prisma.auditEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take,
  });
  res.json({ data: events });
});

export default router;
