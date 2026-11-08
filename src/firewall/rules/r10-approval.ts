import { formatUsd } from '../money';
import type { FirewallContext, ReasonCode, RuleResult } from '../types';

/**
 * R10 — does a human need to sign off?
 *  - nothing payable                                  → BLOCK
 *  - total over approval threshold, any item blocked
 *    (a sign of a bad plan), or any WARN anywhere      → WARN (REQUIRE_APPROVAL)
 * The reasonCode is the most specific reason; the detail lists all of them.
 */
export function r10Approval(
  input: { payableCount: number; blockedCount: number; totalCents: number; anyWarn: boolean },
  ctx: FirewallContext,
): RuleResult {
  if (input.payableCount === 0) {
    return r('block', 'NO_PAYABLE_ITEMS', 'no item in the plan can be paid');
  }
  const reasons: [ReasonCode, string][] = [];
  if (input.totalCents > ctx.config.approvalThresholdCents) {
    reasons.push([
      'OVER_APPROVAL_THRESHOLD',
      `total ${formatUsd(input.totalCents)} > auto-approve limit ${formatUsd(ctx.config.approvalThresholdCents)}`,
    ]);
  }
  if (input.blockedCount > 0) {
    reasons.push(['ITEMS_BLOCKED', `${input.blockedCount} item(s) blocked`]);
  }
  if (input.anyWarn) {
    reasons.push(['WARNINGS_PRESENT', 'other rules raised warnings']);
  }
  const first = reasons[0];
  if (first) {
    return r('warn', first[0], reasons.map(([, d]) => d).join('; '));
  }
  return r('pass', 'AUTO_APPROVABLE', `total ${formatUsd(input.totalCents)} within auto-approve limit, no warnings`);
}

function r(status: RuleResult['status'], reasonCode: RuleResult['reasonCode'], detail: string): RuleResult {
  return { id: 'R10', scope: 'plan', status, reasonCode, detail };
}
