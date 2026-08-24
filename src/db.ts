import { PrismaClient } from '@prisma/client';

/**
 * One PrismaClient per Node process. With SQLite, many separate clients each
 * open connections and worsen "database is locked" contention → retries and
 * long hangs under concurrent requests (e.g. mobile client retries).
 */
export const prisma = new PrismaClient();
