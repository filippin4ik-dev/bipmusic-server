import { prisma } from '../db.js';

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FAILS_PER_EMAIL = 5;
const MAX_FAILS_PER_IP = 20;

/**
 * Returns null if attempt is allowed, or a string reason if locked.
 * Lockout policy:
 *   - 5 failed logins for the same email in 15 min → locked.
 *   - 20 failed logins from the same IP in 15 min → locked.
 */
export async function checkLoginAllowed(email: string, ip: string | undefined): Promise<string | null> {
  const since = new Date(Date.now() - WINDOW_MS);

  const [byEmail, byIp] = await Promise.all([
    prisma.loginAttempt.count({
      where: { email, success: false, attemptAt: { gte: since } },
    }),
    ip
      ? prisma.loginAttempt.count({
          where: { ip, success: false, attemptAt: { gte: since } },
        })
      : Promise.resolve(0),
  ]);

  if (byEmail >= MAX_FAILS_PER_EMAIL) {
    return 'Слишком много неудачных попыток входа. Подожди 15 минут.';
  }
  if (ip && byIp >= MAX_FAILS_PER_IP) {
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
