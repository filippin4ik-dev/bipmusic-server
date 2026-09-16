import { prisma } from '../db.js';
import { stripCryptoFields } from './stripCrypto.js';

const artistCreditInclude = {
  include: { artist: true },
  orderBy: { position: 'asc' as const },
};

export const trackInclude = {
  artist: true,
  album: {
    include: {
      artist: true,
      albumArtists: artistCreditInclude,
    },
  },
  trackArtists: artistCreditInclude,
} as const;

export const albumInclude = {
  artist: true,
  albumArtists: artistCreditInclude,
} as const;

export const albumDetailInclude = {
  ...albumInclude,
  tracks: { include: trackInclude, orderBy: { createdAt: 'asc' as const } },
} as const;

type TrackRow = {
  trackArtists?: Array<{ role: string; artist: unknown }>;
  encKey?: string | null;
  encNonce?: string | null;
  album?: AlbumRow | null;
  [key: string]: unknown;
};

type AlbumRow = {
  albumArtists?: Array<{ role: string; artist: unknown }>;
  tracks?: TrackRow[];
  [key: string]: unknown;
};

type ArtistCredit = { role: string; artist: unknown; artistId?: string };

function featArtists(credits: Array<ArtistCredit> | undefined) {
  return (credits ?? [])
    .filter((c) => c.role === 'feat')
    .map((c) => c.artist)
    .filter(Boolean);
}

/** Track-level feat credits first, then album-level (deduped by artist id). */
function mergeFeaturedArtists(
  trackCredits: Array<ArtistCredit> | undefined,
  albumCredits: Array<ArtistCredit> | undefined,
) {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const credits of [trackCredits, albumCredits]) {
    for (const c of credits ?? []) {
      if (c.role !== 'feat' || !c.artist) continue;
      const id =
        (c.artist as { id?: string }).id ??
        c.artistId ??
        (c as { artistId?: string }).artistId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(c.artist);
    }
  }
  return out;
}

export function serializeTrack<T extends TrackRow>(track: T): Record<string, unknown> {
  const featuredArtists = mergeFeaturedArtists(
    track.trackArtists,
    track.album?.albumArtists,
  );
  const { trackArtists, encKey, encNonce, album, ...rest } = track;
  const serializedAlbum = album ? serializeAlbum(album) : null;
  // A track that belongs to an album shows the album artwork. Resolving it here
  // instead of copying the filename into Track.coverUrl keeps one file per cover
  // (so deleting a track can never unlink the album's image) and lets the track's
  // own cover come back if it is ever detached from the album.
  const albumCover = album?.coverUrl;
  const coverUrl =
    typeof albumCover === 'string' && albumCover ? albumCover : rest.coverUrl ?? null;
  return stripCryptoFields({
    ...rest,
    coverUrl,
    album: serializedAlbum,
    featuredArtists,
  }) as Record<string, unknown>;
}

/**
 * Порядок треков в альбоме — тот, что выставил админ.
 *
 * Сортируем в коде, а не запросом: у треков без номера (синглы, всё
 * загруженное до появления порядка) `trackNumber` пустой, а SQLite ставит
 * NULL в начало при `ORDER BY ... ASC` — такие треки прыгали бы перед
 * размеченными. Здесь они уезжают в конец по дате загрузки.
 */
