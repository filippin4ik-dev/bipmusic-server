/**
 * Массовая загрузка: админ кидает один .zip с музыкой, сервер сам его
 * распаковывает, читает теги, находит (или создаёт) артистов и альбомы,
 * шифрует файлы и заводит треки. Идёт в фоне, прогресс отдаётся по GET.
 *
 * Правила раскладки для каждого аудиофайла:
 *   1. Артист — из тега (albumartist → artist → первый из artists),
 *      иначе из структуры папок «Артист/Альбом/трек.mp3», иначе артист по
 *      умолчанию из формы. Ищем по нормализованному имени в каталоге;
 *      если не нашли и разрешено — создаём.
 *   2. Альбом — из тега album (или папка) внутри найденного артиста.
 *      Нет в каталоге — создаём с годом и обложкой из файла. Нет тега — сингл
 *      (или альбом по умолчанию, если он у того же артиста).
 *   3. Дубликаты (тот же артист + то же название) пропускаем.
 *   4. Обложка: картинка из тегов, иначе cover.jpg/folder.jpg рядом в архиве.
 *      Если у альбома обложки ещё нет — ставим и ему.
 *   5. Остальные имена в теге artist («A feat. B», «A, B») — соавторы, если
 *      такие артисты уже есть в каталоге.
 */
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import yauzl from 'yauzl';
import iconv from 'iconv-lite';
import { parseFile } from 'music-metadata';
import { prisma } from '../db.js';
import { encryptFile, generateKeyMaterial } from './cryptoService.js';
import { isLikelyAudioFile } from './audioValidator.js';
import { audit } from './auditService.js';
import { getAlbumFeatArtistIds, syncTrackFeatArtists } from '../utils/trackSerialize.js';
import { catalogKey, cleanTrackTitle, splitArtistCredits } from '../utils/trackTitle.js';

const TRACKS_DIR = path.resolve(process.env.TRACKS_DIR || './data/tracks');
const COVERS_DIR = path.resolve(process.env.COVERS_DIR || './data/covers');
const TMP_DIR = path.resolve(process.env.TMP_DIR || './data/tmp');

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.aac']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_ENTRY_BYTES = 400 * 1024 * 1024; // один трек больше 400 МБ — явно не трек
const MAX_AUDIO_FILES = 5000;
const RECENT_LIMIT = 40;

export type ArchiveImportItem = {
  file: string;
  result: 'created' | 'updated' | 'skipped' | 'failed';
  detail: string;
};

export type ArchiveImportJob = {
  status: 'running' | 'done' | 'error' | 'cancelled';
  message: string;
  archiveName: string;
  total: number;
  processed: number;
  created: number;
  /** Дубликаты, которым дописали альбом или обложку. */
  updated: number;
  skipped: number;
  failed: number;
  artistsCreated: number;
  albumsCreated: number;
  current: string | null;
  recent: ArchiveImportItem[];
  startedAt: string;
  finishedAt: string | null;
};

export type ArchiveImportOptions = {
  archivePath: string;
  archiveName: string;
  defaultArtistId: string | null;
  defaultAlbumId: string | null;
  createMissing: boolean;
  userId?: string;
};

let job: ArchiveImportJob | null = null;
let running = false;
let cancelRequested = false;

export function getArchiveImportJob(): ArchiveImportJob | null {
  return job;
}

export function isArchiveImportRunning(): boolean {
  return running;
}

export function cancelArchiveImport(): ArchiveImportJob | null {
  if (running && job) {
    cancelRequested = true;
    job.message = 'Останавливаем после текущего файла…';
  }
  return job;
}

