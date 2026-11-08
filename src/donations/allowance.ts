import { z } from 'zod';
import { DonationRequestSchema } from './policy';

/**
 * Allowances (mandates) for agent donations. Pure functions only, like the
 * donation policy: the service hands in the stored allowance and the
 * donations already made under it, and gets a decision back.
 *
 * A person creates an allowance for one agent: a label (who the agent is),
 * a cap in USD and an expiry. The agent gets a bearer token (`alw_…`) and
 * must send it with every donation. The server, not the agent, decides what
 * the donor_ref is (the label) and how much is left. Each payment is still
 * approved by a person on PayPal.
 */
export const ALLOWANCE_TOKEN_PATTERN = '^alw_[A-Za-z0-9_-]{32}$';
export const ALLOWANCE_TOKEN_RE = new RegExp(ALLOWANCE_TOKEN_PATTERN);
export const ALLOWANCE_ID_RE = /^alid_[0-9a-f]{16}$/;

export const ALLOWANCE_LIMITS = {
  minCapUsd: 1,
  maxCapUsd: 100,
  minHours: 1,
  maxHours: 7 * 24,
  /** New allowances across everyone in a rolling 10 minutes (public demo). */
  globalPer10Min: 20,
} as const;

/** Donation statuses whose money counts against an allowance: in flight, waiting for approval, or received. */
export const COMMITTED_STATUSES: readonly string[] = ['CREATING', 'AWAITING_APPROVAL', 'PENDING', 'CAPTURED', 'PARTIALLY_REFUNDED'];

const LabelSchema = DonationRequestSchema.shape.donor_ref;

export const AllowanceRequestSchema = z.strictObject({
  label: LabelSchema,
  cap_usd: z.union([z.number(), z.string().regex(/^\d{1,6}(\.\d{1,2})?$/)]),
  expires_in_hours: z.number().int().min(ALLOWANCE_LIMITS.minHours).max(ALLOWANCE_LIMITS.maxHours),
});

export type AllowanceRequestDecision =
  | { ok: true; label: string; capCents: number; expiresMs: number }
  | { ok: false; code: 'INVALID_REQUEST' | 'UNKNOWN_FIELDS' | 'CAP_OUT_OF_RANGE' | 'AMOUNT_PRECISION' | 'GLOBAL_RATE_LIMIT'; message: string };

export function evaluateAllowanceRequest(raw: unknown, ctx: { now: number; createdLast10Min: number }): AllowanceRequestDecision {
  const parsed = AllowanceRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const unknown = parsed.error.issues.find((i) => i.code === 'unrecognized_keys');
    if (unknown && unknown.code === 'unrecognized_keys') {
      return { ok: false, code: 'UNKNOWN_FIELDS', message: `Unknown field(s): ${unknown.keys.slice(0, 5).join(', ')}. Allowed: label, cap_usd, expires_in_hours.` };
    }
    const first = parsed.error.issues[0];
    return { ok: false, code: 'INVALID_REQUEST', message: `${first?.path.join('.') || 'request'}: ${first?.message ?? 'invalid'}` };
  }
  const r = parsed.data;
  const cap = typeof r.cap_usd === 'string' ? Number(r.cap_usd) : r.cap_usd;
  if (!Number.isFinite(cap)) return { ok: false, code: 'INVALID_REQUEST', message: 'cap_usd must be a number' };
  const capCents = Math.round(cap * 100);
  if (Math.abs(cap * 100 - capCents) > 1e-6) return { ok: false, code: 'AMOUNT_PRECISION', message: 'cap_usd has more than 2 decimal places' };
  if (capCents < ALLOWANCE_LIMITS.minCapUsd * 100 || capCents > ALLOWANCE_LIMITS.maxCapUsd * 100) {
    return { ok: false, code: 'CAP_OUT_OF_RANGE', message: `cap_usd must be between $${ALLOWANCE_LIMITS.minCapUsd} and $${ALLOWANCE_LIMITS.maxCapUsd}.` };
  }
  if (ctx.createdLast10Min >= ALLOWANCE_LIMITS.globalPer10Min) {
    return { ok: false, code: 'GLOBAL_RATE_LIMIT', message: 'Too many allowances were created in the last 10 minutes. Try again shortly.' };
  }
  return { ok: true, label: r.label, capCents, expiresMs: ctx.now + r.expires_in_hours * 3_600_000 };
}

