import { z } from 'zod';

/**
 * Donation-side policy (SPEC §5.6b). Same pattern as the payout firewall:
 * a pure function over the request and a snapshot of recent donations.
 *
 * Everything a donor (human or agent) sends is untrusted. `donor_ref` and
 * `message` are length-limited, stored as data, escaped on display, and
 * never reach the payout agent or the sentinel as instructions.
 */
export type DonationPolicyConfig = {
  minCents: number;
  maxCents: number;
  /** Per donor (allowance id for agents, donor_ref for people), rolling 24 h, counting everything not failed or cancelled. */
  perDonorDailyCapCents: number;
  /** Per donor new donations in a rolling 10 minutes. */
  perDonorPer10Min: number;
  /** All donors, rolling 10 minutes. */
  globalPer10Min: number;
  /** Card-testing pattern: this many sub-$2 donations from one donor_ref within an hour. */
  microDonationCents: number;
  microDonationsPerHour: number;
};

export function defaultDonationPolicy(): DonationPolicyConfig {
  return {
    minCents: 1_00,
    maxCents: 100_00,
    perDonorDailyCapCents: 200_00,
    perDonorPer10Min: 3,
    globalPer10Min: 30,
    microDonationCents: 2_00,
    microDonationsPerHour: 3,
  };
}

export const DonationRequestSchema = z.strictObject({
  amount_usd: z.union([z.number(), z.string().regex(/^\d{1,6}(\.\d{1,2})?$/)]),
  donor_ref: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[\p{L}\p{N} ._:@+-]+$/u, 'letters, digits, spaces and . _ : @ + - only'),
  message: z.string().max(280).optional(),
  idempotency_key: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional(),
});

/** `allowanceId` is set for agent donations; per-donor limits then key on it, not on the (display) name. */
export type RecentDonation = { donorRef: string; amountCents: number; at: number; status: string; allowanceId?: string | null };

export type DonationDecision =
  | { ok: true; amountCents: number; donorRef: string; message: string | null; idempotencyKey: string | null }
  | { ok: false; code: DonationRejection; message: string };

export type DonationRejection =
  | 'INVALID_REQUEST'
  | 'UNKNOWN_FIELDS'
  | 'AMOUNT_TOO_SMALL'
  | 'AMOUNT_TOO_LARGE'
  | 'AMOUNT_PRECISION'
  | 'DONOR_DAILY_CAP'
  | 'DONOR_RATE_LIMIT'
  | 'GLOBAL_RATE_LIMIT'
  | 'CARD_TESTING_PATTERN';

const MIN10 = 10 * 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// PAYER_MISMATCH: held before capture, so no money moved.
const NOT_COUNTED = new Set(['FAILED', 'CANCELED', 'PAYER_MISMATCH']);

/** Control and invisible characters are removed from the free-text message before storage. */
export function cleanMessage(m: string | undefined): string | null {
  if (!m) return null;
  const cleaned = m.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length ? cleaned : null;
}

export function evaluateDonation(
  raw: unknown,
  ctx: { now: number; recent: readonly RecentDonation[]; config?: DonationPolicyConfig; allowanceId?: string },
): DonationDecision {
  const config = ctx.config ?? defaultDonationPolicy();
  const parsed = DonationRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const unknown = parsed.error.issues.find((i) => i.code === 'unrecognized_keys');
    if (unknown && unknown.code === 'unrecognized_keys') {
      return { ok: false, code: 'UNKNOWN_FIELDS', message: `Unknown field(s): ${unknown.keys.slice(0, 5).join(', ')}. Allowed: amount_usd, donor_ref, message, idempotency_key.` };
    }
    const first = parsed.error.issues[0];
    return { ok: false, code: 'INVALID_REQUEST', message: `${first?.path.join('.') || 'request'}: ${first?.message ?? 'invalid'}` };
  }
  const r = parsed.data;

  const amount = typeof r.amount_usd === 'string' ? Number(r.amount_usd) : r.amount_usd;
  if (!Number.isFinite(amount)) return { ok: false, code: 'INVALID_REQUEST', message: 'amount_usd must be a number' };
  const cents = Math.round(amount * 100);
  if (Math.abs(amount * 100 - cents) > 1e-6) return { ok: false, code: 'AMOUNT_PRECISION', message: 'amount_usd has more than 2 decimal places' };
  if (cents < config.minCents) return { ok: false, code: 'AMOUNT_TOO_SMALL', message: `Minimum donation is $${(config.minCents / 100).toFixed(2)}.` };
  if (cents > config.maxCents) return { ok: false, code: 'AMOUNT_TOO_LARGE', message: `Maximum donation in the sandbox is $${(config.maxCents / 100).toFixed(2)}.` };

  const donorRef = r.donor_ref;
  // "This donor": an agent is its allowance (labels are only names, so one agent can't spend another's limit by
  // sharing its label); a person is their name among people's donations, compared without case.
  const nameKey = (s: string) => s.normalize('NFKC').toLowerCase();
  const sameDonor = (d: RecentDonation) => (ctx.allowanceId ? d.allowanceId === ctx.allowanceId : !d.allowanceId && nameKey(d.donorRef) === nameKey(donorRef));
  const mine = ctx.recent.filter((d) => sameDonor(d) && !NOT_COUNTED.has(d.status));

  const day = mine.filter((d) => d.at > ctx.now - DAY).reduce((s, d) => s + d.amountCents, 0);
  if (day + cents > config.perDonorDailyCapCents) {
    return { ok: false, code: 'DONOR_DAILY_CAP', message: `This donor has reached the $${(config.perDonorDailyCapCents / 100).toFixed(0)} daily limit.` };
  }
  if (mine.filter((d) => d.at > ctx.now - MIN10).length >= config.perDonorPer10Min) {
    return { ok: false, code: 'DONOR_RATE_LIMIT', message: 'Too many donations from this donor in 10 minutes. Try again later.' };
  }
  if (ctx.recent.filter((d) => d.at > ctx.now - MIN10).length >= config.globalPer10Min) {
    return { ok: false, code: 'GLOBAL_RATE_LIMIT', message: 'The pool is receiving too many donations right now. Try again in a few minutes.' };
  }
  if (cents < config.microDonationCents) {
    const micro = ctx.recent.filter((d) => sameDonor(d) && d.at > ctx.now - HOUR && d.amountCents < config.microDonationCents).length;
    if (micro + 1 >= config.microDonationsPerHour) {
      return { ok: false, code: 'CARD_TESTING_PATTERN', message: 'Repeated very small donations are blocked (a common card-testing pattern).' };
    }
  }
  return { ok: true, amountCents: cents, donorRef, message: cleanMessage(r.message), idempotencyKey: r.idempotency_key ?? null };
}
