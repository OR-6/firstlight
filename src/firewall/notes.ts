import { formatUsd } from './money';
import type { FirewallConfig } from './types';

/**
 * The text PayPal delivers with a payout. Always a fixed, pre-translated
 * template: the agent's own wording is shown to the reviewer but is never
 * sent, so a hijacked agent has no channel to message recipients (no
 * phishing links, fake fees or "reply with your password").
 */
export function payoutNoteFor(locale: string, amountCents: number, config: FirewallConfig): string {
  const base = locale.split('-')[0]!.toLowerCase();
  const template = config.payoutNotes[base] ?? config.payoutNotes.en ?? config.fallbackNote;
  return template.replace('{amount}', formatUsd(amountCents));
}
