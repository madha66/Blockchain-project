import { prisma } from "../db.js";

/**
 * Auth audit trail: event name and user ID only. Never pass email, phone, PAN or IP here.
 */
export async function logAuthEvent(event, userId = null) {
  await prisma.authEvent.create({ data: { event, userId } });
}
