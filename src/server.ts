import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import 'express-async-errors';
import { config } from 'dotenv';

config();

import authRoutes from './api/auth.js';
import tracksRoutes from './api/tracks.js';
import artistsRoutes from './api/artists.js';
import albumsRoutes from './api/albums.js';
import playlistsRoutes from './api/playlists.js';
import likesRoutes from './api/likes.js';
import statsRoutes from './api/stats.js';
import adminRoutes from './api/admin.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/logger.js';
import { globalLimiter } from './middleware/rateLimits.js';
import { cleanupOldAttempts } from './services/loginGuardService.js';
import { runSecurityBootCheck } from './services/securityBootCheck.js';
import { prisma } from './db.js';
import { backfillTrackFeatsFromAlbums } from './utils/trackSerialize.js';

const app = express();
const PORT = process.env.PORT || 3000;

const TRACKS_DIR = path.resolve(process.env.TRACKS_DIR || './data/tracks');
const COVERS_DIR = path.resolve(process.env.COVERS_DIR || './data/covers');
const DATA_DIR = path.resolve('./data');

function ensureDirectories() {
  for (const dir of [DATA_DIR, TRACKS_DIR, COVERS_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`📁 Created directory: ${dir}`);
    }
  }
}

function runMigrations() {
  try {
    console.log('🔄 Running database migrations...');
    const prismaCli = path.resolve('node_modules/prisma/build/index.js');
    execSync(`node "${prismaCli}" db push --skip-generate`, {
      stdio: 'inherit',
      cwd: path.resolve('.'),
    });
    console.log('✅ Database ready');
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

// Trust X-Forwarded-* (for accurate req.ip when behind a proxy)
app.set('trust proxy', 1);

// Security headers
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false, // pure API, no HTML
    hsts: process.env.NODE_ENV === 'production'
      ? { maxAge: 31536000, includeSubDomains: true, preload: true }
      : false,
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
  })
);

// Body parsers with strict limits.
app.use(express.json({ limit: '1mb' })); // audio is uploaded via multipart, not JSON
app.use(express.urlencoded({ limit: '1mb', extended: true }));

// CORS
const corsOrigins = process.env.CORS_ORIGINS === '*' ? '*' : process.env.CORS_ORIGINS?.split(',');
app.use(
  cors({
    origin: corsOrigins ?? false,
    credentials: true,
  })
);

app.use(requestLogger);

// Health check — must not consume the global per-IP budget (monitoring, orchestrators).
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Global rate limiter (all routes below).
app.use(globalLimiter);

// Cover files served statically (covers are not sensitive enough to encrypt;
// they're authenticated nowhere — same as the old site's `covers` bucket signed URLs).
app.use('/files/covers', express.static(COVERS_DIR, { maxAge: '7d' }));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/tracks', tracksRoutes);
app.use('/api/artists', artistsRoutes);
app.use('/api/albums', albumsRoutes);
app.use('/api/playlists', playlistsRoutes);
app.use('/api/likes', likesRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/admin', adminRoutes);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use(errorHandler);

async function boot() {
  runSecurityBootCheck();
  ensureDirectories();
  // Миграции в Docker делает docker-entrypoint.sh (двойной db push ломает SQLite).
  if (process.env.SKIP_BOOT_MIGRATIONS !== '1') {
    runMigrations();
  }
  await backfillTrackFeatsFromAlbums();

  // Periodically clean old login attempts.
  setInterval(() => {
    cleanupOldAttempts().catch(() => {});
  }, 60 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`\n🎵 bpMZ Backend running on http://localhost:${PORT}`);
    console.log(`📂 Tracks (encrypted): ${TRACKS_DIR}`);
    console.log(`🖼️  Covers: ${COVERS_DIR}`);
    console.log(`💾 Database: ${process.env.DATABASE_URL}\n`);
  });
}

async function shutdown() {
  try {
    await prisma.$disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(0);
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

boot();
