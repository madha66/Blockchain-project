// Pure early-warning signal functions (PDF "Early warning and contact"). Starting values are
// tunable; amounts are bigint wei, times are unix seconds.

export const SIGNALS = {
  payoutsFallingRatio: 0.7, // last 30 days below 70% of the 90-day monthly average
  walletDryDays: 3, // SafeRepay below the next installment 3 days before due
  earlyWarningDays: 7, // early warning window before the due date
  reminderDays: 3, // reminder 3 days before due
};

/**
 * Payout inflows falling: the last 30 days are below 70% of the monthly average over 90 days.
 * Needs at least one payout older than 30 days to have a baseline.
 */
export function payoutsFalling(payouts, nowTs, spd = 86400) {
  const in90 = payouts.filter((p) => p.ts > nowTs - 90 * spd);
  const in30 = in90.filter((p) => p.ts > nowTs - 30 * spd);
  if (!in90.some((p) => p.ts <= nowTs - 30 * spd)) return false;
  const sum = (xs) => xs.reduce((a, p) => a + BigInt(p.amount), 0n);
  const monthlyAvg = sum(in90) / 3n;
  return Number(sum(in30)) < SIGNALS.payoutsFallingRatio * Number(monthlyAvg);
}

/** Sweep shortfall: the last two sweeps were each below the installment share. */
export function sweepShortfall(sweeps) {
  if (sweeps.length < 2) return false;
  const lastTwo = [...sweeps].sort((a, b) => a.ts - b.ts).slice(-2);
  return lastTwo.every((s) => BigInt(s.amount) < BigInt(s.expected));
}

/** Wallet running dry: within 3 days of due and SafeRepay cannot cover the installment. */
export function walletRunningDry({ available, due, nextDueTs, nowTs, spd = 86400 }) {
  const untilDue = nextDueTs - nowTs;
  return untilDue >= 0 && untilDue <= SIGNALS.walletDryDays * spd && BigInt(available) < BigInt(due);
}

/** Which pre-due contact applies: "early_warning" (≤7 days), "reminder" (≤3 days) or null. */
export function preDueWindow(nextDueTs, nowTs, spd = 86400) {
  const untilDue = nextDueTs - nowTs;
  if (untilDue < 0) return null;
  if (untilDue <= SIGNALS.reminderDays * spd) return "reminder";
  if (untilDue <= SIGNALS.earlyWarningDays * spd) return "early_warning";
  return null;
}

/** First-payment-default rate for a cohort, and whether it crosses the threshold. */
export function cohortFpd({ firstLoans, firstPaymentDefaults, thresholdBps, minSample }) {
  const rateBps = firstLoans === 0 ? 0 : Math.round((firstPaymentDefaults * 10000) / firstLoans);
  return { rateBps, paused: firstLoans >= minSample && rateBps > thresholdBps };
}

export const STAGE_NAMES = ["Active", "Grace", "Onset", "Significant", "DefaultEligible"];
