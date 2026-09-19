import { createHmac } from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Те же эндпоинты, что у LuckyWins/yandex-music-api (порт MarshalX):
 *   search()        GET /search?type=track
 *   tracksLyrics()  GET /tracks/{id}/lyrics?format=LRC
 *
 * PHP в Docker не крутим — ходим в api.music.yandex.net напрямую.
 */
const API = 'https://api.music.yandex.net';
const OAUTH = 'https://oauth.yandex.ru';
const USER_AGENT = 'Yandex-Music-API';
const CLIENT = 'YandexMusicAndroid/24023621';
const SIGN_KEY = 'p93jhgh689SBReK6ghtw62';
const DEFAULT_CLIENT_ID = '23cabbbdc6cd418abb4b39c32c41195d';
const DEFAULT_CLIENT_SECRET = '53bc75238f0c4d08a118e51fe9203300';
const TOKEN_FILE = path.resolve(process.env.DATA_DIR || './data', 'yandex-token.json');

export class YandexMusicError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type TokenFile = { accessToken: string; savedAt?: string };

export function normalizeYandexToken(raw: string): string {
  return raw
    .trim()
    .replace(/^OAuth\s+/i, '')
    .replace(/^Bearer\s+/i, '')
    .replace(/^["']+|["']+$/g, '')
    .replace(/\s+/g, '');
}

export function getYandexToken(): string | null {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as TokenFile;
      const token = normalizeYandexToken(raw.accessToken ?? '');
      if (token) return token;
    }
  } catch {
    /* fall through to env */
  }
  const fromEnv = normalizeYandexToken(process.env.YANDEX_MUSIC_TOKEN ?? '');
  return fromEnv || null;
}

export function isYandexConfigured(): boolean {
  return Boolean(getYandexToken());
}

export function saveYandexToken(token: string) {
  const clean = normalizeYandexToken(token);
  if (!clean) throw new YandexMusicError('Пустой токен');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(
    TOKEN_FILE,
    JSON.stringify({ accessToken: clean, savedAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 }
  );
}

export function clearYandexToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  } catch {
    /* ignore */
  }
}

function headers(token?: string | null, forMedia = false): Record<string, string> {
  if (forMedia) {
    return { 'User-Agent': USER_AGENT };
  }
  const h: Record<string, string> = {
    'User-Agent': USER_AGENT,
    'X-Yandex-Music-Client': CLIENT,
    'Accept-Language': 'ru',
    Accept: 'application/json',
  };
  if (token) h.Authorization = `OAuth ${token}`;
  return h;
}

function signLyrics(trackId: string): { timeStamp: number; sign: string } {
  const timeStamp = Math.floor(Date.now() / 1000);
  const sign = createHmac('sha256', SIGN_KEY).update(`${trackId}${timeStamp}`).digest('base64');
  return { timeStamp, sign };
}

function yandexMessage(json: any, status: number): string {
  const raw =
    json?.error?.message ||
    json?.errorDescription ||
    json?.error_description ||
    (typeof json?.error === 'string' ? json.error : null);
  if (raw) return String(raw);
  return `Яндекс ответил ${status}`;
}

async function yandexGet(url: string, token: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { headers: headers(token), signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new YandexMusicError(
      `Не достучались до Яндекс Музыки: ${err instanceof Error ? err.message : 'сеть'}`,
      502
    );
  }
  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    // Никогда не отдаём 401 клиенту приложения — иначе iOS думает,
    // что протух вход в bipMusic, и крутит refresh по кругу.
    throw new YandexMusicError(yandexMessage(json, res.status), 400);
  }
  return json;
}

export async function verifyYandexToken(token: string): Promise<void> {
  const json = await yandexGet(`${API}/account/status`, token);
  if (!json?.result?.account && !json?.result?.plus && json?.result == null) {
    throw new YandexMusicError('Яндекс не подтвердил этот токен', 400);
  }
}

export type YandexSearchHit = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  durationMs: number | null;
  hasSyncLyrics: boolean;
};