export function startArchiveImport(opts: ArchiveImportOptions): ArchiveImportJob {
  if (running && job) {
    throw new Error('Предыдущий архив ещё разбирается. Дождись окончания или отмени его.');
  }
  cancelRequested = false;
  sweepStaleTemp(opts.archivePath);
  job = {
    status: 'running',
    message: 'Открываем архив…',
    archiveName: opts.archiveName,
    total: 0,
    processed: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    artistsCreated: 0,
    albumsCreated: 0,
    current: null,
    recent: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  running = true;
  void runImport(opts)
    .catch((err) => {
      if (job) {
        job.status = 'error';
        job.message = err instanceof Error ? err.message : 'Импорт архива не удался';
      }
    })
    .finally(() => {
      running = false;
      if (job) job.finishedAt = new Date().toISOString();
      safeUnlink(opts.archivePath);
    });
  return job;
}

// ---------------------------------------------------------------------------

function safeUnlink(p: string) {
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

function safeRmDir(p: string) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Если сервер перезапустили посреди импорта, в tmp остаются архив и папка
 * распаковки. Подчищаем всё старше 6 часов, кроме архива, который сейчас начнём.
 */
function sweepStaleTemp(keep: string) {
  try {
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(TMP_DIR)) {
      if (!/^(archive-|import-)/.test(name)) continue;
      const full = path.join(TMP_DIR, name);
      if (path.resolve(full) === path.resolve(keep)) continue;
      const stat = fs.statSync(full);
      if (stat.mtimeMs > cutoff) continue;
      if (stat.isDirectory()) safeRmDir(full);
      else safeUnlink(full);
    }
  } catch {
    /* tmp может ещё не существовать */
  }
}

function pushRecent(item: ArchiveImportItem) {
  if (!job) return;
  job.recent.unshift(item);
  if (job.recent.length > RECENT_LIMIT) job.recent.length = RECENT_LIMIT;
}

function randomName(ext: string) {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
}

/**
 * Имена в zip: с флагом UTF-8 (0x800) — уже раскодированы yauzl. Без флага
 * Windows пишет OEM-кодировку (для русской — CP866); пробуем UTF-8, затем CP866.
 */
function entryName(entry: yauzl.Entry): string {
  const utf8Flag = (entry.generalPurposeBitFlag & 0x800) !== 0;
  const hasUnicodeExtra = entry.extraFields?.some((f) => f.id === 0x7075);
  if (utf8Flag || hasUnicodeExtra) return entry.fileName;
  const raw = entry.fileNameRaw;
  if (!raw) return entry.fileName;
  const asUtf8 = raw.toString('utf8');
  if (!asUtf8.includes('\uFFFD') && /[^\x00-\x7F]/.test(asUtf8)) return asUtf8;
  if (!/[^\x00-\x7F]/.test(asUtf8)) return asUtf8; // чистый ASCII
  try {
    return iconv.decode(raw, 'cp866');
  } catch {
    return entry.fileName;
  }
}

function normalizeZipPath(name: string): string[] {
  return name
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..');
}

type ZipAudio = { entry: yauzl.Entry; parts: string[]; name: string };
type ZipImage = { entry: yauzl.Entry; dir: string; base: string };

function isJunk(parts: string[]): boolean {
  if (!parts.length) return true;
  if (parts[0] === '__MACOSX') return true;
  return parts.some((p) => p.startsWith('.') || p === 'Thumbs.db' || p === 'desktop.ini');
}

const COVER_BASENAMES = ['cover', 'folder', 'front', 'album', 'albumart', 'artwork'];

function coverScore(base: string): number {
  const lower = base.toLowerCase();
  const idx = COVER_BASENAMES.findIndex((n) => lower === n || lower.startsWith(n));
  return idx === -1 ? 100 : idx;
}

async function extractEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, dest: string) {
  const stream = await zip.openReadStreamPromise(entry);
  await pipeline(stream, fs.createWriteStream(dest));
}

// ---------------------------------------------------------------------------
// Каталог: кэш артистов/альбомов, чтобы не дёргать базу на каждый файл.

type CachedArtist = { id: string; name: string; key: string };
type CachedAlbum = { id: string; title: string; key: string; artistId: string; coverUrl: string | null };
type CachedTrack = {
  id: string;
  title: string;
  albumId: string | null;
  coverUrl: string | null;
  trackNumber: number | null;
};

class Catalog {
  artists: CachedArtist[] = [];
  albums: CachedAlbum[] = [];
  private tracks = new Map<string, Map<string, CachedTrack>>(); // artistId → catalogKey(title) → трек

