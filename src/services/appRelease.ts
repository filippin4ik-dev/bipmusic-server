import fs from 'fs';
import path from 'path';

/**
 * Последняя сборка приложения. Живёт файлом, не в SQLite: IPA большой, а
 * метаданные должны пережить пересборку контейнера вместе с томом /app/data.
 */
export type AppRelease = {
  version: string;
  build: number;
  notes: string | null;
  /** Ссылка Diawi — её надо открывать в Safari, иначе iOS не ставит IPA. */
  diawiUrl: string | null;
  ipaFilename: string | null;
  publishedAt: string;
};

const APP_DIR = path.resolve(process.env.APP_DIR || './data/app');
const META_PATH = path.join(APP_DIR, 'release.json');

export function appDir(): string {
  if (!fs.existsSync(APP_DIR)) fs.mkdirSync(APP_DIR, { recursive: true });
  return APP_DIR;
}

export function ipaPath(filename: string): string {
  return path.join(appDir(), filename);
}

/** IPA на диске есть — Diawi из JSON больше не считается. */
export function hostedIpaFilename(release: Pick<AppRelease, 'ipaFilename'> | null): string | null {
  const named = release?.ipaFilename?.trim();
  if (named) {
    try {
      if (fs.existsSync(ipaPath(named))) return named;
    } catch {
      // ignore
    }
  }
  try {
    const files = fs
      .readdirSync(appDir())
      .filter((file) => file.toLowerCase().endsWith('.ipa') && !file.startsWith('upload-'));
    if (!files.length) return null;
    files.sort((a, b) => fs.statSync(ipaPath(b)).mtimeMs - fs.statSync(ipaPath(a)).mtimeMs);
    return files[0];
  } catch {
    return null;
  }
}

/** Каноническая страница установки. Новый путь — Safari не держит на нём старый 303 на Diawi. */
export function installPageUrl(release: AppRelease, origin: string): string {
  const stamp = Date.parse(release.publishedAt) || Date.now();
  return `${origin}/install?v=${encodeURIComponent(release.version)}&b=${release.build || 0}&t=${stamp}`;
}

function sanitizeRelease(release: AppRelease): AppRelease {
  const ipaOnDisk = hostedIpaFilename(release);
  const ipaName = ipaOnDisk || release.ipaFilename?.trim() || null;
  return {
    ...release,
    ipaFilename: ipaName,
    // Diawi выкидываем только когда файл реально лежит на диске.
    diawiUrl: ipaOnDisk ? null : (release.diawiUrl?.trim() || null),
  };
}

export function readRelease(): AppRelease | null {
  try {
    const raw = fs.readFileSync(META_PATH, 'utf8');
    const parsed = JSON.parse(raw) as AppRelease;
    if (!parsed?.version) return null;
    const clean = sanitizeRelease(parsed);
    if (clean.diawiUrl !== (parsed.diawiUrl || null) || clean.ipaFilename !== (parsed.ipaFilename || null)) {
      try {
        fs.writeFileSync(META_PATH, JSON.stringify(clean, null, 2));
      } catch {
        // ignore
      }
    }
    return clean;
  } catch {
    return null;
  }
}

export function writeRelease(release: AppRelease): void {
  appDir();
  const ipa = release.ipaFilename?.trim() || null;
  const clean: AppRelease = {
    ...release,
    ipaFilename: ipa,
    diawiUrl: ipa ? null : (release.diawiUrl?.trim() || null),
  };
  fs.writeFileSync(META_PATH, JSON.stringify(clean, null, 2));
}

export function publicRelease(release: AppRelease, origin: string) {
  // Ссылку всегда отдаём на свою страницу /install, никогда на Diawi:
  // Safari кэширует 303, и после загрузки IPA всё равно открывается старый билд.
  const ipa = hostedIpaFilename(release);
  return {
    version: release.version,
    build: release.build,
    notes: release.notes,
    url: installPageUrl(release, origin),
    diawiUrl: ipa ? null : release.diawiUrl,
    publishedAt: release.publishedAt,
  };
}

/**
 * Грузит IPA на Diawi и ждёт ссылку. Без токена в .env пропускаем шаг —
 * остаётся своя страница /app.
 */
export async function uploadToDiawi(filePath: string): Promise<string> {
  const token = process.env.DIAWI_TOKEN?.trim();
  if (!token) {
    throw new Error('DIAWI_TOKEN не задан');
  }
  const buf = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.set('token', token);
  form.append('file', new Blob([buf]), path.basename(filePath));
  form.set('wall_of_apps', '0');
  form.set('find_by_udid', '0');
  form.set('comment', 'bipMusic');

  const uploaded = await fetch('https://upload.diawi.com/', { method: 'POST', body: form });
  const jobBody = (await uploaded.json()) as { job?: string; message?: string };
  if (!uploaded.ok || !jobBody.job) {
    throw new Error(jobBody.message || `Diawi upload failed (${uploaded.status})`);
  }

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const statusRes = await fetch(
      `https://upload.diawi.com/status?token=${encodeURIComponent(token)}&job=${encodeURIComponent(jobBody.job)}`
    );
    const status = (await statusRes.json()) as { status?: number; message?: string; link?: string };
    if (status.status === 2000 && status.link) return status.link;
    if (status.status && status.status >= 4000) {
      throw new Error(status.message || 'Diawi отверг файл');
    }
  }
  throw new Error('Diawi слишком долго обрабатывает файл');
}

export function otaManifest(opts: {
  origin: string;
  ipaFilename: string;
  bundleId: string;
  version: string;
  title: string;
}): string {
  const ipaUrl = `${opts.origin}/files/app/${encodeURIComponent(opts.ipaFilename)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${escapeXml(ipaUrl)}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${escapeXml(opts.bundleId)}</string>
        <key>bundle-version</key>
        <string>${escapeXml(opts.version)}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${escapeXml(opts.title)}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
