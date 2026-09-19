import { createHmac } from 'crypto';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { URL } from 'url';

/**
 * Те же эндпоинты, что у LuckyWins/yandex-music-api (порт MarshalX):
 *   search()        GET /search?type=track
 *   tracksLyrics()  GET /tracks/{id}/lyrics?format=LRC
 *
 * PHP в Docker не крутим. Ходим в api.music.yandex.net по HTTP/1.1 —
 * Node fetch/HTTP/2 Яндекс часто режет 403 сразу после OAuth.
 */
const API_HOSTS = ['https://api.music.yandex.net', 'https://api.music.yandex.ru'];
const OAUTH = 'https://oauth.yandex.ru';
const USER_AGENT = 'Yandex-Music-API';
const CLIENT = 'YandexMusicAndroid/24023621';
const SIGN_KEY = 'p93jhgh689SBReK6ghtw62';
const DEFAULT_CLIENT_ID = '23cabbbdc6cd418abb4b39c32c41195d';
const DEFAULT_CLIENT_SECRET = '53bc75238f0c4d08a118e51fe9203300';
const TOKEN_FILE = path.resolve(process.env.DATA_DIR || './data', 'yandex-token.json');

const HEADER_PROFILES: Record<string, string>[] = [
  { 'User-Agent': USER_AGENT, 'X-Yandex-Music-Client': CLIENT },
  { 'User-Agent': USER_AGENT, 'X-Yandex-Music-Client': CLIENT, 'Accept-Language': 'ru' },
  {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'X-Yandex-Music-Client': CLIENT,
  },
  {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  },
];

export class YandexMusicError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type TokenFile = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  savedAt?: string;
};

type HttpResult = { status: number; json: any; text: string };

let workingProfile = 0;
let workingHost = API_HOSTS[0];
let refreshing: Promise<boolean> | null = null;

export function normalizeYandexToken(raw: string): string {
  return raw
    .trim()
    .replace(/^OAuth\s+/i, '')
    .replace(/^Bearer\s+/i, '')
    .replace(/^["']+|["']+$/g, '')
    .replace(/\s+/g, '');
}

function readTokenFile(): TokenFile | null {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as TokenFile;
    const accessToken = normalizeYandexToken(raw.accessToken ?? '');
    if (!accessToken) return null;
    return { ...raw, accessToken };
  } catch {
    return null;
  }
}

export function getYandexToken(): string | null {
  const fromFile = readTokenFile()?.accessToken;
  if (fromFile) return fromFile;
  const fromEnv = normalizeYandexToken(process.env.YANDEX_MUSIC_TOKEN ?? '');
  return fromEnv || null;
}

export function isYandexConfigured(): boolean {
  return Boolean(getYandexToken());
}

function writeTokenFile(data: TokenFile) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function saveYandexToken(token: string, extra: Partial<TokenFile> = {}) {
  const clean = normalizeYandexToken(token);
  if (!clean) throw new YandexMusicError('Пустой токен');
  const prev = readTokenFile();
  writeTokenFile({
    accessToken: clean,
    refreshToken: extra.refreshToken ?? prev?.refreshToken,
    expiresAt: extra.expiresAt ?? prev?.expiresAt,
    savedAt: new Date().toISOString(),
  });
}

export function clearYandexToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  } catch {
    /* ignore */
  }
  workingProfile = 0;
  workingHost = API_HOSTS[0];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpRequest(url: string, method: string, headers: Record<string, string>, body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqHeaders = { ...headers };
    if (body) reqHeaders['Content-Length'] = String(Buffer.byteLength(body));
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method,
        headers: reqHeaders,
        timeout: 20_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode || 0, json, text });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new YandexMusicError('Яндекс не ответил вовремя', 502));
    });
    req.on('error', (err) => {
      reject(new YandexMusicError(`Не достучались до Яндекс Музыки: ${err.message}`, 502));
    });
    if (body) req.write(body);
    req.end();
  });
}

