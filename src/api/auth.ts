import express, { Response } from 'express';
import { z } from 'zod';
import { AuthRequest, authenticate } from '../middleware/auth.js';
import {
  registerUser,
  loginUser,
  refreshTokens,
  getUserProfile
} from '../services/authService.js';
import { checkLoginAllowed, recordAttempt } from '../services/loginGuardService.js';
import { forwardedClientIp, loginLimiter, registerLimiter } from '../middleware/rateLimits.js';
import { audit } from '../services/auditService.js';

const router = express.Router();

const RegisterSchema = z.object({
  email: z.string().email().max(120),
  password: z.string().min(8).max(72),
  nickname: z.string().min(2).max(24).regex(/^[a-z0-9_]+$/i),
  code: z.string().trim().min(1).max(64),
});

const LoginSchema = z.object({
  email: z.string().email().max(120),
  password: z.string().min(1).max(72),
});

const RefreshSchema = z.object({
  refreshToken: z.string().min(10).max(1024),
});

router.post('/register', registerLimiter, async (req, res) => {
  const data = RegisterSchema.parse(req.body);
  const ip = forwardedClientIp(req);

  const allowedCodes = (process.env.INVITE_CODES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowedCodes.length > 0 && !allowedCodes.includes(data.code)) {
    return res.status(400).json({ error: 'Неверный код приглашения' });
  }

  const tokens = await registerUser(data.email, data.password, data.nickname, ip);

  await audit({ event: 'USER_REGISTERED', payload: { nickname: data.nickname }, ip });

  res.status(201).json({
    message: 'Заявка отправлена. Ожидай подтверждения админом.',
    ...tokens,
  });
});

router.post('/login', loginLimiter, async (req, res) => {
  const data = LoginSchema.parse(req.body);
  const ip = forwardedClientIp(req);

  // Brute-force lockout.
  const lock = await checkLoginAllowed(data.email, ip);
  if (lock) {
    return res.status(429).json({ error: lock });
  }

  try {
    const tokens = await loginUser(data.email, data.password, ip);
    await recordAttempt(data.email, ip, true);
    res.json({ message: 'Login successful', ...tokens });
  } catch (err) {
    await recordAttempt(data.email, ip, false);
    throw err;
  }
});

router.post('/refresh', async (req, res) => {
  const data = RefreshSchema.parse(req.body);
  const tokens = await refreshTokens(data.refreshToken, forwardedClientIp(req));
  res.json(tokens);
});

router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  const profile = await getUserProfile(req.userId!);
  res.json(profile);
});

export default router;
