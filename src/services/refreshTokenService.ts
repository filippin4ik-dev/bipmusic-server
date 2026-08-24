import crypto from 'crypto';
import { prisma } from '../db.js';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Persist a new refresh token (by hash) so we can later revoke it during rotation.
 */
export async function persistRefreshToken(params: {
  userId: string;
  token: string;
  ttlMs: number;
  ip?: string;
}) {
  await prisma.refreshToken.create({
    data: {
      userId: params.userId,
      tokenHash: hashToken(params.token),
      expiresAt: new Date(Date.now() + params.ttlMs),
      ip: params.ip,
    },
  });
}

/**
 * Verify that a refresh token is still valid (exists, not revoked, not expired).
 * Returns the user ID if valid.
 */
export async function consumeRefreshToken(token: string): Promise<string | null> {
  const hash = hashToken(token);
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
  if (!row || row.revoked) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;

  // Single-use: mark this one revoked on consume. Caller persists the new one.
  await prisma.refreshToken.update({
    where: { tokenHash: hash },
    data: { revoked: true },
  });

  return row.userId;
}

export async function revokeAllForUser(userId: string) {
  await prisma.refreshToken.updateMany({
    where: { userId, revoked: false },
    data: { revoked: true },
  });
}
