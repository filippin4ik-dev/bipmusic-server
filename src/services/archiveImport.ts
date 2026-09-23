/**
 * Массовая загрузка: админ кидает один .zip с музыкой, сервер сам его
 * распаковывает, читает теги, находит (или создаёт) артистов и альбомы,
 * шифрует файлы и заводит треки. Работает в два этапа, оба в фоне:
 *
 *   1. scanning → ready. Читаем теги всех файлов, группируем по
 *      «артист + альбом» и для каждой группы подбираем место в каталоге с
 *      учётом транслита («Легендарная пыль» ↔ «legendarnaja pyl'»).
 *      Каждая группа получает решение: match (уверенно), ask (похоже, но
 *      пусть человек подтвердит), create (в каталоге нет), none (нечего искать).
 *   2. running → done. Админ подтверждает или правит план и запускает импорт.
 *
 * Правила раскладки для файла:
 *   - Артист — из тега (albumartist → artist), иначе из структуры папок
 *     «Артист/Альбом/трек.mp3», иначе из имени «Артист - Название.mp3»,
 *     иначе артист по умолчанию из формы.
 *   - Альбом — из тега album (или папка). Нет тега — сингл (или альбом по
 *     умолчанию, если он у того же артиста).
 *   - Дубликаты (тот же артист + похожее название) не заливаем повторно, но
 *     если у старого трека не было альбома/обложки — дописываем.
 *   - Обложка: из тегов, иначе cover.jpg/folder.jpg рядом. Альбому без
 *     обложки ставим её же.
 *   - Остальные имена в теге artist («A feat. B», «A, B») — соавторы, если
 *     такие артисты уже есть.
 */
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import yauzl from 'yauzl';
import iconv from 'iconv-lite';
import { parseFile, parseStream, type IAudioMetadata } from 'music-metadata';
import { prisma } from '../db.js';
import { encryptFile, generateKeyMaterial } from './cryptoService.js';
import { isLikelyAudioFile } from './audioValidator.js';
import { audit } from './auditService.js';
import { getAlbumFeatArtistIds, syncTrackFeatArtists } from '../utils/trackSerialize.js';
import { cleanTrackTitle, splitArtistCredits } from '../utils/trackTitle.js';
import { MATCH_ASK, MATCH_AUTO, rankByName, similarity, skeleton } from '../utils/fuzzyMatch.js';

const TRACKS_DIR = path.resolve(process.env.TRACKS_DIR || './data/tracks');
const COVERS_DIR = path.resolve(process.env.COVERS_DIR || './data/covers');
const TMP_DIR = path.resolve(process.env.TMP_DIR || './data/tmp');

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.aac']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_ENTRY_BYTES = 400 * 1024 * 1024; // один трек больше 400 МБ — явно не трек
const MAX_AUDIO_FILES = 5000;
const RECENT_LIMIT = 40;
const DUPLICATE_TITLE_SCORE = 0.92;

// ---------------------------------------------------------------------------
// Публичные типы (их же читает приложение)

export type ArchiveImportItem = {
  file: string;
  result: 'created' | 'updated' | 'skipped' | 'failed';
  detail: string;
};

export type PlanCandidate = { id: string; name: string; score: number };

export type PlanGroup = {
  id: string;
  /** Папка в архиве, откуда файлы группы. */
  folder: string;
  /** Как артист и альбом записаны в тегах / имени папки. */
  artistRaw: string | null;
  albumRaw: string | null;
  files: number;
  sampleTitles: string[];
  year: number | null;
  artist: PlanCandidate | null;
  artistCandidates: PlanCandidate[];
  album: PlanCandidate | null;
  albumCandidates: PlanCandidate[];
  /** match — уверенно нашли; ask — похоже, проверь; create — в каталоге нет; none — артист неизвестен. */
  artistDecision: 'match' | 'ask' | 'create' | 'none';
  /** match | ask | create | single (без альбома). */
  albumDecision: 'match' | 'ask' | 'create' | 'single';
};

export type GroupChoice = {
  id: string;
  skip?: boolean;
  artistId?: string | null;
  newArtistName?: string | null;
  albumId?: string | null;
  newAlbumTitle?: string | null;
  single?: boolean;
};