function yandexMessage(status: number, json: any, text: string): string {
  const name = typeof json?.error === 'string' ? json.error : json?.error?.name;
  const raw =
    json?.error?.message ||
    json?.errorDescription ||
    json?.error_description ||
    (typeof json?.error === 'string' ? json.error : null);
  const blob = `${text} ${name ?? ''} ${raw ?? ''}`.toLowerCase();
  if (status === 403 && /captcha|antirobot|smartcaptcha|checkbox/.test(blob)) {
    return 'Яндекс временно заблокировал запрос с сервера. Подожди минуту и подключи ещё раз.';
  }
  if (status === 401 || status === 403) {
    if (/session-expired|unauthorized|not-allowed/.test(blob)) {
      return 'Яндекс не принял токен. Подключи аккаунт ещё раз.';
    }
    if (raw && String(raw) !== String(name)) return String(raw);
    return 'Яндекс ответил 403 сразу после входа — обычно это антибот. Подожди минуту и нажми «Подключить» ещё раз.';
  }
  if (raw) return String(raw);
  return `Яндекс ответил ${status}`;
}

function isExpiredAuth(status: number, json: any, text: string): boolean {
  const blob = `${text} ${JSON.stringify(json ?? {})}`.toLowerCase();
  return status === 401 || /session-expired|unauthorized/.test(blob);
}

async function refreshYandexToken(): Promise<boolean> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const stored = readTokenFile();
    const refresh = stored?.refreshToken?.trim();
    if (!refresh) return false;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: DEFAULT_CLIENT_ID,
      client_secret: DEFAULT_CLIENT_SECRET,
    }).toString();
    const res = await httpRequest(`${OAUTH}/token`, 'POST', {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
      'X-Yandex-Music-Client': CLIENT,
    }, body);
    if (res.status >= 400 || !res.json?.access_token) return false;
    persistOAuthToken(res.json);
    return true;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

function persistOAuthToken(json: any) {
  const access = normalizeYandexToken(String(json.access_token ?? ''));
  if (!access) throw new YandexMusicError('Яндекс не выдал токен', 400);
  const expiresIn = Number(json.expires_in);
  saveYandexToken(access, {
    refreshToken: json.refresh_token ? String(json.refresh_token) : undefined,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : undefined,
  });
}

function withAuth(profile: Record<string, string>, token?: string | null): Record<string, string> {
  const headers = { ...profile };
  if (token) headers.Authorization = `OAuth ${token}`;
  return headers;
}

async function yandexGet(pathAndQuery: string, token: string): Promise<any> {
  const profiles = [
    HEADER_PROFILES[workingProfile],
    ...HEADER_PROFILES.filter((_, i) => i !== workingProfile),
  ];
  const hosts = [workingHost, ...API_HOSTS.filter((h) => h !== workingHost)];

  let last: HttpResult | null = null;
  let refreshed = false;

  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) await sleep(1500);
    for (const host of hosts) {
      for (let i = 0; i < profiles.length; i++) {
        const profile = profiles[i];
        last = await httpRequest(`${host}${pathAndQuery}`, 'GET', withAuth(profile, token));
        if (last.status >= 200 && last.status < 300) {
          workingHost = host;
          workingProfile = HEADER_PROFILES.indexOf(profile);
          if (workingProfile < 0) workingProfile = 0;
          return last.json;
        }
        if (!refreshed && isExpiredAuth(last.status, last.json, last.text)) {
          refreshed = true;
          if (await refreshYandexToken()) {
            token = getYandexToken() ?? token;
            last = await httpRequest(`${host}${pathAndQuery}`, 'GET', withAuth(profile, token));
            if (last.status >= 200 && last.status < 300) {
              workingHost = host;
              workingProfile = HEADER_PROFILES.indexOf(profile);
              if (workingProfile < 0) workingProfile = 0;
              return last.json;
            }
          }
        }
        if (last.status !== 401 && last.status !== 403) {
          throw new YandexMusicError(yandexMessage(last.status, last.json, last.text), 400);
        }
      }
    }
  }

  throw new YandexMusicError(yandexMessage(last?.status ?? 403, last?.json, last?.text ?? ''), 400);
}