function sortAlbumTracks(tracks: TrackRow[]): TrackRow[] {
  const uploadedAt = (row: TrackRow) => {
    const value = row.createdAt;
    if (value instanceof Date) return value.getTime();
    const parsed = Date.parse(String(value ?? ''));
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  return [...tracks].sort((a, b) => {
    const left = typeof a.trackNumber === 'number' ? a.trackNumber : Number.MAX_SAFE_INTEGER;
    const right = typeof b.trackNumber === 'number' ? b.trackNumber : Number.MAX_SAFE_INTEGER;
    if (left !== right) return left - right;
    return uploadedAt(a) - uploadedAt(b);
  });
}

export function serializeAlbum<T extends AlbumRow>(album: T): Record<string, unknown> {
  const featuredArtists = featArtists(album.albumArtists);
  const { albumArtists, tracks, ...rest } = album;
  const serializedTracks = tracks && sortAlbumTracks(tracks).map((t) => serializeTrack(t));
  return stripCryptoFields({
    ...rest,
    ...(serializedTracks ? { tracks: serializedTracks } : {}),
    featuredArtists,
  }) as Record<string, unknown>;
}

export function serializeTracks<T extends TrackRow>(tracks: T[]): Record<string, unknown>[] {
  return tracks.map(serializeTrack);
}

export function serializeLikes<T extends { track?: TrackRow | null }>(likes: T[]) {
  return likes.map((like) => ({
    ...like,
    track: like.track ? serializeTrack(like.track) : like.track,
  }));
}

export function parseFeatArtistIds(raw: unknown): string[] {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) {
    return raw.map(String).map((s) => s.trim()).filter(Boolean);
  }
  const text = String(raw).trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.map(String).map((s) => s.trim()).filter(Boolean);
      }
    } catch {
      /* fall through */
    }
  }
  return text.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

export async function getAlbumFeatArtistIds(albumId: string): Promise<string[]> {
  const rows = await prisma.albumArtist.findMany({
    where: { albumId, role: 'feat' },
    orderBy: { position: 'asc' },
  });
  return rows.map((r) => r.artistId);
}

export async function syncTrackFeatArtists(trackId: string, featArtistIds: string[]) {
  const unique = [...new Set(featArtistIds.filter(Boolean))];
  await prisma.trackArtist.deleteMany({ where: { trackId, role: 'feat' } });
  for (let i = 0; i < unique.length; i++) {
    await prisma.trackArtist.create({
      data: { trackId, artistId: unique[i], role: 'feat', position: i },
    });
  }
}

async function propagateAlbumFeatToTracks(albumId: string, albumFeatIds: string[]) {
  const tracks = await prisma.track.findMany({
    where: { albumId },
    select: { id: true },
  });
  for (const { id: trackId } of tracks) {
    const existing = await prisma.trackArtist.findMany({
      where: { trackId, role: 'feat' },
      select: { artistId: true },
    });
    const merged = [
      ...new Set([...albumFeatIds, ...existing.map((e) => e.artistId)]),
    ];
    await syncTrackFeatArtists(trackId, merged);
  }
}

export async function syncAlbumFeatArtists(albumId: string, featArtistIds: string[]) {
  const unique = [...new Set(featArtistIds.filter(Boolean))];
  await prisma.albumArtist.deleteMany({ where: { albumId, role: 'feat' } });
  for (let i = 0; i < unique.length; i++) {
    await prisma.albumArtist.create({
      data: { albumId, artistId: unique[i], role: 'feat', position: i },
    });
  }
  await propagateAlbumFeatToTracks(albumId, unique);
}

/** One-time style repair: copy album feat credits onto tracks that have none yet. */
export async function backfillTrackFeatsFromAlbums() {
  const albums = await prisma.album.findMany({
    where: { albumArtists: { some: { role: 'feat' } } },
    include: {
      albumArtists: { where: { role: 'feat' }, orderBy: { position: 'asc' } },
      tracks: { select: { id: true } },
    },
  });

  let updated = 0;
  for (const album of albums) {
    const featIds = album.albumArtists.map((a) => a.artistId);
    if (!featIds.length) continue;
    for (const track of album.tracks) {
      const count = await prisma.trackArtist.count({
        where: { trackId: track.id, role: 'feat' },
      });
      if (count === 0) {
        await syncTrackFeatArtists(track.id, featIds);
        updated++;
      }
    }
  }
  if (updated > 0) {
    console.log(`🎤 Backfilled feat artists on ${updated} track(s) from album credits`);
  }
}
