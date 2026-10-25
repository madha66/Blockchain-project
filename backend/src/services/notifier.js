import { prisma } from "../db.js";
import { GRIEVANCE_LINE } from "../config.js";

export const CONTACT_START_HOUR = 8; // 08:00 local
export const CONTACT_END_HOUR = 19; // 19:00 local (exclusive)
export const RETENTION_DAYS = 183; // keep every message at least 6 months

/** Local hour and minute in the member's time zone. */
function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { hour: get("hour"), minute: get("minute") };
}

/** Contact is allowed only between 08:00 and 19:00 local time. */
export function isWithinContactHours(date, timeZone = "Asia/Kolkata") {
  const { hour } = localParts(date, timeZone);
  return hour >= CONTACT_START_HOUR && hour < CONTACT_END_HOUR;
}

/** The next moment contact is allowed (now, if already inside the window). */
export function nextContactTime(date, timeZone = "Asia/Kolkata") {
  if (isWithinContactHours(date, timeZone)) return date;
  const { hour, minute } = localParts(date, timeZone);
  const minutesNow = hour * 60 + minute;
  const startMinutes = CONTACT_START_HOUR * 60;
  const wait = minutesNow < startMinutes ? startMinutes - minutesNow : 24 * 60 - minutesNow + startMinutes;
  const next = new Date(date.getTime() + wait * 60 * 1000);
  next.setSeconds(0, 0);
  return next;
}

/**
 * During Grace only collection retries run. Personal contact happens before the due date
 * (early warning, reminder) and again from Onset.
 */
export function allowsPersonalContact(stage) {
  return stage !== "Grace";
}

const HELP_FIRST = {
  payouts_falling:
    "If money is tight right now, you can ask for a one-time payment holiday or a longer schedule from your Loans page. Asking early keeps your score impact small.",
  sweep_shortfall:
    "If your payouts have changed, you can ask for a payment holiday or a longer schedule, and we can talk about switching your installment cycle to match how you are paid.",
  wallet_dry:
    "If you cannot top up in time, a payment holiday is available from your Loans page before the due date.",
  reminder:
    "If this date does not work for you, you can ask for a payment holiday from your Loans page before it arrives.",
  onset:
    "You can still ask for a payment holiday from your Loans page. It moves this installment one cycle later for a small flat fee.",
  significant:
    "Please talk to us: we can look at a payment plan with you. A hardship workout is available if things do not improve.",
  guarantor_alert:
    "You do not need to do anything yet. We are working with the borrower on a plan.",
  defaulted_hardship:
    "A hardship workout lets you repay in small installments with no interest, and finishing it restores part of your score. If you think the classification is wrong, you can appeal within 21 days.",
  defaulted:
    "If you think the classification is wrong, you can appeal within 21 days. Your Loans page shows a settlement amount that closes the balance today.",
  fast_climber:
    "You can keep borrowing at your current level. Larger amounts open up as more loans are repaid.",
  generic: "If you need help, reply from your Loans page and we will look at the options with you.",
};

/**
 * Builds a notice: help first, then the facts (amount and date) stated plainly, signed by
 * the member's named contact, with the grievance contact on every message. No threats, no
 * third parties, no public posting.
 */
export function composeMessage({ kind, contactName, facts, title }) {
  const help = HELP_FIRST[kind] ?? HELP_FIRST.generic;
  const body = [help, facts, `— ${contactName}, your GigLend community contact`, GRIEVANCE_LINE]
    .filter(Boolean)
    .join("\n\n");
  return { title: title ?? "A note about your loan", body };
}

const TITLES = {
  payouts_falling: "Your payouts look lower than usual",
  sweep_shortfall: "Your income sweep fell short twice",
  wallet_dry: "Your SafeRepay balance is low",
  reminder: "Installment due in 3 days",
  onset: "Your installment is overdue",
  significant: "Your installment is still unpaid",
  guarantor_alert: "A loan you guarantee is overdue",
  defaulted: "Your loan has been marked as defaulted",
  defaulted_hardship: "Your loan has been marked as defaulted",
  fast_climber: "You are held at your current borrowing step",
};

/**
 * Creates an inbox notice. Inside contact hours it is delivered now (mock email/SMS to the
 * console); outside them it is queued for the next window. Duplicate keys are ignored.
 */
export async function enqueueNotice({ userId, kind, facts, dedupeKey, now = new Date() }) {
  if (dedupeKey) {
    const existing = await prisma.notification.findUnique({ where: { dedupeKey } });
    if (existing) return existing;
  }
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { identity: { include: { contact: true } } } });
  if (!user) throw new Error("Unknown user");
  const contactName = user.identity?.contact?.name ?? "GigLend support";
  const { title, body } = composeMessage({ kind, contactName, facts, title: TITLES[kind] });

  const inWindow = isWithinContactHours(now, user.timezone);
  const notice = await prisma.notification.create({
    data: {
      userId,
      kind,
      title,
      body,
      contactName,
      dedupeKey: dedupeKey ?? null,
      status: inWindow ? "sent" : "queued",
      scheduledFor: inWindow ? now : nextContactTime(now, user.timezone),
      sentAt: inWindow ? now : null,
    },
  });
  if (inWindow) deliverMock(notice);
  return notice;
}

/** Sends queued notices whose window has opened. */
export async function flushQueue(now = new Date()) {
  const due = await prisma.notification.findMany({
    where: { status: "queued", scheduledFor: { lte: now } },
    include: { user: true },
  });
  let sent = 0;
  for (const n of due) {
    if (!isWithinContactHours(now, n.user.timezone)) continue;
    await prisma.notification.update({ where: { id: n.id }, data: { status: "sent", sentAt: now } });
    deliverMock(n);
    sent += 1;
  }
  return sent;
}

/** Deletes only messages older than the 6-month retention period. */
export async function purgeExpired(now = new Date()) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400 * 1000);
  const { count } = await prisma.notification.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}

function deliverMock(n) {
  // Mock email/SMS channel: user ID only, never contact details.
  console.log(`[mock-notice] user=${n.userId} kind=${n.kind} title="${n.title}"`);
}
