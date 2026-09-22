import fs from 'fs';
import path from 'path';
import { prisma } from '../db.js';
import {
  YandexMusicError,
  isYandexConfigured,
  yandexApiGet,
  yandexFetchBuffer,
} from './yandexMusic.js';

const COVERS_DIR = path.resolve(process.env.COVERS_DIR || './data/covers');
const MIN_MONTHLY_LISTENERS = 100_000;
const MAX_NEW_ARTISTS = 400;
const MAX_IDS_TO_CHECK = 800;
const MAX_PHOTOS = 6;
const MAX_ALBUM_PAGES = 12;

export type YandexImportJob = {
  status: 'running' | 'done' | 'error';
  message: string;
  artistsCreated: number;
  artistsUpdated: number;
  albumsCreated: number;
  photosSaved: number;
  skipped: number;
  current: string | null;
};

let job: YandexImportJob | null = null;
let running = false;

export function getYandexImportJob(): YandexImportJob | null {
  return job;
}

export function startYandexPopularImport(query?: string): YandexImportJob {
  if (!isYandexConfigured()) {
    throw new YandexMusicError('Сначала подключи Яндекс Музыку в тексте песен', 400);
  }
  if (running && job) return job;
  const q = String(query ?? '').trim();
  job = {
    status: 'running',
    message: q ? `Ищем «${q}» и похожих…` : 'Собираем популярных не только из чарта…',
    artistsCreated: 0,
    artistsUpdated: 0,
    albumsCreated: 0,
    photosSaved: 0,
    skipped: 0,
    current: null,
  };
  running = true;
  void runImport(q).catch((err) => {
    if (job) {
      job.status = 'error';
      job.message = err instanceof Error ? err.message : 'Импорт не удался';
    }
  }).finally(() => {
    running = false;
  });
  return job;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectArtistIds(node: any, into: Set<string>, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node) collectArtistIds(item, into, depth + 1);
    return;
  }
  if (Array.isArray(node.artists)) {
    for (const artist of node.artists) {
      if (artist?.id != null) into.add(String(artist.id));
    }
  }
  if (node.artist?.id != null) into.add(String(node.artist.id));
  for (const key of ['track', 'tracks', 'chart', 'result', 'blocks', 'entities', 'data', 'album', 'albums', 'newReleases']) {
    if (node[key]) collectArtistIds(node[key], into, depth + 1);
  }
}

async function searchArtistIds(query: string, pages = 2): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 0; page < pages; page++) {
    try {
      const json = await yandexApiGet(
        `/search?text=${encodeURIComponent(query)}&type=artist&page=${page}&nocorrect=false`
      );
      collectArtistIds(json?.result?.artists ?? json, new Set());
      const rows = json?.result?.artists?.results;
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row?.id != null) ids.push(String(row.id));
        }
      } else {
        const bag = new Set<string>();
        collectArtistIds(json, bag);
        ids.push(...bag);
      }
      await sleep(120);
    } catch {
      break;
    }
  }
  return ids;
}

async function similarArtistIds(yandexId: string): Promise<string[]> {
  try {
    const json = await yandexApiGet(`/artists/${encodeURIComponent(yandexId)}/similar`);
    const rows = json?.result?.similarArtists ?? json?.result?.similar_artists ?? json?.result ?? [];
    const bag = new Set<string>();
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (row?.id != null) bag.add(String(row.id));
      }
    } else {
      collectArtistIds(json, bag);
    }
    return [...bag];
  } catch {
    return [];
  }
}

