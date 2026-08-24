import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

/** Client IP from trusted edge (X-Forwarded-For first hop), then Express req.ip / socket. */
export function forwardedClientIp(req: Request): string | undefined {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    const first = xff.split(',')[0].trim();
    if (first.length > 0) return first;
  }
  if (Array.isArray(xff) && xff[0]) {
    const first = String(xff[0]).split(',')[0].trim();
    if (first.length > 0) return first;
  }
  if (typeof req.ip === 'string' && req.ip.length > 0) return req.ip;
  return req.socket.remoteAddress ?? undefined;
}

function rateLimitKey(req: Request): string {
  return forwardedClientIp(req) ?? 'unknown';
}

const limiterDefaults = {
  standardHeaders: 'draft-7' as const,
  legacyHeaders: false,
  keyGenerator: (req: Request) => rateLimitKey(req),
};

// Generic limiter for the whole API.
export const globalLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 60 * 1000,
  limit: 300, // 300 req/min/IP
  message: { error: { message: 'Too many requests, slow down.' } },
});

// Login: still tight (brute force); failures are additionally capped in loginGuardService.
export const loginLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 60 * 1000,
  limit: 20,
  message: { error: { message: 'Слишком много попыток входа. Подожди минуту.' } },
});

// Register: looser — invite code gates abuse; shared NAT/VPN must not brick everyone on one IP.
export const registerLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 60 * 1000,
  limit: 30,
  message: { error: { message: 'Слишком много попыток регистрации. Подожди минуту.' } },
});

// Decryption-key requests: a single user shouldn't pull hundreds of keys per
// minute (= mass scraping). Cap per IP and we also enforce per-user in code.
export const keyLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 60 * 1000,
  limit: 60,
  message: { error: { message: 'Слишком много запросов ключей.' } },
});