/** What an agent sends to create a donation. donor_ref is not accepted: it comes from the allowance label. */
export const AgentDonationRequestSchema = z.strictObject({
  amount_usd: DonationRequestSchema.shape.amount_usd,
  allowance_token: z.string().regex(ALLOWANCE_TOKEN_RE, 'must be the alw_… token from your allowance'),
  message: DonationRequestSchema.shape.message,
  idempotency_key: DonationRequestSchema.shape.idempotency_key,
});

export type AgentDonationParse =
  | { ok: true; token: string; policyInput: { amount_usd: number | string; message?: string; idempotency_key?: string } }
  | { ok: false; code: 'ALLOWANCE_REQUIRED' | 'UNKNOWN_FIELDS' | 'INVALID_REQUEST'; message: string };

/** Shape check for an agent's request, before the allowance is looked up. */
export function parseAgentDonation(raw: unknown): AgentDonationParse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'INVALID_REQUEST', message: 'request: send a JSON object' };
  const obj = raw as Record<string, unknown>;
  if (obj.allowance_token === undefined) {
    return { ok: false, code: 'ALLOWANCE_REQUIRED', message: 'allowance_token is required. A person creates one for you at /agents (or POST /api/allowances).' };
  }
  const parsed = AgentDonationRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const unknown = parsed.error.issues.find((i) => i.code === 'unrecognized_keys');
    if (unknown && unknown.code === 'unrecognized_keys') {
      const hint = unknown.keys.includes('donor_ref') ? ' donor_ref is set from your allowance label.' : '';
      return { ok: false, code: 'UNKNOWN_FIELDS', message: `Unknown field(s): ${unknown.keys.slice(0, 5).join(', ')}. Allowed: amount_usd, allowance_token, message, idempotency_key.${hint}` };
    }
    const first = parsed.error.issues[0];
    return { ok: false, code: 'INVALID_REQUEST', message: `${first?.path.join('.') || 'request'}: ${first?.message ?? 'invalid'}` };
  }
  const { allowance_token, ...policyInput } = parsed.data;
  return { ok: true, token: allowance_token, policyInput };
}

export type AllowanceState = {
  id: string;
  label: string;
  capCents: number;
  expiresMs: number;
  revokedMs: number | null;
};

export type AllowanceRejection = 'ALLOWANCE_UNKNOWN' | 'ALLOWANCE_REVOKED' | 'ALLOWANCE_EXPIRED' | 'ALLOWANCE_EXCEEDED';

/** Money already committed under an allowance (see COMMITTED_STATUSES). */
export function committedCents(donations: readonly { status: string; amountCents: number }[]): number {
  return donations.filter((d) => COMMITTED_STATUSES.includes(d.status)).reduce((s, d) => s + d.amountCents, 0);
}

export function allowanceStatus(a: AllowanceState, committed: number, now: number): 'active' | 'revoked' | 'expired' | 'used_up' {
  if (a.revokedMs !== null) return 'revoked';
  if (now >= a.expiresMs) return 'expired';
  if (committed >= a.capCents) return 'used_up';
  return 'active';
}

/** May this allowance pay `amountCents` more right now? */
export function checkAllowance(
  a: AllowanceState | undefined,
  amountCents: number,
  ctx: { now: number; donations: readonly { status: string; amountCents: number }[] },
): { ok: true; remainingAfterCents: number } | { ok: false; code: AllowanceRejection; message: string; remainingCents: number } {
  if (!a) return { ok: false, code: 'ALLOWANCE_UNKNOWN', message: 'That allowance_token is not valid. Ask your person for a new one at /agents.', remainingCents: 0 };
  const remaining = Math.max(0, a.capCents - committedCents(ctx.donations));
  if (a.revokedMs !== null) return { ok: false, code: 'ALLOWANCE_REVOKED', message: 'This allowance was revoked by the person who created it.', remainingCents: 0 };
  if (ctx.now >= a.expiresMs) return { ok: false, code: 'ALLOWANCE_EXPIRED', message: `This allowance expired at ${new Date(a.expiresMs).toISOString()}.`, remainingCents: 0 };
  if (amountCents > remaining) {
    return {
      ok: false,
      code: 'ALLOWANCE_EXCEEDED',
      message: `This allowance has $${(remaining / 100).toFixed(2)} left of $${(a.capCents / 100).toFixed(2)}; $${(amountCents / 100).toFixed(2)} is more than that.`,
      remainingCents: remaining,
    };
  }
  return { ok: true, remainingAfterCents: remaining - amountCents };
}
