import { z } from 'zod';

/**
 * The ONLY shape the agent can submit. There is deliberately no field for an
 * email, an amount, a currency, or any account detail: an injected
 * instruction has nowhere to put an attacker's address.
 *
 * The agent module (M2) re-exports this schema so there is one source of truth.
 *
 * Length limits are generous "sanity" bounds; anything beyond them is treated
 * as a malformed plan. Tighter, business-level limits (note ≤ 200 chars) are
 * firewall rules so that one bad note does not block a whole relief plan.
 */
export const TierSchema = z.enum(['A', 'B', 'C']);

const PlanItemShape = {
  recipientId: z.string().min(1).max(128),
  tier: TierSchema,
  note: z.string().max(5000),
  why: z.string().max(2000),
};

const ExceptionShape = {
  recipientId: z.string().min(1).max(128),
  reason: z.string().max(2000),
};

const planShape = (strict: boolean) => {
  const obj = strict ? z.strictObject : z.object;
  return obj({
    eventId: z.string().min(1).max(128),
    decision: z.enum(['trigger', 'hold', 'escalate']),
    rationale: z.string().max(10_000),
    items: z.array(obj(PlanItemShape)).max(500),
    exceptionRequests: z.array(obj(ExceptionShape)).max(100),
  });
};

export const PayoutPlanSchema = planShape(true);
const LoosePayoutPlanSchema = planShape(false);

export type PayoutPlan = z.infer<typeof PayoutPlanSchema>;
export type PlanItem = PayoutPlan['items'][number];

export type ParsedPlan =
  | { ok: true; plan: PayoutPlan; unknownFields: string[] }
  | { ok: false; errors: string[] };

/**
 * Parse untrusted agent output. Unknown fields are stripped and reported
 * (they force human approval under R9); anything else wrong is malformed.
 */
export function parsePlan(raw: unknown): ParsedPlan {
  const loose = LoosePayoutPlanSchema.safeParse(raw);
  if (!loose.success) {
    return {
      ok: false,
      errors: loose.error.issues.map((i) => `${formatPath(i.path)}: ${i.message}`),
    };
  }
  const strict = PayoutPlanSchema.safeParse(raw);
  const unknownFields: string[] = [];
  if (!strict.success) {
    for (const issue of strict.error.issues) {
      if (issue.code === 'unrecognized_keys') {
        for (const key of issue.keys) unknownFields.push(formatPath([...issue.path, key]));
      } else {
        // Loose parse succeeded, so this should be impossible; fail closed.
        return { ok: false, errors: [`${formatPath(issue.path)}: ${issue.message}`] };
      }
    }
  }
  return { ok: true, plan: loose.data, unknownFields: unknownFields.sort() };
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return (
    '$' +
    path
      .map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`))
      .join('')
  );
}
