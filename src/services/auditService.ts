import { prisma } from '../db.js';

export async function audit(event: {
  userId?: string;
  event: string;
  payload?: object;
  ip?: string;
}) {
  try {
    await prisma.auditEvent.create({
      data: {
        userId: event.userId ?? null,
        event: event.event,
        payload: event.payload ? JSON.stringify(event.payload) : null,
        ip: event.ip ?? null,
      },
    });
  } catch (e) {
    // Audit failures must not break the request.
    console.error('audit log failed:', e);
  }
}
