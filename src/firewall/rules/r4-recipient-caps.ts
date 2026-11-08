import { formatUsd } from '../money';
import type { FirewallContext, RuleResult } from '../types';
import { countsAgainstCaps, currentEventIds } from './shared';

const DAY_MS = 86_400_000;

/** R4 — per-recipient cap for this event and over a rolling window. Over → BLOCK (never trimmed). */
export function r4RecipientCaps(recipientId: string, amountCents: number, ctx: FirewallContext): RuleResult {
  const { perRecipientEventCapCents, perRecipientRollingCapCents, rollingWindowDays } = ctx.config;
  const eventIds = currentEventIds(ctx);
  const mine = ctx.ledger.payouts.filter((p) => p.recipientId === recipientId && countsAgainstCaps(p));

  const eventPrior = mine.filter((p) => eventIds.has(p.eventId)).reduce((s, p) => s + p.amountCents, 0);
  if (eventPrior + amountCents > perRecipientEventCapCents) {
    return {
      id: 'R4',
      scope: 'item',
      status: 'block',
      reasonCode: 'RECIPIENT_EVENT_CAP_EXCEEDED',
      detail: `${formatUsd(eventPrior)} already + ${formatUsd(amountCents)} > per-event cap ${formatUsd(perRecipientEventCapCents)}`,
    };
  }

  const since = ctx.now - rollingWindowDays * DAY_MS;
  const rollingPrior = mine.filter((p) => p.at > since).reduce((s, p) => s + p.amountCents, 0);
  if (rollingPrior + amountCents > perRecipientRollingCapCents) {
    return {
      id: 'R4',
      scope: 'item',
      status: 'block',
      reasonCode: 'RECIPIENT_ROLLING_CAP_EXCEEDED',
      detail: `${formatUsd(rollingPrior)} in last ${rollingWindowDays}d + ${formatUsd(amountCents)} > cap ${formatUsd(perRecipientRollingCapCents)}`,
    };
  }

  return {
    id: 'R4',
    scope: 'item',
    status: 'pass',
    reasonCode: 'WITHIN_RECIPIENT_CAPS',
    detail: `${formatUsd(rollingPrior + amountCents)} of ${formatUsd(perRecipientRollingCapCents)} in ${rollingWindowDays}d`,
  };
}