  async load() {
    const [artists, albums] = await Promise.all([
      prisma.artist.findMany({ select: { id: true, name: true } }),
      prisma.album.findMany({ select: { id: true, title: true, artistId: true, coverUrl: true } }),
    ]);
    this.artists = artists.map((a) => ({ ...a, key: catalogKey(a.name) }));
    this.albums = albums.map((a) => ({ ...a, key: catalogKey(a.title) }));
  }

  findArtist(rawName: string | null | undefined): CachedArtist | null {
    if (!rawName) return null;
    const key = catalogKey(rawName);
    if (!key) return null;
    const exact = this.artists.find((a) => a.key === key);
    if (exact) return exact;
    // «Скриптонит» ↔ «Скриптонит, 104»: берём самое длинное частичное совпадение,
    // но только если ключи не слишком короткие — иначе «Ди» найдёт «Дидюля».
    if (key.length < 3) return null;
    const partial = this.artists
      .filter((a) => a.key.length >= 3 && (a.key.includes(key) || key.includes(a.key)))
      .sort((a, b) => b.key.length - a.key.length);
    return partial[0] ?? null;
  }

  async createArtist(name: string): Promise<CachedArtist> {
    const row = await prisma.artist.create({ data: { name: name.trim() } });
    const cached = { id: row.id, name: row.name, key: catalogKey(row.name) };
    this.artists.push(cached);
    return cached;
  }

  findAlbum(rawTitle: string | null | undefined, artistId: string): CachedAlbum | null {
    if (!rawTitle) return null;
    const key = catalogKey(rawTitle);
    if (!key) return null;
    const mine = this.albums.filter((a) => a.artistId === artistId);
    const exact = mine.find((a) => a.key === key);
    if (exact) return exact;
    if (key.length < 3) return null;
    return mine.find((a) => a.key.length >= 3 && (a.key.includes(key) || key.includes(a.key))) ?? null;
  }

  albumById(id: string): CachedAlbum | null {
    return this.albums.find((a) => a.id === id) ?? null;
  }

  async createAlbum(title: string, artistId: string, year: number | null, coverUrl: string | null): Promise<CachedAlbum> {
    const row = await prisma.album.create({
      data: { title: title.trim(), artistId, year, coverUrl },
    });
    const cached = { id: row.id, title: row.title, key: catalogKey(row.title), artistId, coverUrl };
    this.albums.push(cached);
    return cached;
  }

  async setAlbumCover(album: CachedAlbum, coverUrl: string) {
    await prisma.album.update({ where: { id: album.id }, data: { coverUrl } });
    album.coverUrl = coverUrl;
  }

  async findTrack(artistId: string, title: string): Promise<CachedTrack | null> {
    let byKey = this.tracks.get(artistId);
    if (!byKey) {
      const rows = await prisma.track.findMany({
        where: { artistId },
        select: { id: true, title: true, albumId: true, coverUrl: true, trackNumber: true },
      });
      byKey = new Map(rows.map((r) => [catalogKey(r.title), r]));
      this.tracks.set(artistId, byKey);
    }
    return byKey.get(catalogKey(title)) ?? null;
  }

  rememberTrack(artistId: string, track: CachedTrack) {
    const byKey = this.tracks.get(artistId) ?? new Map<string, CachedTrack>();
    byKey.set(catalogKey(track.title), track);
    this.tracks.set(artistId, byKey);
  }
}

// ---------------------------------------------------------------------------

function pictureExt(format: string | undefined): string {
  const f = (format ?? '').toLowerCase();
  if (f.includes('png')) return '.png';
  if (f.includes('webp')) return '.webp';
  return '.jpg';
}

function saveCoverBytes(data: Uint8Array, ext: string): string | null {
  if (!data || data.byteLength < 500) return null;
  fs.mkdirSync(COVERS_DIR, { recursive: true });
  const name = randomName(ext);
  fs.writeFileSync(path.join(COVERS_DIR, name), Buffer.from(data));
  return name;
}

function copyCoverFile(src: string): string | null {
  try {
    const stat = fs.statSync(src);
    if (stat.size < 500) return null;
    const name = randomName(path.extname(src).toLowerCase() || '.jpg');
    fs.copyFileSync(src, path.join(COVERS_DIR, name));
    return name;
  } catch {
    return null;
  }
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim()) return v[0].trim();
  }
  return null;
}