async function collectPopularArtistIds(seedQuery?: string): Promise<string[]> {
  const ids = new Set<string>();
  const add = (value: string) => {
    if (value) ids.add(value);
  };

  if (seedQuery) {
    for (const found of await searchArtistIds(seedQuery, 3)) add(found);
  }

  const paths = [
    '/landing3/chart',
    '/landing3/chart/world',
    '/landing3/chart/russia',
    '/landing3?blocks=new-releases,chart,new-playlists,promotions',
    '/chart',
  ];
  for (const pathAndQuery of paths) {
    try {
      const json = await yandexApiGet(pathAndQuery);
      collectArtistIds(json, ids);
      await sleep(120);
    } catch {
      /* блок может отсутствовать */
    }
  }

  try {
    const genres = await yandexApiGet('/genres');
    const list = Array.isArray(genres?.result) ? genres.result : [];
    for (const genre of list.slice(0, 35)) {
      const slug = String(genre?.id ?? genre?.url ?? '').replace(/^\//, '');
      if (!slug) continue;
      try {
        const page = await yandexApiGet(`/landing3/genre/${encodeURIComponent(slug)}`);
        collectArtistIds(page, ids);
      } catch {
        /* жанр без витрины */
      }
      await sleep(80);
      if (ids.size >= MAX_IDS_TO_CHECK) break;
    }
  } catch {
    /* жанры недоступны */
  }

  const queries = [
    'хит', 'популярное', 'русский рэп', 'поп', 'рок', 'phonk', 'rnb',
    'моргенштерн', 'morgenstern', 'инстасамка', 'мияхеева', 'macan',
    'скриптонит', 'kreed', 'jony', 'anna asti', 'artik asti',
    ...[...'абвгдежзиклмнопрстуфхцчшэюя'],
    ...[...'abcdefghijklmnopqrstuvwxyz'],
  ];
  for (const query of queries) {
    if (ids.size >= MAX_IDS_TO_CHECK) break;
    for (const found of await searchArtistIds(query, 1)) add(found);
  }

  const seeds = [...ids].slice(0, 80);
  for (const seed of seeds) {
    if (ids.size >= MAX_IDS_TO_CHECK) break;
    for (const found of await similarArtistIds(seed)) add(found);
    await sleep(100);
  }

  return [...ids].slice(0, MAX_IDS_TO_CHECK);
}

function coverHttpUrl(uri: unknown, size = '1000x1000'): string | null {
  if (typeof uri !== 'string' || !uri.trim()) return null;
  let url = uri.trim().replace('%%', size);
  if (url.startsWith('//')) url = `https:${url}`;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

function coverUrisFrom(node: any): string[] {
  const out: string[] = [];
  const push = (uri: unknown) => {
    const url = coverHttpUrl(uri);
    if (url) out.push(url);
  };
  if (!node || typeof node !== 'object') return out;
  push(node.uri);
  push(node.ogImage);
  if (node.cover) {
    push(node.cover.uri);
    push(node.cover.ogImage);
  }
  if (Array.isArray(node.covers)) {
    for (const cover of node.covers) push(cover?.uri);
  }
  return out;
}

async function saveCover(url: string): Promise<string | null> {
  try {
    const buf = await yandexFetchBuffer(url);
    if (buf.length < 800) return null;
    fs.mkdirSync(COVERS_DIR, { recursive: true });
    const name = `ym-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    fs.writeFileSync(path.join(COVERS_DIR, name), buf);
    return name;
  } catch {
    return null;
  }
}

function monthlyListeners(brief: any): number {
  const stats = brief?.stats ?? brief?.artist?.stats ?? {};
  const value =
    stats.lastMonthListeners ??
    stats.last_month_listeners ??
    brief?.artist?.likesCount ??
    0;
  return Number(value) || 0;
}

function artistNameFrom(brief: any): string {
  return String(brief?.artist?.name ?? brief?.name ?? '').trim();
}

function artistBioFrom(about: any, brief: any): string | null {
  const raw =
    about?.fullDescription ||
    about?.description ||
    about?.artist?.description ||
    brief?.description ||
    brief?.artist?.description ||
    null;
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\r\n?/g, '\n').trim();
  return text ? text.slice(0, 4000) : null;
}

function albumTitle(row: any): string {
  return String(row?.title ?? '').trim();
}

function albumYear(row: any): number | null {
  const year = Number(row?.year);
  return Number.isFinite(year) && year > 1900 && year < 2100 ? year : null;
}

function isSkipAlbum(row: any): boolean {
  const type = String(row?.type ?? row?.metaType ?? '').toLowerCase();
  if (type.includes('podcast') || type.includes('audiobook') || type.includes('fairy')) return true;
  return !albumTitle(row);
}

async function fetchDirectAlbums(yandexArtistId: string): Promise<any[]> {
  const albums: any[] = [];
  for (let page = 0; page < MAX_ALBUM_PAGES; page++) {
    const json = await yandexApiGet(
      `/artists/${encodeURIComponent(yandexArtistId)}/direct-albums?page=${page}&page-size=50&sort-by=year`
    );
    const rows = json?.result?.albums ?? json?.result ?? [];
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) break;
    albums.push(...list);
    if (list.length < 50) break;
    await sleep(150);
  }
  return albums;
}

function uniqueUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    const key = url.replace(/\/\d+x\d+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

async function runImport(seedQuery?: string) {
  if (!job) return;
  const ids = await collectPopularArtistIds(seedQuery);
  if (!ids.length) {
    job.status = 'error';
    job.message = seedQuery
      ? `Яндекс не нашёл «${seedQuery}». Если артиста нет в каталоге Яндекса, его оттуда не забрать.`
      : 'Яндекс не отдал популярных артистов. Проверь подключение.';
    return;
  }

  job.message = `Проверяем ${ids.length} артистов (чарт, жанры, поиск, похожие)…`;
  const existing = await prisma.artist.findMany({ select: { id: true, name: true, imageUrl: true } });
  const byName = new Map(existing.map((row) => [row.name.trim().toLowerCase(), row]));

  const queue = [...ids];
  const seenIds = new Set<string>();
  let processed = 0;
  while (queue.length) {
    if (!job || job.status !== 'running') return;
    if (job.artistsCreated >= MAX_NEW_ARTISTS) break;
    const yandexId = queue.shift()!;
    if (seenIds.has(yandexId)) continue;
    seenIds.add(yandexId);
    processed += 1;
    job.current = yandexId;
    job.message = `Артист ${processed} · в очереди ещё ${queue.length}…`;

    try {
      await sleep(220);
      const brief = await yandexApiGet(`/artists/${encodeURIComponent(yandexId)}/brief-info`);
      const result = brief?.result ?? brief;
      const listeners = monthlyListeners(result);
      const name = artistNameFrom(result);
      if (!name) {
        job.skipped += 1;
        continue;
      }
      if (listeners < MIN_MONTHLY_LISTENERS) {
        job.skipped += 1;
        continue;
      }

      job.current = name;
      job.message = `${name} · ${listeners.toLocaleString('ru-RU')} слушателей`;

      if (seenIds.size + queue.length < MAX_IDS_TO_CHECK) {
        for (const related of await similarArtistIds(yandexId)) {
          if (!seenIds.has(related)) queue.push(related);
        }
      }

      let about: any = null;
      try {
        about = (await yandexApiGet(`/artists/${encodeURIComponent(yandexId)}/about`))?.result;
      } catch {
        about = null;
      }
      const bio = artistBioFrom(about, result);

      const key = name.toLowerCase();
      let artist = byName.get(key);
      let created = false;
      if (!artist) {
        const row = await prisma.artist.create({ data: { name, bio } });
        artist = { id: row.id, name: row.name, imageUrl: row.imageUrl };
        byName.set(key, artist);
        job.artistsCreated += 1;
        created = true;
      } else {
        if (bio) {
          await prisma.artist.update({
            where: { id: artist.id },
            data: { bio },
          });
        }
        job.artistsUpdated += 1;
      }

      const photoUrls = uniqueUrls([
        ...coverUrisFrom(result?.artist),
        ...coverUrisFrom(result),
        ...(Array.isArray(result?.allCovers) ? result.allCovers.flatMap((cover: any) => coverUrisFrom(cover)) : []),
      ]).slice(0, MAX_PHOTOS);

      const existingPhotos = await prisma.artistPhoto.findMany({
        where: { artistId: artist.id },
        orderBy: { position: 'asc' },
      });
      let position = existingPhotos.length;
      let primary = artist.imageUrl;

      for (const url of photoUrls) {
        if (position >= MAX_PHOTOS && primary) break;
        await sleep(80);
        const filename = await saveCover(url);
        if (!filename) continue;
        const already = await prisma.artistPhoto.findUnique({
          where: { artistId_imageUrl: { artistId: artist.id, imageUrl: filename } },
        });
        if (!already) {
          await prisma.artistPhoto.create({
            data: { artistId: artist.id, imageUrl: filename, position },
          });
          position += 1;
          job.photosSaved += 1;
        }
        if (!primary) primary = filename;
      }
      if (primary && artist.imageUrl !== primary) {
        await prisma.artist.update({ where: { id: artist.id }, data: { imageUrl: primary } });
        artist.imageUrl = primary;
      }

      const albums = await fetchDirectAlbums(yandexId);
      const knownAlbums = await prisma.album.findMany({
        where: { artistId: artist.id },
        select: { title: true, year: true },
      });
      const albumKeys = new Set(knownAlbums.map((row) => `${row.title.trim().toLowerCase()}::${row.year ?? ''}`));

      for (const row of albums) {
        if (isSkipAlbum(row)) continue;
        const title = albumTitle(row);
        const year = albumYear(row);
        const albumKey = `${title.toLowerCase()}::${year ?? ''}`;
        if (albumKeys.has(albumKey)) continue;
        albumKeys.add(albumKey);
        const cover = coverHttpUrl(row.coverUri || row.cover?.uri, '700x700');
        const coverUrl = cover ? await saveCover(cover) : null;
        await prisma.album.create({
          data: {
            title,
            year,
            artistId: artist.id,
            coverUrl,
          },
        });
        job.albumsCreated += 1;
      }

      if (!created && !albums.length && !photoUrls.length) {
        /* already counted as updated */
      }
    } catch (err) {
      job.skipped += 1;
      job.message = err instanceof Error ? err.message : 'Пропустили артиста';
    }
  }

  job.current = null;
  job.status = 'done';
  job.message =
    `Готово: +${job.artistsCreated} артистов, обновлено ${job.artistsUpdated}, ` +
    `+${job.albumsCreated} альбомов, +${job.photosSaved} фото. ` +
    `Пропущено ${job.skipped} (меньше 100 тыс. слушателей или уже есть).`;
}
