import { prisma } from '../db.js';

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/** Reads a non-negative integer from env; 0 (the default) disables the check. */
function envLimit(name: string): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Returns null if attempt is allowed, or a string reason if locked.
 *
 * Lockout is opt-in and off by default — a private invite-only instance is not
 * worth locking its own users out of. Enable per 15-minute window with:
 *   LOGIN_MAX_FAILS_PER_EMAIL=5
 *   LOGIN_MAX_FAILS_PER_IP=20
 */
export async function checkLoginAllowed(email: string, ip: string | undefined): Promise<string | null> {
  const maxPerEmail = envLimit('LOGIN_MAX_FAILS_PER_EMAIL');
  const maxPerIp = envLimit('LOGIN_MAX_FAILS_PER_IP');
  if (maxPerEmail === 0 && maxPerIp === 0) return null;

  const since = new Date(Date.now() - WINDOW_MS);

  const [byEmail, byIp] = await Promise.all([
    maxPerEmail > 0
      ? prisma.loginAttempt.count({
          where: { email, success: false, attemptAt: { gte: since } },
        })
      : Promise.resolve(0),
    ip && maxPerIp > 0
      ? prisma.loginAttempt.count({
          where: { ip, success: false, attemptAt: { gte: since } },
        })
      : Promise.resolve(0),
  ]);

  if (maxPerEmail > 0 && byEmail >= maxPerEmail) {
    return 'Слишком много неудачных попыток входа. Подожди 15 минут.';
  }
  if (ip && maxPerIp > 0 && byIp >= maxPerIp) {
    return 'Слишком много попыток входа с этого устройства. Подожди 15 минут.';
  }
  return null;
}

export async function recordAttempt(email: string, ip: string | undefined, success: boolean) {
  await prisma.loginAttempt.create({
    data: { email, ip, success },
  });
}

/** Best-effort cleanup of old attempts (keep DB small). Called from a scheduled task. */
export async function cleanupOldAttempts() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await prisma.loginAttempt.deleteMany({ where: { attemptAt: { lt: cutoff } } });
}
