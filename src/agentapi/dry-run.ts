import { payableItems } from '../firewall/engine';
import { eligibleRecipients } from '../firewall/rules/r12-coverage';
import { sameDisasterEventIds } from '../firewall/rules/shared';
import type { FirewallContext, Verdict } from '../firewall/types';
import { plainRule, verdictReasons } from '../ui/plain';

/**
 * check_payout_plan (MCP): the firewall's answer to any payout plan, in the
 * shape an agent can act on. Built from the pure firewall verdict; nothing
 * here stores, pays or calls out.
 */

const usd = (cents: number) => (cents / 100).toFixed(2);

const MEANING: Record<Verdict['overall'], string> = {
  ALLOW: 'The firewall would let this plan be sent to PayPal without a person reviewing it.',
  REQUIRE_APPROVAL: 'The firewall would hold this plan until a person approves it.',
  BLOCK: 'The firewall would block this plan: nothing in it could be sent.',
};

export const DRY_RUN_NOTE =
  'Dry run: nothing was paid, stored, logged or sent to PayPal. A real payout is checked again against the ledger at the moment it is sent.';

export function dryRunSummary(verdict: Verdict, ctx: FirewallContext, basis: { assessedPlanId: number | null }) {
  const payable = payableItems(verdict);
  const triggerMet = verdict.planRules.some((r) => r.id === 'R8' && r.status === 'pass');
  const coverage = (() => {
    if (!triggerMet || verdict.decision === null) {
      return { checked: false, why: triggerMet ? 'The plan is not valid, so coverage was not checked.' : 'The trigger is not met, so nobody is owed a payout yet.' };
    }
    const planned = new Map(payable.map((i) => [i.recipientId, i.amountCents]));
    const rows = eligibleRecipients(ctx, sameDisasterEventIds(ctx)).map((e) => {
      const owed = ctx.config.tierAmountsCents[e.maxTier];
      return { recipientId: e.recipientId, bandAllows: e.maxTier, owedCents: owed, plannedCents: Math.min(owed, planned.get(e.recipientId) ?? 0) };
    });
    const owed = rows.reduce((t, r) => t + r.owedCents, 0);
    const got = rows.reduce((t, r) => t + r.plannedCents, 0);
    return {
      checked: true,
      eligibleHouseholds: rows.length,
      owedUsd: usd(owed),
      plannedUsd: usd(got),
      shortfallUsd: usd(owed - got),
      householdsShort: rows
        .filter((r) => r.plannedCents < r.owedCents)
        .map((r) => ({ recipientId: r.recipientId, bandAllows: r.bandAllows, owedUsd: usd(r.owedCents), plannedUsd: usd(r.plannedCents) })),
    };
  })();
  return {
    dryRun: true as const,
    eventId: verdict.eventId,
    overall: verdict.overall,
    meaning: MEANING[verdict.overall],
    decision: verdict.decision,
    totalUsd: usd(verdict.totalCents),
    items: verdict.items.map((i) => ({
      index: i.index,
      recipientId: i.recipientId,
      requestedTier: i.requestedTier,
      allowedTier: i.allowedTier,
      verdict: i.verdict,
      amountUsd: usd(i.amountCents),
      reasons: verdictReasons(i),
    })),
    findings: verdict.planRules.map((r) => ({ rule: r.id, status: r.status, code: r.reasonCode, plain: plainRule(r) || r.detail })),
    coverage,
    basis: {
      registryHouseholds: ctx.registry.length,
      poolBalanceUsd: usd(ctx.ledger.poolBalanceCents),
      corroboration: basis.assessedPlanId === null ? 'none: this earthquake has not been assessed on this server yet' : `from the latest assessment (plan ${basis.assessedPlanId})`,
      checkedAt: new Date(ctx.now).toISOString(),
    },
    note: DRY_RUN_NOTE,
  };
}

/** Calls allowed across everyone in a rolling window (the MCP server is stateless and public). */
export class RollingLimit {
  private calls: number[] = [];
  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  take(): boolean {
    const now = this.clock();
    this.calls = this.calls.filter((t) => t > now - this.windowMs);
    if (this.calls.length >= this.limit) return false;
    this.calls.push(now);
    return true;
  }
}

/** Shared by every MCP request in this process. */
export const dryRunLimit = new RollingLimit(30, 60_000);
