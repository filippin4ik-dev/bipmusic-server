import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';
import { prisma } from '../db.js';
import { ValidationError, NotFoundError } from '../middleware/errorHandler.js';
import { persistRefreshToken, consumeRefreshToken } from './refreshTokenService.js';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

const REFRESH_TTL_MS = parseRefreshTtl(process.env.JWT_REFRESH_EXPIRY || '180d');

/** SQLite + bcrypt on small VPS: allow tuning via env (default 11). Clamped to 10–12 for production sanity. */
function bcryptSaltRounds(): number {
  const n = parseInt(process.env.BCRYPT_ROUNDS || '11', 10);
  return Math.min(12, Math.max(10, n));
}

function parseRefreshTtl(s: string): number {
  // Accepts "30d", "12h", "60m", "300s" or raw seconds.
  const m = s.match(/^(\d+)([dhms])?$/);
  if (!m) return 30 * 24 * 60 * 60 * 1000;
  const n = parseInt(m[1], 10);
  const unit = m[2] ?? 's';
  switch (unit) {
    case 'd': return n * 24 * 60 * 60 * 1000;
    case 'h': return n * 60 * 60 * 1000;
    case 'm': return n * 60 * 1000;
    default: return n * 1000;
  }
}

export async function registerUser(email: string, password: string, nickname: string, ip?: string): Promise<AuthTokens> {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new ValidationError('Этот ник уже занят');

  const existingNickname = await prisma.profile.findUnique({ where: { nickname } });
  if (existingNickname) throw new ValidationError('Этот ник уже занят');

  const passwordHash = await bcrypt.hash(password, bcryptSaltRounds());

  const user = await prisma.user.create({
    data: {
      email,
      password: passwordHash,
      profile: { create: { nickname, status: 'PENDING' } },
    },
  });

  return generateAndPersist(user.id, user.role, ip);
}

export async function loginUser(email: string, password: string, ip?: string): Promise<AuthTokens> {
  // The reply stays identical for both failures so nobody can probe which
  // accounts exist. The distinction goes to the server log instead, where an
  // operator needs it to tell a typo apart from a missing account.
  const user = await prisma.user.findUnique({ where: { email }, include: { profile: true } });
  if (!user) {
    console.warn(`[login] отказ: пользователя ${email} нет в базе`);
    throw new ValidationError('Неверный ник или пароль');
  }

  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) {
    console.warn(`[login] отказ: неверный пароль для ${email}`);
    throw new ValidationError('Неверный ник или пароль');
  }

  if (user.profile?.status === 'REJECTED') {
    throw new ValidationError('Аккаунт отклонён');
  }

  return generateAndPersist(user.id, user.role, ip);
}

/**
 * Single-use refresh: validates the token, marks it consumed, and issues a new pair.
 * If validation fails the caller should treat it as a re-login.
 */
export async function refreshTokens(refreshToken: string, ip?: string): Promise<AuthTokens> {
  let payload: { userId: string } | null = null;
  try {
    payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET!) as { userId: string };
  } catch {
    throw new ValidationError('Invalid refresh token');
  }

  const userId = await consumeRefreshToken(refreshToken);
  if (!userId || userId !== payload.userId) {
    throw new ValidationError('Refresh token revoked');
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ValidationError('User not found');

  return generateAndPersist(user.id, user.role, ip);
}

async function generateAndPersist(userId: string, role: string, ip?: string): Promise<AuthTokens> {
  const tokens = generateTokens(userId, role);
  await persistRefreshToken({
    userId,
    token: tokens.refreshToken,
    ttlMs: REFRESH_TTL_MS,
    ip,
  });
  return tokens;
}

export function generateTokens(userId: string, role: string): AuthTokens {
  const accessOpts: SignOptions = { expiresIn: (process.env.JWT_EXPIRY || '30d') as SignOptions['expiresIn'] };
  const refreshOpts: SignOptions = { expiresIn: (process.env.JWT_REFRESH_EXPIRY || '180d') as SignOptions['expiresIn'] };

  const accessToken = jwt.sign({ userId, role }, process.env.JWT_SECRET!, accessOpts);
  // Include a random jti so multiple refresh tokens for the same user are distinct.
  const jti = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const refreshToken = jwt.sign({ userId, jti }, process.env.JWT_REFRESH_SECRET!, refreshOpts);

  return { accessToken, refreshToken };
}

export async function getUserProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { profile: true },
  });
  if (!user) throw new NotFoundError('User');

  return {
    id: user.id,
    email: user.email,
    role: user.role,
    profile: user.profile,
  };
}