export type ArchiveImportJob = {
  status: 'scanning' | 'ready' | 'running' | 'done' | 'error' | 'cancelled';
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
  plan: PlanGroup[] | null;
  /** Сколько групп ждут решения человека (ask/none). */
  needsReview: number;
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

// ---------------------------------------------------------------------------
// Состояние модуля: один импорт за раз.

type ScannedFile = {
  name: string;
  parts: string[];
  title: string;
  artistRaw: string | null;
  albumRaw: string | null;
  trackNo: number | null;
  year: number | null;
  groupId: string;
};

type Pending = {
  opts: ArchiveImportOptions;
  files: ScannedFile[];
  images: { name: string; dir: string; base: string }[];
  groups: PlanGroup[];
  /** file.groupId (ключ группировки) → PlanGroup.id */
  groupIdByKey: Map<string, string>;
};

let job: ArchiveImportJob | null = null;
let pending: Pending | null = null;
let busy = false;
let cancelRequested = false;

export function getArchiveImportJob(): ArchiveImportJob | null {
  return job;
}

export function isArchiveImportBusy(): boolean {
  return busy;
}

/** Останавливает сканирование/импорт или выбрасывает готовый план вместе с архивом. */
export function cancelArchiveImport(): ArchiveImportJob | null {
  if (!job) return null;
  if (busy) {
    cancelRequested = true;
    job.message = job.status === 'scanning' ? 'Останавливаем чтение…' : 'Останавливаем после текущего файла…';
    return job;
  }
  if (job.status === 'ready' && pending) {
    safeUnlink(pending.opts.archivePath);
    pending = null;
    job.status = 'cancelled';
    job.message = 'Архив выброшен, ничего не добавляли.';
    job.finishedAt = new Date().toISOString();
  }
  return job;
}

export function startArchiveScan(opts: ArchiveImportOptions): ArchiveImportJob {
  if (busy) {
    throw new Error('Предыдущий архив ещё в работе. Дождись окончания или останови его.');
  }
  if (job?.status === 'ready' && pending) {
    // Новый архив вместо неподтверждённого старого.
    safeUnlink(pending.opts.archivePath);
    pending = null;
  }
  cancelRequested = false;
  sweepStaleTemp(opts.archivePath);
  job = freshJob(opts.archiveName, 'scanning', 'Открываем архив…');
  busy = true;
  void runScan(opts)
    .catch((err) => {
      if (job) {
        job.status = 'error';
        job.message = err instanceof Error ? err.message : 'Не удалось прочитать архив';
      }
      safeUnlink(opts.archivePath);
      pending = null;
    })
    .finally(() => {
      busy = false;
      if (job && job.status !== 'ready') job.finishedAt = new Date().toISOString();
    });
  return job;
}

export function startArchiveRun(choices: GroupChoice[]): ArchiveImportJob {
  if (busy) throw new Error('Импорт уже идёт.');
  if (!job || job.status !== 'ready' || !pending) {
    throw new Error('Сначала загрузи архив и дождись плана раскладки.');
  }
  cancelRequested = false;
  const current = pending;
  job.status = 'running';
  job.message = 'Начинаем…';
  job.total = current.files.length;
  job.processed = 0;
  job.current = null;
  busy = true;
  void runImport(current, choices)
    .catch((err) => {
      if (job) {
        job.status = 'error';
        job.message = err instanceof Error ? err.message : 'Импорт архива не удался';
      }
    })
    .finally(() => {
      busy = false;
      pending = null;
      if (job) job.finishedAt = new Date().toISOString();
      safeUnlink(current.opts.archivePath);
    });
  return job;
}

function freshJob(archiveName: string, status: ArchiveImportJob['status'], message: string): ArchiveImportJob {
  return {
    status,
    message,
    archiveName,
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
    plan: null,
    needsReview: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Файловые мелочи

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
      if (pending && path.resolve(full) === path.resolve(pending.opts.archivePath)) continue;
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
  if (!/[^\x00-\x7F]/.test(asUtf8)) return asUtf8; // чистый ASCII
  if (!asUtf8.includes('\uFFFD')) return asUtf8;
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

function mimeFor(ext: string): string | undefined {
  switch (ext) {
    case '.mp3': return 'audio/mpeg';
    case '.m4a': case '.aac': return 'audio/mp4';
    case '.flac': return 'audio/flac';
    case '.wav': return 'audio/wav';
    case '.ogg': return 'audio/ogg';
    default: return undefined;
  }
}

/** Первые байты файла из архива: аудио ли это вообще. */
async function sniffIsAudio(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<boolean> {
  const stream = await zip.openReadStreamPromise(entry);
  return new Promise<boolean>((resolve) => {
    let head = Buffer.alloc(0);
    const finish = (ok: boolean) => {
      stream.destroy();
      resolve(ok);
    };
    stream.on('data', (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      if (head.length >= 16) finish(isLikelyAudioBuffer(head));
    });
    stream.on('end', () => finish(head.length ? isLikelyAudioBuffer(head) : false));
    stream.on('error', () => finish(false));
  });
}

function isLikelyAudioBuffer(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // ID3
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true; // MPEG sync
  if (buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return true; // ftyp
  if (buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43) return true; // fLaC
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return true; // OggS
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return true;
  return false;
}

/** Теги без полной распаковки: читаем из потока, а если формат упрямится — через файл. */
async function readTagsFast(zip: yauzl.ZipFile, entry: yauzl.Entry, ext: string, workDir: string): Promise<IAudioMetadata | null> {
  const stream = await zip.openReadStreamPromise(entry);
  try {
    const meta = await parseStream(
      stream,
      { mimeType: mimeFor(ext), size: entry.uncompressedSize },
      { duration: false, skipCovers: true, skipPostHeaders: true }
    );
    return meta;
  } catch {
    /* попробуем через файл */
  } finally {
    stream.destroy();
  }
  const tmp = path.join(workDir, `scan-${Math.random().toString(36).slice(2, 8)}${ext}`);
  try {
    await extractEntry(zip, entry, tmp);
    return await parseFile(tmp, { duration: false, skipCovers: true });
  } catch {
    return null;
  } finally {
    safeUnlink(tmp);
  }
}

// ---------------------------------------------------------------------------
// Каталог: кэш артистов/альбомов, чтобы не дёргать базу на каждый файл.

type CachedArtist = { id: string; name: string };
type CachedAlbum = { id: string; title: string; artistId: string; coverUrl: string | null };
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
  private tracks = new Map<string, CachedTrack[]>(); // artistId → треки

  async load() {
    const [artists, albums] = await Promise.all([
      prisma.artist.findMany({ select: { id: true, name: true } }),
      prisma.album.findMany({ select: { id: true, title: true, artistId: true, coverUrl: true } }),
    ]);
    this.artists = artists;
    this.albums = albums;
  }

  rankArtists(raw: string | null | undefined): PlanCandidate[] {
    return rankByName(raw, this.artists, (a) => a.name).map(({ item, score }) => ({
      id: item.id,
      name: item.name,
      score: Math.round(score * 100) / 100,
    }));
  }

  rankAlbums(raw: string | null | undefined, artistId: string): PlanCandidate[] {
    const mine = this.albums.filter((a) => a.artistId === artistId);
    return rankByName(raw, mine, (a) => a.title).map(({ item, score }) => ({
      id: item.id,
      name: item.title,
      score: Math.round(score * 100) / 100,
    }));
  }

  /** Альбом с таким названием у любого артиста: подсказка, когда имя артиста написано иначе. */
  rankAlbumsAnywhere(raw: string | null | undefined): { album: CachedAlbum; score: number }[] {
    return rankByName(raw, this.albums, (a) => a.title, { limit: 8, floor: MATCH_AUTO }).map(({ item, score }) => ({
      album: item,
      score,
    }));
  }

  artistById(id: string): CachedArtist | null {
    return this.artists.find((a) => a.id === id) ?? null;
  }

  albumById(id: string): CachedAlbum | null {
    return this.albums.find((a) => a.id === id) ?? null;
  }

  async createArtist(name: string): Promise<CachedArtist> {
    const row = await prisma.artist.create({ data: { name: name.trim() } });
    const cached = { id: row.id, name: row.name };
    this.artists.push(cached);
    return cached;
  }

  async createAlbum(title: string, artistId: string, year: number | null, coverUrl: string | null): Promise<CachedAlbum> {
    const row = await prisma.album.create({ data: { title: title.trim(), artistId, year, coverUrl } });
    const cached = { id: row.id, title: row.title, artistId, coverUrl };
    this.albums.push(cached);
    return cached;
  }

  async setAlbumCover(album: CachedAlbum, coverUrl: string) {
    await prisma.album.update({ where: { id: album.id }, data: { coverUrl } });
    album.coverUrl = coverUrl;
  }

  async findTrack(artistId: string, title: string): Promise<CachedTrack | null> {
    let list = this.tracks.get(artistId);
    if (!list) {
      list = await prisma.track.findMany({
        where: { artistId },
        select: { id: true, title: true, albumId: true, coverUrl: true, trackNumber: true },
      });
      this.tracks.set(artistId, list);
    }
    const key = skeleton(title);
    let best: CachedTrack | null = null;
    let bestScore = 0;
    for (const t of list) {
      if (skeleton(t.title) === key) return t;
      const score = similarity(title, t.title);
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return bestScore >= DUPLICATE_TITLE_SCORE ? best : null;
  }

  rememberTrack(artistId: string, track: CachedTrack) {
    const list = this.tracks.get(artistId) ?? [];
    list.push(track);
    this.tracks.set(artistId, list);
  }
}

// ---------------------------------------------------------------------------
// Этап 1: сканирование и план

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim()) return v[0].trim();
  }
  return null;
}

/** «Various Artists», «Сборник» и прочие «артисты», которых нет. */
function isVariousArtists(raw: string | null): boolean {
  if (!raw) return false;
  return /^(various( artists)?|va|сборник|разные исполнители|unknown( artist)?|неизвестн)/i.test(raw.trim());
}

function deriveFileInfo(
  parts: string[],
  stripRoot: boolean,
  common: IAudioMetadata['common'] | undefined
): Omit<ScannedFile, 'name' | 'parts' | 'groupId'> {
  const ext = path.extname(parts[parts.length - 1]).toLowerCase();
  const rel = stripRoot ? parts.slice(1) : parts;
  const fileBase = path.basename(rel[rel.length - 1], ext);
  const folderArtist = rel.length >= 3 ? rel[rel.length - 3] : rel.length === 2 ? rel[0] : null;
  const folderAlbum = rel.length >= 3 ? rel[rel.length - 2] : null;

  // Имя файла «03 - Артист - Название» / «Артист - Название» — запасной источник.
  let nameArtist: string | null = null;
  let nameTitle = fileBase.replace(/^\s*\d{1,3}[\s.\-_]+/, '');
  const dash = nameTitle.split(/\s+[-–—]\s+/);
  if (dash.length >= 2) {
    nameArtist = dash[0].trim();
    nameTitle = dash.slice(1).join(' - ').trim();
  }

  let artistRaw = firstString(common?.albumartist, common?.artist, common?.artists);
  if (isVariousArtists(artistRaw)) artistRaw = firstString(common?.artist, common?.artists) ?? artistRaw;
  if (isVariousArtists(artistRaw)) artistRaw = null;
  artistRaw = artistRaw ?? nameArtist ?? folderArtist;

  // Папка «Альбом (2017)» → «Альбом», год отдельно.
  let albumRaw = firstString(common?.album) ?? folderAlbum;
  let year = Number(common?.year) || null;
  if (albumRaw && !year) {
    const m = albumRaw.match(/^(.*?)\s*[\(\[]\s*((?:19|20)\d{2})\s*[\)\]]\s*$/);
    if (m) {
      albumRaw = m[1].trim() || albumRaw;
      year = Number(m[2]);
    }
  }

  return {
    title: cleanTrackTitle(firstString(common?.title) ?? nameTitle),
    artistRaw,
    albumRaw,
    trackNo: Number(common?.track?.no) || null,
    year,
  };
}

function groupKey(file: Pick<ScannedFile, 'artistRaw' | 'albumRaw' | 'parts'>): string {
  const main = splitArtistCredits(file.artistRaw ?? '').main;
  const a = skeleton(main);
  const b = skeleton(file.albumRaw);
  if (a || b) return `${a}|${b}`;
  return `dir:${file.parts.slice(0, -1).join('/')}`;
}

function buildPlan(
  files: ScannedFile[],
  catalog: Catalog,
  opts: ArchiveImportOptions
): { groups: PlanGroup[]; groupIdByKey: Map<string, string> } {
  const byKey = new Map<string, ScannedFile[]>();
  for (const f of files) {
    const list = byKey.get(f.groupId) ?? [];
    list.push(f);
    byKey.set(f.groupId, list);
  }

  const groups: PlanGroup[] = [];
  const groupIdByKey = new Map<string, string>();
  let index = 0;
  for (const [key, list] of byKey) {
    index += 1;
    groupIdByKey.set(key, `g${index}`);
    const first = list[0];
    const artistMain = splitArtistCredits(first.artistRaw ?? '').main || null;
    const albumRaw = first.albumRaw;
    const year = list.map((f) => f.year).find((y) => y) ?? null;

    let artistCandidates = catalog.rankArtists(artistMain);
    let artist = artistCandidates[0] ?? null;

    // Подсказка через альбом: если такой альбом уже есть у артиста с похожим
    // (но не идентичным) именем — это он. «Легендарная пыль» у «Скриптонит»
    // найдёт «Skriptonit / Legendarnaja pyl'» даже при слабом совпадении имени.
    if (albumRaw && (!artist || artist.score < MATCH_AUTO)) {
      for (const hit of catalog.rankAlbumsAnywhere(albumRaw)) {
        const owner = catalog.artistById(hit.album.artistId);
        if (!owner) continue;
        const ownerScore = artistMain ? similarity(artistMain, owner.name) : 0;
        if (ownerScore >= MATCH_ASK || !artistMain) {
          const boosted = Math.max(ownerScore, MATCH_AUTO);
          artist = { id: owner.id, name: owner.name, score: Math.round(boosted * 100) / 100 };
          artistCandidates = [artist, ...artistCandidates.filter((c) => c.id !== owner.id)].slice(0, 5);
          break;
        }
      }
    }

    let artistDecision: PlanGroup['artistDecision'];
    if (artist && artist.score >= MATCH_AUTO) artistDecision = 'match';
    else if (artist && artist.score >= MATCH_ASK) artistDecision = 'ask';
    else if (artistMain) artistDecision = opts.createMissing ? 'create' : 'none';
    else artistDecision = opts.defaultArtistId ? 'match' : 'none';

    if (!artistMain && opts.defaultArtistId) {
      const def = catalog.artistById(opts.defaultArtistId);
      if (def) {
        artist = { id: def.id, name: def.name, score: 1 };
        artistCandidates = [artist];
      }
    }
    if (artistDecision === 'ask' || artistDecision === 'create' || artistDecision === 'none') {
      // Предложение оставляем, но выбирать будет человек (или create создаст нового).
    }

    let album: PlanCandidate | null = null;
    let albumCandidates: PlanCandidate[] = [];
    let albumDecision: PlanGroup['albumDecision'] = 'single';
    if (albumRaw) {
      if (artist && (artistDecision === 'match' || artistDecision === 'ask')) {
        albumCandidates = catalog.rankAlbums(albumRaw, artist.id);
        album = albumCandidates[0] ?? null;
        if (album && album.score >= MATCH_AUTO) albumDecision = 'match';
        else if (album && album.score >= MATCH_ASK) albumDecision = 'ask';
        else albumDecision = 'create';
      } else {
        albumDecision = 'create';
      }
    } else if (opts.defaultAlbumId && artist) {
      const def = catalog.albumById(opts.defaultAlbumId);
      if (def && def.artistId === artist.id) {
        album = { id: def.id, name: def.title, score: 1 };
        albumCandidates = [album];
        albumDecision = 'match';
      }
    }

    groups.push({
      id: `g${index}`,
      folder: first.parts.slice(0, -1).join('/'),
      artistRaw: artistMain,
      albumRaw,
      files: list.length,
      sampleTitles: list.slice(0, 3).map((f) => f.title),
      year,
      artist,
      artistCandidates,
      album,
      albumCandidates,
      artistDecision,
      albumDecision,
    });
  }

  // Сначала то, что требует внимания, потом новые, потом уверенные.
  const weight = (g: PlanGroup) =>
    g.artistDecision === 'none' ? 0
      : g.artistDecision === 'ask' || g.albumDecision === 'ask' ? 1
        : g.artistDecision === 'create' ? 2
          : 3;
  groups.sort((a, b) => weight(a) - weight(b) || b.files - a.files);
  return { groups, groupIdByKey };
}

async function runScan(opts: ArchiveImportOptions) {
  if (!job) return;
  const workDir = path.join(TMP_DIR, `import-scan-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(opts.archivePath, { lazyEntries: true, autoClose: false });
  } catch (err) {
    safeRmDir(workDir);
    throw new Error(`Не удалось открыть zip: ${err instanceof Error ? err.message : 'битый файл'}`);
  }

  try {
    const audio: { entry: yauzl.Entry; parts: string[]; name: string }[] = [];
    const images: Pending['images'] = [];
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
        images.push({ name: parts.join('/'), dir: parts.slice(0, -1).join('/'), base: path.basename(parts[parts.length - 1], ext) });
      }
      if (audio.length >= MAX_AUDIO_FILES) break;
    }

    if (!audio.length) {
      throw new Error('В архиве нет аудиофайлов (.mp3 .m4a .flac .wav .ogg .aac)');
    }

    audio.sort((a, b) => b.parts.length - a.parts.length || a.name.localeCompare(b.name, 'ru', { numeric: true }));
    job.total = audio.length;

    const roots = new Set(audio.map((a) => a.parts[0]));
    const stripRoot = roots.size === 1 && audio.every((a) => a.parts.length >= 2);

    const files: ScannedFile[] = [];
    for (const item of audio) {
      if (cancelRequested) {
        job.status = 'cancelled';
        job.message = 'Чтение остановлено.';
        safeUnlink(opts.archivePath);
        return;
      }
      job.processed += 1;
      job.current = item.name;
      job.message = `Читаем теги: ${job.processed} из ${job.total}`;
      const ext = path.extname(item.name).toLowerCase();
      if (!(await sniffIsAudio(zip, item.entry))) {
        // Переименованный .txt/.exe — в план не берём вовсе.
        continue;
      }
      const meta = await readTagsFast(zip, item.entry, ext, workDir);
      const info = deriveFileInfo(item.parts, stripRoot, meta?.common);
      const file: ScannedFile = { name: item.name, parts: item.parts, groupId: '', ...info };
      file.groupId = groupKey(file);
      files.push(file);
    }

    job.message = 'Сверяем с каталогом…';
    const catalog = new Catalog();
    await catalog.load();
    const { groups, groupIdByKey } = buildPlan(files, catalog, opts);

    pending = { opts, files, images, groups, groupIdByKey };
    job.plan = groups;
    job.needsReview = groups.filter(
      (g) => g.artistDecision === 'ask' || g.artistDecision === 'none' || g.albumDecision === 'ask'
    ).length;
    job.current = null;
    job.processed = 0;
    job.status = 'ready';
    job.message = job.needsReview
      ? `План готов: ${groups.length} групп, ${job.needsReview} нужно проверить.`
      : `План готов: ${groups.length} групп, всё нашлось само.`;
  } finally {
    try {
      zip.close();
    } catch {
      /* ignore */
    }
    safeRmDir(workDir);
  }
}

// ---------------------------------------------------------------------------
// Этап 2: импорт по подтверждённому плану

type Target = { skip: boolean; artist: CachedArtist | null; album: CachedAlbum | null; single: boolean; newAlbumTitle: string | null; error: string | null };

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

/** Решение по группе: явный выбор админа поверх предложения сервера. */
async function resolveTarget(group: PlanGroup, choice: GroupChoice | undefined, catalog: Catalog, opts: ArchiveImportOptions): Promise<Target> {
  const target: Target = { skip: false, artist: null, album: null, single: false, newAlbumTitle: null, error: null };
  if (choice?.skip) {
    target.skip = true;
    return target;
  }

  // --- артист
  if (choice?.artistId) {
    target.artist = catalog.artistById(choice.artistId);
    if (!target.artist) {
      target.error = 'выбранного артиста больше нет';
      return target;
    }
  } else if (choice?.newArtistName?.trim()) {
    target.artist = await catalog.createArtist(choice.newArtistName);
    if (job) job.artistsCreated += 1;
  } else if (group.artistDecision === 'match' || group.artistDecision === 'ask') {
    target.artist = group.artist ? catalog.artistById(group.artist.id) : null;
  } else if (group.artistDecision === 'create' && group.artistRaw) {
    target.artist = await catalog.createArtist(group.artistRaw);
    if (job) job.artistsCreated += 1;
  }
  if (!target.artist && opts.defaultArtistId) target.artist = catalog.artistById(opts.defaultArtistId);
  if (!target.artist) {
    target.error = group.artistRaw
      ? `артиста «${group.artistRaw}» нет в каталоге — выбери его в плане`
      : 'в тегах нет артиста и не выбран артист по умолчанию';
    return target;
  }

  // --- альбом
  if (choice?.single) {
    target.single = true;
  } else if (choice?.albumId) {
    target.album = catalog.albumById(choice.albumId);
    if (!target.album) {
      target.error = 'выбранного альбома больше нет';
      return target;
    }
    if (target.album.artistId !== target.artist.id) {
      // Альбом другого артиста: кладём к владельцу альбома, так честнее для каталога.
      target.artist = catalog.artistById(target.album.artistId) ?? target.artist;
    }
  } else if (choice?.newAlbumTitle?.trim()) {
    target.newAlbumTitle = choice.newAlbumTitle.trim();
  } else if ((group.albumDecision === 'match' || group.albumDecision === 'ask') && group.album) {
    const proposed = catalog.albumById(group.album.id);
    if (proposed && proposed.artistId === target.artist.id) target.album = proposed;
    else if (group.albumRaw) target.newAlbumTitle = group.albumRaw;
  } else if (group.albumDecision === 'create' && group.albumRaw) {
    target.newAlbumTitle = group.albumRaw;
  } else if (group.albumDecision === 'single') {
    target.single = true;
    if (opts.defaultAlbumId) {
      const def = catalog.albumById(opts.defaultAlbumId);
      if (def && def.artistId === target.artist.id) {
        target.album = def;
        target.single = false;
      }
    }
  }
  return target;
}

async function runImport(current: Pending, choices: GroupChoice[]) {
  if (!job) return;
  const { opts } = current;
  const workDir = path.join(TMP_DIR, `import-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(TRACKS_DIR, { recursive: true });
  fs.mkdirSync(COVERS_DIR, { recursive: true });

  const catalog = new Catalog();
  await catalog.load();

  const choiceById = new Map(choices.map((c) => [c.id, c]));
  const groupsById = new Map(current.groups.map((g) => [g.id, g]));
  const targets = new Map<string, Target>();
  for (const group of current.groups) {
    targets.set(group.id, await resolveTarget(group, choiceById.get(group.id), catalog, opts));
  }
  const groupForFile = (file: ScannedFile): PlanGroup | undefined => {
    const id = current.groupIdByKey.get(file.groupId);
    return id ? groupsById.get(id) : undefined;
  };

  const wanted = new Map(current.files.map((f) => [f.name, f]));
  const albumCreatedForGroup = new Map<string, CachedAlbum>();

  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(opts.archivePath, { lazyEntries: true, autoClose: false });
  } catch (err) {
    safeRmDir(workDir);
    throw new Error(`Не удалось открыть zip: ${err instanceof Error ? err.message : 'битый файл'}`);
  }

  const imageEntries = new Map<string, yauzl.Entry>();
  const folderCoverCache = new Map<string, string | null>();
  const folderCover = async (dir: string): Promise<string | null> => {
    if (folderCoverCache.has(dir)) return folderCoverCache.get(dir) ?? null;
    const candidates = current.images
      .filter((img) => img.dir === dir && imageEntries.has(img.name))
      .sort((a, b) => coverScore(a.base) - coverScore(b.base));
    let result: string | null = null;
    if (candidates.length) {
      const img = candidates[0];
      const ext = path.extname(img.name).toLowerCase() || '.jpg';
      const dest = path.join(workDir, `cover-${folderCoverCache.size}${IMAGE_EXT.has(ext) ? ext : '.jpg'}`);
      try {
        await extractEntry(zip, imageEntries.get(img.name)!, dest);
        result = dest;
      } catch {
        result = null;
      }
    }
    folderCoverCache.set(dir, result);
    return result;
  };

  try {
    // Первый проход по оглавлению: запоминаем entry картинок и аудио.
    const audioEntries: { entry: yauzl.Entry; file: ScannedFile }[] = [];
    for await (const entry of zip.eachEntry()) {
      const name = entryName(entry);
      if (name.endsWith('/')) continue;
      const parts = normalizeZipPath(name);
      const joined = parts.join('/');
      const file = wanted.get(joined);
      if (file) audioEntries.push({ entry, file });
      else if (current.images.some((img) => img.name === joined)) imageEntries.set(joined, entry);
    }
    audioEntries.sort((a, b) => current.files.indexOf(a.file) - current.files.indexOf(b.file));

    for (const { entry, file } of audioEntries) {
      if (cancelRequested) {
        job.status = 'cancelled';
        job.message = `Остановлено: добавлено ${job.created} из ${job.total}`;
        return;
      }
      job.current = file.name;
      job.message = `${job.processed + 1} из ${job.total} · ${file.parts[file.parts.length - 1]}`;

      const group = groupForFile(file);
      const target = group ? targets.get(group.id) : undefined;
      const ext = path.extname(file.name).toLowerCase();
      const plainPath = path.join(workDir, `${job.processed}${ext}`);
      let encPath: string | null = null;
      try {
        if (!group || !target) throw new Error('файл не попал ни в одну группу плана');
        if (target.skip) {
          job.skipped += 1;
          pushRecent({ file: file.name, result: 'skipped', detail: 'группа пропущена по твоему выбору' });
          continue;
        }
        if (target.error || !target.artist) throw new Error(target.error ?? 'артист не определён');
        const artist = target.artist;

        await extractEntry(zip, entry, plainPath);
        if (!isLikelyAudioFile(plainPath)) throw new Error('файл не похож на аудио');

        let meta: IAudioMetadata | null = null;
        try {
          meta = await parseFile(plainPath, { duration: true, skipCovers: false });
        } catch {
          meta = null;
        }
        const common = meta?.common;
        const title = file.title;
        const credits = splitArtistCredits(firstString(common?.artist, common?.artists) ?? file.artistRaw ?? '');
        const trackNo = file.trackNo ?? (Number(common?.track?.no) || null);
        const year = file.year ?? (Number(common?.year) || null);
        const duration = Math.round(Number(meta?.format?.duration) || 0);

        // --- дубликат
        const existing = await catalog.findTrack(artist.id, title);
        const canEnrich = existing && !existing.albumId && (target.album || target.newAlbumTitle);
        const canAddCover = existing && !existing.coverUrl && Boolean(common?.picture?.[0]?.data);
        if (existing && !canEnrich && !canAddCover) {
          job.skipped += 1;
          pushRecent({
            file: file.name,
            result: 'skipped',
            detail: `уже есть у ${artist.name}: «${existing.title}»`,
          });
          continue;
        }

        // --- обложка
        let coverName: string | null = null;
        const picture = common?.picture?.[0];
        if (picture?.data) coverName = saveCoverBytes(picture.data, pictureExt(picture.format));
        if (!coverName) {
          const dirCover = await folderCover(file.parts.slice(0, -1).join('/'));
          if (dirCover) coverName = copyCoverFile(dirCover);
        }

        // --- альбом (новый создаём один раз на группу)
        let album: CachedAlbum | null = target.album;
        if (!album && target.newAlbumTitle && !target.single) {
          album = albumCreatedForGroup.get(group.id) ?? null;
          if (!album) {
            const albumCover = coverName ? copyCoverFile(path.join(COVERS_DIR, coverName)) : null;
            album = await catalog.createAlbum(target.newAlbumTitle, artist.id, year, albumCover);
            albumCreatedForGroup.set(group.id, album);
            target.album = album;
            job.albumsCreated += 1;
          }
        }
        if (album && !album.coverUrl && coverName) {
          const albumCover = copyCoverFile(path.join(COVERS_DIR, coverName));
          if (albumCover) await catalog.setAlbumCover(album, albumCover);
        }

        // --- дубликат без альбома/обложки: дописываем старому
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
            file: file.name,
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
        catalog.rememberTrack(artist.id, { id: track.id, title, albumId: album?.id ?? null, coverUrl: coverName, trackNumber: trackNo });

        // --- соавторы: из тега трека (кроме главного) или наследуем с альбома
        const featIds = [credits.main, ...credits.others]
          .map((name) => catalog.rankArtists(name)[0])
          .filter((c): c is PlanCandidate => Boolean(c) && c.score >= MATCH_AUTO)
          .map((c) => c.id)
          .filter((id) => id !== artist.id);
        const resolvedFeat = featIds.length ? featIds : album ? await getAlbumFeatArtistIds(album.id) : [];
        if (resolvedFeat.length) await syncTrackFeatArtists(track.id, [...new Set(resolvedFeat)]);

        job.created += 1;
        pushRecent({
          file: file.name,
          result: 'created',
          detail: `${artist.name} — «${title}»${album ? ` · ${album.title}` : ''}`,
        });
      } catch (err) {
        job.failed += 1;
        if (encPath) safeUnlink(encPath);
        pushRecent({ file: file.name, result: 'failed', detail: err instanceof Error ? err.message : 'ошибка' });
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
      (job.skipped ? `, ${job.skipped} пропущено` : '') +
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
