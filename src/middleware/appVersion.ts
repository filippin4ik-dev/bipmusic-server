import { Request, Response, NextFunction } from 'express';
import { publicRelease, readRelease } from '../services/appRelease.js';

export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map((n) => parseInt(n, 10) || 0);
  const b = right.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function originOf(req: Request): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host') ?? 'bipmusic.ru'}`;
}

function isExempt(path: string): boolean {
  if (path === '/api/health' || path === '/health') return true;
  if (path.startsWith('/api/app')) return true;
  if (path.startsWith('/api/admin/app')) return true;
  return false;
}

/**
 * Когда на сайте лежит более новая сборка, старый клиент не ходит в каталог.
 * `/api/app/latest` открыт — по нему приложение понимает, куда качать.
 */
export function requireFreshApp(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith('/api')) return next();
  if (isExempt(req.path)) return next();

  const release = readRelease();
  if (!release?.version) return next();

  const clientVersion = String(req.get('x-app-version') || '').trim() || '0';
  const cmp = compareVersions(clientVersion, release.version);
  if (cmp > 0) return next();
  if (cmp === 0) {
    const releaseBuild = Number(release.build) || 0;
    const clientBuild = parseInt(String(req.get('x-app-build') || '0'), 10) || 0;
    if (!releaseBuild || clientBuild >= releaseBuild) return next();
  }

  res.status(426).json({
    error: `Нужно обновить приложение до ${release.version}`,
    data: publicRelease(release, originOf(req)),
  });
}
