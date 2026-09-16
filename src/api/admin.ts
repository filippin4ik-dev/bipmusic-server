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
  albumDetailInclude,
  serializeTrack,
  serializeTracks,
  serializeAlbum,
  parseFeatArtistIds,
  getAlbumFeatArtistIds,
  syncTrackFeatArtists,
  syncAlbumFeatArtists,
} from '../utils/trackSerialize.js';
import {
  appDir,
  hostedIpaFilename,
  publicRelease,
  readRelease,
  writeRelease,
  type AppRelease,
} from '../services/appRelease.js';

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

const LYRICS_MAX_CHARS = 20000;

/**
 * Текст песни как его прислала админка. Формат (обычный текст или LRC с метками
 * времени) распознаёт клиент, поэтому здесь только приведение к единым переводам
 * строк и защита от гигантской вставки. Пустая строка = «убрать текст».
 */
function normalizeLyrics(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (!text) return null;
  return text.slice(0, LYRICS_MAX_CHARS);
}

const BIO_MAX_CHARS = 4000;

/** Биография артиста: пустая строка означает «убрать описание». */
function normalizeBio(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (!text) return null;
  return text.slice(0, BIO_MAX_CHARS);
}

function safeUnlink(p: string) {
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}

/**
 * Заносит текущее главное фото артиста в галерею, если его там ещё нет.
 *
 * У артистов, заведённых до галереи, фото живёт только в `Artist.imageUrl`.
 * Без этого шага такой файл остался бы никому не известен: галерея про него не
 * знает, удалить его из админки нельзя, а при замене главного фото он бы просто
 * потерялся на диске.
 */
async function ensurePrimaryInGallery(artistId: string, imageUrl: string | null) {
  if (!imageUrl) return;
  const existing = await prisma.artistPhoto.findUnique({
    where: { artistId_imageUrl: { artistId, imageUrl } },
  });
  if (existing) return;
  const last = await prisma.artistPhoto.findFirst({
    where: { artistId },
    orderBy: { position: 'desc' },
  });
  await prisma.artistPhoto.create({
    data: { artistId, imageUrl, position: (last?.position ?? -1) + 1 },
  });
}

/** Файл обложки удаляем только когда на него больше никто не ссылается. */
async function unlinkPhotoIfUnused(imageUrl: string) {
  const [inGallery, asPrimary, onAlbums, onTracks] = await Promise.all([
    prisma.artistPhoto.count({ where: { imageUrl } }),
    prisma.artist.count({ where: { imageUrl } }),
    prisma.album.count({ where: { coverUrl: imageUrl } }),
    prisma.track.count({ where: { coverUrl: imageUrl } }),
  ]);
  if (inGallery + asPrimary + onAlbums + onTracks === 0) {
    safeUnlink(path.resolve(COVERS_DIR, imageUrl));
  }
}

