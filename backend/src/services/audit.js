import { AuditLog } from "../models.js";

/**
 * Audit trail: category, event name, wallet/user ID and non-personal facts only.
 * Never pass email, phone, identifiers, IP addresses or notice recipients here.
 */
export async function logAudit(category, event, { wallet = null, user = null, data = {} } = {}) {
  await AuditLog.create({ category, event, wallet: wallet?.toLowerCase?.() ?? null, user, data });
}

export const logAuthEvent = (event, userId = null) => logAudit("auth", event, { user: userId });