export async function verifyYandexToken(token: string): Promise<void> {
  // /account/status Яндекс часто режет антиботом сразу после OAuth.
  // Поиск — тот же авторизованный метод, но спокойнее.
  const json = await yandexGet('/search?text=%D0%B0&type=track&page=0&nocorrect=true', token);
  if (json?.result == null && json?.error) {
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

  const json = await yandexGet(
    `/search?text=${encodeURIComponent(q)}&type=track&page=0&nocorrect=false`,
    token
  );
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

function signLyrics(trackId: string): { timeStamp: number; sign: string } {
  const timeStamp = Math.floor(Date.now() / 1000);
  const sign = createHmac('sha256', SIGN_KEY).update(`${trackId}${timeStamp}`).digest('base64');
  return { timeStamp, sign };
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

  const json = await yandexGet(`/tracks/${id}/lyrics?${params.toString()}`, token);
  const result = json?.result;
  const downloadUrl = result?.downloadUrl;
  if (!downloadUrl) {
    throw new YandexMusicError('У этого трека в Яндексе нет текста с таймкодами', 404);
  }

  const file = await httpRequest(String(downloadUrl), 'GET', { 'User-Agent': USER_AGENT });
  if (file.status >= 400 || !file.text.trim()) {
    throw new YandexMusicError('Не удалось скачать LRC с Яндекса', 502);
  }
  const lyrics = stripEnhancedLrc(file.text);
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
  }).toString();
  const res = await httpRequest(`${OAUTH}/device/code`, 'POST', {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': USER_AGENT,
    'X-Yandex-Music-Client': CLIENT,
  }, body);
  if (res.status >= 400 || !res.json?.device_code || !res.json?.user_code) {
    throw new YandexMusicError(
      res.json?.error_description || res.json?.error || 'Не удалось получить код Яндекса',
      400
    );
  }
  return {
    deviceCode: String(res.json.device_code),
    userCode: String(res.json.user_code),
    verificationUrl: String(res.json.verification_url || 'https://oauth.yandex.ru/device'),
    interval: Number(res.json.interval) || 5,
    expiresIn: Number(res.json.expires_in) || 300,
  };
}

export async function pollDeviceToken(deviceCode: string): Promise<{ pending: true } | { pending: false }> {
  const body = new URLSearchParams({
    grant_type: 'device_code',
    code: deviceCode,
    client_id: DEFAULT_CLIENT_ID,
    client_secret: DEFAULT_CLIENT_SECRET,
  }).toString();
  const res = await httpRequest(`${OAUTH}/token`, 'POST', {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': USER_AGENT,
    'X-Yandex-Music-Client': CLIENT,
  }, body);
  if (res.json?.error === 'authorization_pending' || res.json?.error === 'slow_down') {
    return { pending: true };
  }
  if (res.status >= 400 || !res.json?.access_token) {
    throw new YandexMusicError(res.json?.error_description || res.json?.error || 'Яндекс не выдал токен', 400);
  }
  persistOAuthToken(res.json);
  // Токен уже наш. Проверку не валим из‑за антибота: даём Яндексу секунду
  // и пробуем поиск с несколькими заголовками.
  await sleep(800);
  try {
    await verifyYandexToken(getYandexToken()!);
  } catch (err) {
    if (!(err instanceof YandexMusicError) || !/403|антибот|заблокировал/.test(err.message)) {
      throw err;
    }
  }
  return { pending: false };
}

export async function saveAndVerifyYandexToken(token: string) {
  const clean = normalizeYandexToken(token);
  saveYandexToken(clean);
  await sleep(400);
  try {
    await verifyYandexToken(clean);
  } catch (err) {
    if (!(err instanceof YandexMusicError) || !/403|антибот|заблокировал/.test(err.message)) {
      clearYandexToken();
      throw err;
    }
  }
}