async function runImport(opts: ArchiveImportOptions) {
  if (!job) return;
  const workDir = path.join(TMP_DIR, `import-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(TRACKS_DIR, { recursive: true });
  fs.mkdirSync(COVERS_DIR, { recursive: true });

  let zip: yauzl.ZipFile | null = null;
  try {
    zip = await yauzl.openPromise(opts.archivePath, { lazyEntries: true, autoClose: false });
  } catch (err) {
    safeRmDir(workDir);
    throw new Error(`Не удалось открыть zip: ${err instanceof Error ? err.message : 'битый файл'}`);
  }

  try {
    // 1. Оглавление: аудио и картинки-обложки по папкам.
    const audio: ZipAudio[] = [];
    const images: ZipImage[] = [];
    for await (const entry of zip.eachEntry()) {
      const name = entryName(entry);
      if (name.endsWith('/')) continue;
      const parts = normalizeZipPath(name);
      if (isJunk(parts)) continue;
      if (entry.isEncrypted()) continue;
      const ext = path.extname(parts[parts.length - 1]).toLowerCase();
      if (AUDIO_EXT.has(ext)) {
        if (entry.uncompressedSize > MAX_ENTRY_BYTES) continue;
        audio.push({ entry, parts, name: parts.join('/') });
      } else if (IMAGE_EXT.has(ext) && entry.uncompressedSize < 15 * 1024 * 1024) {
        images.push({
          entry,
          dir: parts.slice(0, -1).join('/'),
          base: path.basename(parts[parts.length - 1], ext),
        });
      }
      if (audio.length >= MAX_AUDIO_FILES) break;
    }

    if (!audio.length) {
      job.status = 'error';
      job.message = 'В архиве нет аудиофайлов (.mp3 .m4a .flac .wav .ogg .aac)';
      return;
    }

    // Сначала файлы из глубоких папок («Артист/Альбом/трек») — у них больше
    // сведений, и именно они должны выиграть у одиноких дублей без тегов.
    audio.sort(
      (a, b) => b.parts.length - a.parts.length || a.name.localeCompare(b.name, 'ru', { numeric: true })
    );
    job.total = audio.length;
    job.message = `Нашли ${audio.length} файлов, читаем теги…`;

    const catalog = new Catalog();
    await catalog.load();

    // Общая структура: если у всех файлов одна корневая папка («Моя музыка/…»),
    // она не имеет смысла как имя артиста — отбрасываем её при разборе пути.
    const roots = new Set(audio.map((a) => a.parts[0]));
    const stripRoot = roots.size === 1 && audio.every((a) => a.parts.length >= 2);

    // Обложки из папок: кэшируем распакованный файл на папку.
    const folderCoverCache = new Map<string, string | null>();
    const folderCover = async (dir: string): Promise<string | null> => {
      if (folderCoverCache.has(dir)) return folderCoverCache.get(dir) ?? null;
      const candidates = images
        .filter((img) => img.dir === dir)
        .sort((a, b) => coverScore(a.base) - coverScore(b.base));
      let result: string | null = null;
      if (candidates.length && zip) {
        const img = candidates[0];
        const ext = path.extname(img.entry.fileName).toLowerCase() || '.jpg';
        const dest = path.join(workDir, `cover-${folderCoverCache.size}${IMAGE_EXT.has(ext) ? ext : '.jpg'}`);
        try {
          await extractEntry(zip, img.entry, dest);
          result = dest;
        } catch {
          result = null;
        }
      }
      folderCoverCache.set(dir, result);
      return result;
    };

    const defaultArtist = opts.defaultArtistId
      ? catalog.artists.find((a) => a.id === opts.defaultArtistId) ?? null
      : null;
    const defaultAlbum = opts.defaultAlbumId ? catalog.albumById(opts.defaultAlbumId) : null;

    // 2. Поштучно: распаковали → теги → раскладка → шифрование → запись.
    for (const item of audio) {
      if (cancelRequested) {
        job.status = 'cancelled';
        job.message = `Остановлено: добавлено ${job.created} из ${job.total}`;
        return;
      }
      job.current = item.name;
      job.message = `${job.processed + 1} из ${job.total} · ${item.parts[item.parts.length - 1]}`;

      const ext = path.extname(item.name).toLowerCase();
      const plainPath = path.join(workDir, `${job.processed}${ext}`);
      let encPath: string | null = null;
      try {
        await extractEntry(zip, item.entry, plainPath);
        if (!isLikelyAudioFile(plainPath)) {
          throw new Error('файл не похож на аудио');
        }

        let meta: Awaited<ReturnType<typeof parseFile>> | null = null;
        try {
          meta = await parseFile(plainPath, { duration: true, skipCovers: false });
        } catch {
          meta = null;
        }
        const common = meta?.common;

        // Путь без общей корневой папки: [Артист?, Альбом?, файл]
        const rel = stripRoot ? item.parts.slice(1) : item.parts;
        const fileBase = path.basename(rel[rel.length - 1], ext);
        const folderArtist = rel.length >= 3 ? rel[rel.length - 3] : rel.length === 2 ? rel[0] : null;
        const folderAlbum = rel.length >= 3 ? rel[rel.length - 2] : null;

        // Имя файла «Артист - Название» — запасной источник, если тегов нет.
        let nameArtist: string | null = null;
        let nameTitle = fileBase.replace(/^\s*\d{1,3}[\s.\-_]+/, '');
        const dash = nameTitle.split(/\s+[-–—]\s+/);
        if (dash.length >= 2) {
          nameArtist = dash[0].trim();
          nameTitle = dash.slice(1).join(' - ').trim();
        }

        const title = cleanTrackTitle(firstString(common?.title) ?? nameTitle);
        const rawArtist = firstString(common?.albumartist, common?.artist, common?.artists) ?? nameArtist ?? folderArtist;
        const albumTitle = firstString(common?.album) ?? folderAlbum;
        const credits = splitArtistCredits(rawArtist ?? '');
        const trackNo = Number(common?.track?.no) || null;
        const year = Number(common?.year) || null;
        const duration = Math.round(Number(meta?.format?.duration) || 0);

        // --- артист
        let artist = catalog.findArtist(credits.main);
        if (!artist && credits.main && opts.createMissing) {
          artist = await catalog.createArtist(credits.main);
          job.artistsCreated += 1;
        }
        if (!artist) artist = defaultArtist;
        if (!artist) {
          throw new Error(
            credits.main
              ? `артиста «${credits.main}» нет в каталоге`
              : 'в тегах нет артиста и не выбран артист по умолчанию'
          );
        }

        // --- дубликат: такой трек у артиста уже есть
        const existing = await catalog.findTrack(artist.id, title);
        const existingAlbumMatches = existing && albumTitle
          ? catalog.findAlbum(albumTitle, artist.id)?.id === existing.albumId
          : false;
        const canEnrich = existing && !existing.albumId && Boolean(albumTitle);
        const canAddCover = existing && !existing.coverUrl && Boolean(common?.picture?.[0]?.data);
        if (existing && !canEnrich && !canAddCover) {
          job.skipped += 1;
          pushRecent({
            file: item.name,
            result: 'skipped',
            detail: `уже есть у ${artist.name}: «${title}»${existingAlbumMatches ? ' (тот же альбом)' : ''}`,
          });
          continue;
        }

        // --- обложка из тегов или из папки
        let coverName: string | null = null;
        const picture = common?.picture?.[0];
        if (picture?.data) {
          coverName = saveCoverBytes(picture.data, pictureExt(picture.format));
        }
        if (!coverName) {
          const dirCover = await folderCover(item.parts.slice(0, -1).join('/'));
          if (dirCover) coverName = copyCoverFile(dirCover);
        }

        // --- альбом
        let album: CachedAlbum | null = catalog.findAlbum(albumTitle, artist.id);
        if (!album && albumTitle && opts.createMissing) {
          const albumCover = coverName ? copyCoverFile(path.join(COVERS_DIR, coverName)) : null;
          album = await catalog.createAlbum(albumTitle, artist.id, year, albumCover);
          job.albumsCreated += 1;
        }
        if (!album && !albumTitle && defaultAlbum && defaultAlbum.artistId === artist.id) {
          album = defaultAlbum;
        }
        if (album && !album.coverUrl && coverName) {
          const albumCover = copyCoverFile(path.join(COVERS_DIR, coverName));
          if (albumCover) await catalog.setAlbumCover(album, albumCover);
        }

        // --- дубликат, но у старого трека нет альбома/обложки: файл не заливаем,
        // а дописываем старому то, чего ему не хватало.
        if (existing) {
          const data: { albumId?: string; trackNumber?: number; coverUrl?: string } = {};
          if (!existing.albumId && album) {
            data.albumId = album.id;
            if (trackNo && !existing.trackNumber) data.trackNumber = trackNo;
          }
          if (!existing.coverUrl && coverName) data.coverUrl = coverName;
          if (Object.keys(data).length) {
            await prisma.track.update({ where: { id: existing.id }, data });
            if (data.albumId) {
              const albumFeat = await getAlbumFeatArtistIds(data.albumId);
              if (albumFeat.length) await syncTrackFeatArtists(existing.id, albumFeat);
            }
            Object.assign(existing, data);
          } else if (coverName) {
            safeUnlink(path.join(COVERS_DIR, coverName));
          }
          job.updated += 1;
          pushRecent({
            file: item.name,
            result: 'updated',
            detail: `«${title}» уже был — ${data.albumId ? `привязали к «${album?.title}»` : 'добавили обложку'}`,
          });
          continue;
        }

        // --- шифрование и запись
        const material = generateKeyMaterial();
        const encName = `${path.basename(randomName(ext), ext)}.enc`;
        encPath = path.join(TRACKS_DIR, encName);
        await encryptFile(plainPath, encPath, material, { deletePlaintext: true });

        const track = await prisma.track.create({
          data: {
            title,
            artistId: artist.id,
            albumId: album?.id ?? null,
            duration,
            trackNumber: trackNo,
            filePath: encName,
            coverUrl: coverName,
            encrypted: true,
            encKey: material.keyHex,
            encNonce: material.nonceHex,
          },
        });
        catalog.rememberTrack(artist.id, {
          id: track.id,
          title,
          albumId: album?.id ?? null,
          coverUrl: coverName,
          trackNumber: trackNo,
        });

        // --- соавторы: из тега или наследуем с альбома
        const featIds = credits.others
          .map((name) => catalog.findArtist(name)?.id)
          .filter((id): id is string => Boolean(id) && id !== artist!.id);
        const resolvedFeat = featIds.length ? featIds : album ? await getAlbumFeatArtistIds(album.id) : [];
        if (resolvedFeat.length) await syncTrackFeatArtists(track.id, [...new Set(resolvedFeat)]);

        job.created += 1;
        pushRecent({
          file: item.name,
          result: 'created',
          detail: `${artist.name} — «${title}»${album ? ` · ${album.title}` : ''}`,
        });
      } catch (err) {
        job.failed += 1;
        if (encPath) safeUnlink(encPath);
        pushRecent({
          file: item.name,
          result: 'failed',
          detail: err instanceof Error ? err.message : 'ошибка',
        });
      } finally {
        safeUnlink(plainPath);
        job.processed += 1;
      }
    }

    job.current = null;
    job.status = 'done';
    job.message =
      `Готово: +${job.created} треков` +
      (job.artistsCreated ? `, +${job.artistsCreated} артистов` : '') +
      (job.albumsCreated ? `, +${job.albumsCreated} альбомов` : '') +
      (job.updated ? `, ${job.updated} дополнено` : '') +
      (job.skipped ? `, ${job.skipped} уже были` : '') +
      (job.failed ? `, ${job.failed} с ошибкой` : '') +
      '.';
    await audit({
      userId: opts.userId,
      event: 'TRACKS_ARCHIVE_IMPORTED',
      payload: {
        archive: opts.archiveName,
        created: job.created,
        updated: job.updated,
        skipped: job.skipped,
        failed: job.failed,
        artistsCreated: job.artistsCreated,
        albumsCreated: job.albumsCreated,
      },
    });
  } finally {
    try {
      zip.close();
    } catch {
      /* ignore */
    }
    safeRmDir(workDir);
  }
}
