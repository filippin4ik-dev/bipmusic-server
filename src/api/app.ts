import express, { Request, Response } from 'express';
import { hostedIpaFilename, otaManifest, publicRelease, readRelease } from '../services/appRelease.js';

const router = express.Router();

function originOf(req: Request): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host') ?? 'bipmusic.ru'}`;
}

router.get('/latest', (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  const release = readRelease();
  if (!release) return res.json({ data: null });
  res.json({ data: publicRelease(release, originOf(_req)) });
});

router.get('/manifest.plist', (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  const release = readRelease();
  const ipaFilename = hostedIpaFilename(release);
  if (!ipaFilename) return res.status(404).type('text').send('No IPA');
  const xml = otaManifest({
    origin: originOf(req),
    ipaFilename,
    bundleId: process.env.APP_BUNDLE_ID || 'bipmusic.bip',
    version: release.version,
    title: 'bipMusic',
  });
  res.type('application/xml').send(xml);
});

export default router;