export async function searchTracks(query: string): Promise<YandexSearchHit[]> {
  const token = getYandexToken();
  if (!token) throw new YandexMusicError('Яндекс Музыка не подключена', 400);
  const q = query.trim();
  if (!q) throw new YandexMusicError('Введи название трека');

  const url = `${API}/search?text=${encodeURIComponent(q)}&type=track&page=0&nocorrect=false`;
  const json = await yandexGet(url, token);
  const rows = json?.result?.tracks?.results;
  if (!Array.isArray(rows)) return [];

  return rows.slice(0, 20).map((row: any) => {
    const artists = Array.isArray(row.artists)
      ? row.artists.map((a: any) => a?.name).filter(Boolean).join(', ')
      : '';
    const album = Array.isArray(row.albums) && row.albums[0]?.title ? String(row.albums[0].title) : null;
    const info = row.lyricsInfo ?? {};
    return {
      id: String(row.id),
      title: String(row.title ?? ''),
      artist: artists || 'Неизвестный артист',
      album,
      durationMs: typeof row.durationMs === 'number' ? row.durationMs : null,
      hasSyncLyrics: Boolean(info.hasAvailableSyncLyrics),
    };
  });
}

function stripEnhancedLrc(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/<\d+:\d+(?:\.\d+)?>/g, '').replace(/\s+/g, ' ').trimEnd())
    .join('\n')
    .trim();
}

function hasTimeTags(lrc: string): boolean {
  return /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/.test(lrc);
}

export async function fetchTimedLyrics(yandexTrackId: string, durationMs?: number): Promise<{
  lyrics: string;
  timed: boolean;
  source: string | null;
}> {
  const token = getYandexToken();
  if (!token) throw new YandexMusicError('Яндекс Музыка не подключена', 400);
  const id = String(yandexTrackId).split(':')[0].trim();
  if (!/^\d+$/.test(id)) throw new YandexMusicError('Некорректный id трека Яндекса');

  const { timeStamp, sign } = signLyrics(id);
  const params = new URLSearchParams({
    format: 'LRC',
    timeStamp: String(timeStamp),
    sign,
  });
  if (durationMs && durationMs > 0) params.set('durationMs', String(durationMs));

  const json = await yandexGet(`${API}/tracks/${id}/lyrics?${params.toString()}`, token);
  const result = json?.result;
  const downloadUrl = result?.downloadUrl;
  if (!downloadUrl) {
    throw new YandexMusicError('У этого трека в Яндексе нет текста с таймкодами', 404);
  }

  let file: Response;
  try {
    file = await fetch(String(downloadUrl), {
      headers: headers(null, true),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new YandexMusicError('Не удалось скачать LRC с Яндекса', 502);
  }
  if (!file.ok) throw new YandexMusicError('Не удалось скачать LRC с Яндекса', 502);
  const lyrics = stripEnhancedLrc(await file.text());
  if (!lyrics) throw new YandexMusicError('Яндекс вернул пустой текст', 404);
  if (!hasTimeTags(lyrics)) {
    throw new YandexMusicError('Яндекс отдал текст без таймкодов — такой не подставляем', 404);
  }

  return {
    lyrics,
    timed: true,
    source: result?.major?.prettyName || result?.major?.name || null,
  };
}

export async function requestDeviceCode(): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
  expiresIn: number;
}> {
  const body = new URLSearchParams({
    client_id: DEFAULT_CLIENT_ID,
    device_id: Math.random().toString(36).slice(2, 12),
    device_name: 'YandexMusicAPI',
  });
  const res = await fetch(`${OAUTH}/device/code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok || !json?.device_code || !json?.user_code) {
    throw new YandexMusicError(json?.error_description || json?.error || 'Не удалось получить код Яндекса', 400);
  }
  return {
    deviceCode: String(json.device_code),
    userCode: String(json.user_code),
    verificationUrl: String(json.verification_url || 'https://oauth.yandex.ru/device'),
    interval: Number(json.interval) || 5,
    expiresIn: Number(json.expires_in) || 300,
  };
}

export async function pollDeviceToken(deviceCode: string): Promise<{ pending: true } | { pending: false }> {
  const body = new URLSearchParams({
    grant_type: 'device_code',
    code: deviceCode,
    client_id: DEFAULT_CLIENT_ID,
    client_secret: DEFAULT_CLIENT_SECRET,
  });
  const res = await fetch(`${OAUTH}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => null)) as any;
  if (json?.error === 'authorization_pending' || json?.error === 'slow_down') {
    return { pending: true };
  }
  if (!res.ok || !json?.access_token) {
    throw new YandexMusicError(json?.error_description || json?.error || 'Яндекс не выдал токен', 400);
  }
  const token = normalizeYandexToken(String(json.access_token));
  await verifyYandexToken(token);
  saveYandexToken(token);
  return { pending: false };
}

export async function saveAndVerifyYandexToken(token: string) {
  const clean = normalizeYandexToken(token);
  await verifyYandexToken(clean);
  saveYandexToken(clean);
}
