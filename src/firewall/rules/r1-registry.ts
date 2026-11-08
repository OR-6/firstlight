import type { FirewallContext, RegistryRecipient, RuleResult } from '../types';

const HOUR_MS = 3_600_000;

/** R1 — recipient exists, is verified, and registered ≥ N hours before the event. */
export function r1Registry(
  recipientId: string,
  ctx: FirewallContext,
): { result: RuleResult; recipient: RegistryRecipient | null } {
  const recipient = ctx.registry.find((r) => r.recipientId === recipientId) ?? null;
  if (!recipient) {
    return {
      recipient: null,
      result: block('UNKNOWN_RECIPIENT', `recipientId ${JSON.stringify(recipientId)} is not in the registry`),
    };
  }
  if (!recipient.verified) {
    return { recipient, result: block('RECIPIENT_UNVERIFIED', 'recipient has not completed verification') };
  }
  const cutoff = ctx.event.time - ctx.config.minRegistrationLeadHours * HOUR_MS;
  if (recipient.registeredAt > cutoff) {
    const leadH = (ctx.event.time - recipient.registeredAt) / HOUR_MS;
    return {
      recipient,
      result: block(
        'REGISTERED_TOO_LATE',
        `registered ${leadH.toFixed(1)}h before the event; ${ctx.config.minRegistrationLeadHours}h required`,
      ),
    };
  }
  return {
    recipient,
    result: { id: 'R1', scope: 'item', status: 'pass', reasonCode: 'REGISTERED_ELIGIBLE', detail: 'verified, registered before cutoff' },
  };
}

function block(reasonCode: RuleResult['reasonCode'], detail: string): RuleResult {
  return { id: 'R1', scope: 'item', status: 'block', reasonCode, detail };
}
