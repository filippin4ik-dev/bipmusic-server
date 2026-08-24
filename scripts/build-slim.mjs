#!/usr/bin/env node
/**
 * Лёгкая сборка: весь JS в 2 файла + runtime/ (только Prisma).
 * На VPS node_modules нет — только app/*.mjs + runtime/.
 */
import esbuild from 'esbuild';
import { cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(root, 'release');
const runtime = path.join(release, 'runtime');
const linuxOnly = process.argv.includes('--linux-only');

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  external: ['@prisma/client'],
  packages: 'bundle',
  sourcemap: true,
  logLevel: 'info',
};

function pruneForeignEngines(dir) {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      pruneForeignEngines(full);
      continue;
    }
    const lower = name.toLowerCase();
    if (
      lower.includes('darwin') ||
      lower.includes('windows') ||
      lower.includes('debian') && !lower.includes('musl') ||
      (lower.includes('linux') && lower.includes('gnu') && !lower.includes('musl'))
    ) {
      rmSync(full);
      console.log('  −', path.relative(runtime, full));
    }
  }
}

console.log('→ esbuild: server + seed…');
await esbuild.build({
  ...shared,
  entryPoints: {
    server: path.join(root, 'src/server.ts'),
    seed: path.join(root, 'src/seed.ts'),
  },
  outdir: path.join(release, 'app'),
});

console.log('→ runtime/ (Prisma only)…');
rmSync(runtime, { recursive: true, force: true });
mkdirSync(runtime, { recursive: true });

for (const pkg of ['@prisma/client', '.prisma/client', 'prisma', '@prisma/engines']) {
  cpSync(path.join(root, 'node_modules', pkg), path.join(runtime, pkg), { recursive: true });
}

if (linuxOnly) {
  console.log('→ убираем движки не под Linux Alpine…');
  pruneForeignEngines(runtime);
}

mkdirSync(path.join(release, 'prisma'), { recursive: true });
cpSync(path.join(root, 'prisma/schema.prisma'), path.join(release, 'prisma/schema.prisma'));

console.log('→ release/ готов');
