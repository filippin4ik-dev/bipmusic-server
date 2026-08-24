import bcrypt from 'bcryptjs';
import { config } from 'dotenv';
import { prisma } from './db.js';

config();

const DEFAULT_ADMIN_PASSWORD = 'admin123';

/**
 * Creates the initial admin account from environment variables.
 *
 * ADMIN_EMAIL     — login email      (default: admin@echo.local)
 * ADMIN_NICKNAME  — display nickname (default: admin)
 * ADMIN_PASSWORD  — password         (REQUIRED in production, must not be the default)
 *
 * In production we refuse to seed a well-known default password so a fresh
 * deploy is never reachable with publicly-known credentials.
 */
async function seed() {
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@echo.local').trim();
  const adminNick = (process.env.ADMIN_NICKNAME || 'admin').trim();
  const adminPass = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
  const isProd = process.env.NODE_ENV === 'production';

  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (existing) {
    console.log('✅ Admin already exists, skipping seed');
    return;
  }

  if (isProd) {
    if (!process.env.ADMIN_PASSWORD || adminPass === DEFAULT_ADMIN_PASSWORD) {
      console.error(
        '🔒 Refusing to seed admin in production: set a strong ADMIN_PASSWORD in .env ' +
          '(and it must not equal the default). No admin was created.'
      );
      return;
    }
    if (adminPass.length < 10) {
      console.error('🔒 Refusing to seed admin: ADMIN_PASSWORD must be at least 10 characters.');
      return;
    }
  }

  const hash = await bcrypt.hash(adminPass, 12);

  await prisma.user.create({
    data: {
      email: adminEmail,
      password: hash,
      role: 'ADMIN',
      profile: {
        create: {
          nickname: adminNick,
          status: 'APPROVED',
        },
      },
    },
  });

  console.log('🌱 Created admin user:');
  console.log(`   Email: ${adminEmail}`);
  console.log(`   Ник:   ${adminNick}`);
  if (!isProd && adminPass === DEFAULT_ADMIN_PASSWORD) {
    console.log(`   Пароль: ${adminPass}  (dev only — смени в production через ADMIN_PASSWORD!)`);
  } else {
    console.log('   Пароль: из ADMIN_PASSWORD (.env)');
  }
}

seed()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
