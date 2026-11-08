import { z } from 'zod';
import { fail, json, planIdParam, readBody } from '@/server/http';
import { firstlight } from '@/server/runtime';
import { planView } from '@/server/views';

/**
 * Body of POST /api/plans/[id]/approve and /deny. Lengths match the approvals
 * table. Blank or missing fields get through on purpose: the pipeline checks
 * the plan first and then answers APPROVAL_INCOMPLETE ("Enter your name and a reason").
 */
const DecisionBody = z.object({
  approver: z.string().max(100).optional(),
  reason: z.string().max(1000).optional(),
});

/** The shared POST handler for approve and deny. */
export function decisionHandler(decision: 'approve' | 'deny') {
  return async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
    try {
      const planId = await planIdParam(ctx);
      const { approver, reason } = await readBody(req, DecisionBody);
      firstlight().pipeline.decide(planId, decision, approver ?? '', reason ?? '');
      return json(planView(planId));
    } catch (e) {
      return fail(e);
    }
  };
}