async function artistWithPhotos(artistId: string) {
  return prisma.artist.findUnique({
    where: { id: artistId },
    include: { photos: { orderBy: { position: 'asc' } } },
  });
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
    include: {
      albums: true,
      photos: { orderBy: { position: 'asc' } },
      _count: { select: { tracks: true } },
    },
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
  const data: Record<string, unknown> = {};
  if (name !== undefined) data.name = String(name).trim();
  if (bio !== undefined) data.bio = normalizeBio(bio);

  await prisma.artist.update({ where: { id: req.params.id }, data });
  const artist = await artistWithPhotos(req.params.id);
  if (!artist) return res.status(404).json({ error: 'Artist not found' });
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
  const artist = await prisma.artist.findUnique({
    where: { id: req.params.id },
    include: { photos: true },
  });
  await prisma.track.deleteMany({ where: { artistId: req.params.id } });
  await prisma.album.deleteMany({ where: { artistId: req.params.id } });
  await prisma.artist.delete({ where: { id: req.params.id } });
  // Файлы фото подчищаем после удаления артиста: пока он в базе, проверка
  // «на файл больше никто не ссылается» находила бы его же.
  for (const url of [...(artist?.photos.map((p) => p.imageUrl) ?? []), artist?.imageUrl]) {
    if (url) await unlinkPhotoIfUnused(url);
  }
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

/**
 * Состав и порядок треков альбома: `{ trackIds: [...] }`.
 *
 * Список целиком заменяет текущий: чего нет в массиве — выходит из альбома,
 * что есть — входит с номерами 1..N. Так из админки можно и собрать альбом,
 * и переставить треки одним сохранением.
 */
router.put('/albums/:id/tracks', requireAdmin, async (req: AuthRequest, res: Response) => {
  if (!Array.isArray(req.body?.trackIds)) {
    return res.status(400).json({ error: 'trackIds is required' });
  }
  const raw = Array.isArray(req.body.trackIds) ? req.body.trackIds : [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const id = String(value).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  const album = await prisma.album.findUnique({ where: { id: req.params.id } });
  if (!album) return res.status(404).json({ error: 'Album not found' });

  if (ids.length) {
    const found = await prisma.track.findMany({ where: { id: { in: ids } }, select: { id: true } });
    if (found.length !== ids.length) {
      return res.status(400).json({ error: 'В списке есть неизвестные треки' });
    }
  }

  const current = await prisma.track.findMany({
    where: { albumId: album.id },
    select: { id: true },
  });
  const incoming = new Set(ids);
  const toDetach = current.map((t) => t.id).filter((id) => !incoming.has(id));

  await prisma.$transaction([
    ...toDetach.map((id) =>
      prisma.track.update({ where: { id }, data: { albumId: null, trackNumber: null } })
    ),
    ...ids.map((id, index) =>
      prisma.track.update({ where: { id }, data: { albumId: album.id, trackNumber: index + 1 } })
    ),
  ]);

  const updated = await prisma.album.findUnique({
    where: { id: album.id },
    include: albumDetailInclude,
  });
  await audit({
    userId: req.userId,
    event: 'ALBUM_TRACKS_UPDATED',
    payload: { albumId: album.id, count: ids.length },
  });
  res.json(serializeAlbum(updated!));
});

/**
 * Порядок треков в альбоме: `{ trackIds: [...] }` — как их выстроили в админке.
 *
 * Присланные треки получают номера 1..N, остальные треки альбома уезжают за
 * ними по дате загрузки. Так частичный список от устаревшего клиента не
 * обнуляет порядок у всего альбома.
 */
router.put('/albums/:id/track-order', requireAdmin, async (req: AuthRequest, res: Response) => {
  const ids: string[] = Array.isArray(req.body?.trackIds) ? req.body.trackIds.map(String) : [];
  if (!ids.length) return res.status(400).json({ error: 'trackIds is required' });

  const tracks = await prisma.track.findMany({
    where: { albumId: req.params.id },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!tracks.length) return res.status(404).json({ error: 'В альбоме нет треков' });

  const known = new Set(tracks.map((t) => t.id));
  const foreign = ids.filter((id) => !known.has(id));
  if (foreign.length) {
    return res.status(400).json({ error: 'В списке есть треки из другого альбома' });
  }

  const ordered = ids.filter((id) => known.has(id));
  const rest = tracks.map((t) => t.id).filter((id) => !ordered.includes(id));

  await prisma.$transaction(
    [...ordered, ...rest].map((id, index) =>
      prisma.track.update({ where: { id }, data: { trackNumber: index + 1 } })
    )
  );

  const album = await prisma.album.findUnique({
    where: { id: req.params.id },
    include: albumDetailInclude,
  });
  if (!album) return res.status(404).json({ error: 'Album not found' });
  await audit({
    userId: req.userId,
    event: 'ALBUM_TRACKS_REORDERED',
    payload: { albumId: req.params.id, count: ordered.length },
  });
  res.json(serializeAlbum(album));
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

// Загрузка главного фото. Прежнее не удаляем, а оставляем в галерее — раньше
// оно затиралось безвозвратно.
router.post('/artists/:id/image', requireAdmin, coverUpload.single('image'), async (req: AuthRequest, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'Фото не получено' });
  const artist = await prisma.artist.findUnique({ where: { id: req.params.id } });
  if (!artist) {
    safeUnlink(req.file.path);
    return res.status(404).json({ error: 'Artist not found' });
  }

  await ensurePrimaryInGallery(artist.id, artist.imageUrl);
  const last = await prisma.artistPhoto.findFirst({
    where: { artistId: artist.id },
    orderBy: { position: 'desc' },
  });
  await prisma.artistPhoto.create({
    data: { artistId: artist.id, imageUrl: req.file.filename, position: (last?.position ?? -1) + 1 },
  });
  await prisma.artist.update({ where: { id: artist.id }, data: { imageUrl: req.file.filename } });

  await audit({ userId: req.userId, event: 'ARTIST_UPDATED', payload: { artistId: artist.id } });
  res.status(200).json(await artistWithPhotos(artist.id));
});

// Несколько фото за раз. Первое загруженное становится главным, если главного
// ещё не было.
router.post('/artists/:id/photos', requireAdmin, coverUpload.array('photos', 12), async (req: AuthRequest, res: Response) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) return res.status(400).json({ error: 'Фото не получены' });

  const artist = await prisma.artist.findUnique({ where: { id: req.params.id } });
  if (!artist) {
    for (const file of files) safeUnlink(file.path);
    return res.status(404).json({ error: 'Artist not found' });
  }

  await ensurePrimaryInGallery(artist.id, artist.imageUrl);
  const last = await prisma.artistPhoto.findFirst({
    where: { artistId: artist.id },
    orderBy: { position: 'desc' },
  });

  let position = (last?.position ?? -1) + 1;
  for (const file of files) {
    await prisma.artistPhoto.create({
      data: { artistId: artist.id, imageUrl: file.filename, position },
    });
    position++;
  }

  if (!artist.imageUrl) {
    await prisma.artist.update({ where: { id: artist.id }, data: { imageUrl: files[0].filename } });
  }

  await audit({
    userId: req.userId,
    event: 'ARTIST_PHOTOS_ADDED',
    payload: { artistId: artist.id, count: files.length },
  });
  res.status(201).json(await artistWithPhotos(artist.id));
});

// Порядок фото в галерее. Регистрируется до `/photos/:photoId`, чтобы `order`
// не был принят за идентификатор.
router.put('/artists/:id/photos/order', requireAdmin, async (req: AuthRequest, res: Response) => {
  const ids: string[] = Array.isArray(req.body?.photoIds) ? req.body.photoIds.map(String) : [];
  if (!ids.length) return res.status(400).json({ error: 'photoIds is required' });

  const photos = await prisma.artistPhoto.findMany({ where: { artistId: req.params.id } });
  const known = new Set(photos.map((p) => p.id));
  const ordered = ids.filter((id) => known.has(id));
  const rest = photos.filter((p) => !ordered.includes(p.id)).map((p) => p.id);

  await prisma.$transaction(
    [...ordered, ...rest].map((id, index) =>
      prisma.artistPhoto.update({ where: { id }, data: { position: index } })
    )
  );

  await audit({ userId: req.userId, event: 'ARTIST_UPDATED', payload: { artistId: req.params.id } });
  res.json(await artistWithPhotos(req.params.id));
});

router.put('/artists/:id/photos/:photoId/primary', requireAdmin, async (req: AuthRequest, res: Response) => {
  const photo = await prisma.artistPhoto.findUnique({ where: { id: req.params.photoId } });
  if (!photo || photo.artistId !== req.params.id) {
    return res.status(404).json({ error: 'Photo not found' });
  }
  await prisma.artist.update({ where: { id: photo.artistId }, data: { imageUrl: photo.imageUrl } });
  await audit({
    userId: req.userId,
    event: 'ARTIST_UPDATED',
    payload: { artistId: photo.artistId, primaryPhoto: photo.id },
  });
  res.json(await artistWithPhotos(photo.artistId));
});

router.delete('/artists/:id/photos/:photoId', requireAdmin, async (req: AuthRequest, res: Response) => {
  const photo = await prisma.artistPhoto.findUnique({ where: { id: req.params.photoId } });
  if (!photo || photo.artistId !== req.params.id) {
    return res.status(404).json({ error: 'Photo not found' });
  }

  await prisma.artistPhoto.delete({ where: { id: photo.id } });

  // Удалили главное — главным становится следующее по порядку, иначе артист
  // остался бы с битой картинкой во всех списках.
  const artist = await prisma.artist.findUnique({ where: { id: photo.artistId } });
  if (artist?.imageUrl === photo.imageUrl) {
    const next = await prisma.artistPhoto.findFirst({
      where: { artistId: photo.artistId },
      orderBy: { position: 'asc' },
    });
    await prisma.artist.update({
      where: { id: photo.artistId },
      data: { imageUrl: next?.imageUrl ?? null },
    });
  }

  await unlinkPhotoIfUnused(photo.imageUrl);
  await audit({ userId: req.userId, event: 'ARTIST_UPDATED', payload: { artistId: photo.artistId } });
  res.json(await artistWithPhotos(photo.artistId));
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

    const { title, artistId, albumId, duration, lyrics } = req.body;
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
          lyrics: normalizeLyrics(lyrics),
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
  const { title, artistId, albumId, duration, lyrics } = req.body;
  await prisma.track.update({
    where: { id: req.params.id },
    data: {
      title: title?.trim(),
      artistId,
      albumId: albumId === undefined ? undefined : (albumId || null),
      duration: duration === undefined ? undefined : parseInt(String(duration), 10),
      lyrics: lyrics === undefined ? undefined : normalizeLyrics(lyrics),
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

const ipaUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, appDir()),
    filename: (_req, _file, cb) => cb(null, `upload-${Date.now()}.ipa`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, _file, cb) => cb(null, true),
});

function originOf(req: AuthRequest): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host') ?? 'bipmusic.ru'}`;
}

router.get('/app/release', requireAdmin, (_req: AuthRequest, res: Response) => {
  const release = readRelease();
  if (!release) return res.json({ data: null, diawiConfigured: Boolean(process.env.DIAWI_TOKEN?.trim()) });
  res.json({
    data: {
      ...publicRelease(release, originOf(_req)),
      ipaFilename: hostedIpaFilename(release) || release.ipaFilename,
    },
    diawiConfigured: Boolean(process.env.DIAWI_TOKEN?.trim()),
  });
});

router.post(
  '/app/release',
  requireAdmin,
  ipaUpload.single('ipa'),
  async (req: AuthRequest, res: Response) => {
    const version = String(req.body?.version || '').trim();
    const notes = String(req.body?.notes || '').trim() || null;
    const pastedDiawi = String(req.body?.diawiUrl || '').trim() || null;
    const build = parseInt(String(req.body?.build || '0'), 10) || 0;
    if (!version) {
      if (req.file) safeUnlink(req.file.path);
      return res.status(400).json({ error: 'Укажи номер версии, например 1.1' });
    }

    const previous = readRelease();
    const claimedIpa = String(req.body?.hasIpa || '') === '1';
    const dropDiawi = claimedIpa || String(req.body?.clearDiawi || '') === '1';
    const newIpa = Boolean(req.file);
    if (claimedIpa && !req.file) {
      return res.status(400).json({ error: 'IPA не дошёл до сервера. Выбери файл ещё раз.' });
    }
    let diawiUrl: string | null = null;
    let ipaFilename = previous?.ipaFilename || null;
    let diawiError: string | null = null;

    if (newIpa && req.file) {
      // Новый файл = новая сборка. Старую ссылку Diawi выкидываем всегда:
      // она ведёт на прошлый IPA, а /app из-за неё открывал Diawi вместо файла.
      diawiUrl = null;
      const safeVer = version.replace(/[^a-zA-Z0-9._-]+/g, '-') || 'build';
      const nextName = `bipmusic-${safeVer}-${build || Date.now()}.ipa`;
      const dest = path.join(appDir(), nextName);
      try {
        if (req.file.path !== dest) fs.renameSync(req.file.path, dest);
        if (previous?.ipaFilename && previous.ipaFilename !== nextName) {
          safeUnlink(path.join(appDir(), previous.ipaFilename));
        }
        if (nextName !== 'bipmusic.ipa') safeUnlink(path.join(appDir(), 'bipmusic.ipa'));
        ipaFilename = nextName;
      } catch (err) {
        if (req.file) safeUnlink(req.file.path);
        return res.status(500).json({ error: err instanceof Error ? err.message : 'Не удалось сохранить IPA' });
      }
    } else if (dropDiawi) {
      diawiUrl = null;
    } else {
      // Без нового файла: если IPA уже лежит, старый Diawi не оставляем.
      diawiUrl = pastedDiawi || (ipaFilename ? null : previous?.diawiUrl) || null;
    }

    if (!diawiUrl && !ipaFilename) {
      return res.status(400).json({ error: 'Нужен IPA или ссылка Diawi' });
    }

    const release: AppRelease = {
      version,
      build,
      notes,
      diawiUrl,
      ipaFilename,
      publishedAt: new Date().toISOString(),
    };
    writeRelease(release);
    const saved = readRelease() || release;
    if (newIpa && !hostedIpaFilename(saved)) {
      return res.status(500).json({ error: 'IPA не оказался на диске. Залей файл ещё раз.' });
    }
    await audit({
      userId: req.userId,
      event: 'APP_RELEASE_PUBLISHED',
      payload: { version, build, diawiUrl: saved.diawiUrl, ipaFilename: saved.ipaFilename, diawiError },
    });
    res.json({
      data: {
        ...publicRelease(saved, originOf(req)),
        ipaFilename: hostedIpaFilename(saved) || saved.ipaFilename,
      },
      diawiError,
    });
  }
);

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
