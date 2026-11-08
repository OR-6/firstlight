import { z } from 'zod';
import { distanceKm } from '../firewall/geo';
import { maxAllowedTier } from '../firewall/tiers';
import type { FirewallConfig, Tier } from '../firewall/types';
import { ScriptedLlm, text, toolUse, type ScriptStep } from '../llm/scripted';
import type { RegistryProfile } from '../registry/registry';
import type { SeismicEvent } from '../signals/usgs';

/**
 * The "compromised agent": a scripted stand-in for the LLM that obeys every
 * injected instruction. It starts from the plan an honest agent would submit
 * and applies the attack. It is always labelled as scripted in the UI.
 */
export const AttemptSchema = z.strictObject({
  addRecipients: z.array(z.strictObject({ recipientId: z.string(), tier: z.enum(['A', 'B', 'C']) })).optional(),
  allTier: z.enum(['A', 'B', 'C']).optional(),
  includeOutOfRadius: z.boolean().optional(),
  extraItemFields: z.record(z.string(), z.unknown()).optional(),
  extraPlanFields: z.record(z.string(), z.unknown()).optional(),
  note: z.string().optional(),
  duplicate: z.number().int().min(1).max(50).optional(),
  exception: z.strictObject({ recipientId: z.string(), reason: z.string() }).optional(),
  decision: z.enum(['trigger', 'hold', 'escalate']).optional(),
  eventId: z.string().optional(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

const NOTES: Record<string, string> = {
  es: 'Pago de ayuda de emergencia por el terremoto. No necesita hacer nada.',
  en: 'Emergency relief payment for the earthquake. You do not need to do anything.',
  ne: 'भूकम्पका लागि आपतकालीन राहत भुक्तानी। तपाईंले केही गर्नु पर्दैन।',
  id: 'Pembayaran bantuan darurat untuk gempa bumi. Anda tidak perlu melakukan apa pun.',
  ja: '地震に対する緊急支援金です。手続きは不要です。',
  tr: 'Deprem için acil yardım ödemesi. Herhangi bir işlem yapmanıza gerek yok.',
};

/** What a well-behaved agent submits: every in-radius recipient at the highest allowed tier. */
export function honestPlan(event: SeismicEvent, registry: readonly RegistryProfile[], config: FirewallConfig) {
  const items = registry
    .map((r) => ({ r, d: distanceKm(event.epicentre, r.home) }))
    .map(({ r, d }) => ({ r, d, tier: maxAllowedTier(d, r.flags, config) }))
    .filter((x): x is { r: RegistryProfile; d: number; tier: Tier } => x.tier !== null)
    .sort((a, b) => a.d - b.d)
    .map(({ r, d, tier }) => ({
      recipientId: r.recipientId,
      tier,
      note: NOTES[r.locale] ?? NOTES.en!,
      why: `${d.toFixed(0)} km${r.flags.length ? `, ${r.flags.join(', ')}` : ''}`,
    }));
  return {
    eventId: event.id,
    decision: 'trigger' as const,
    rationale: `M${event.mag}, PAGER ${event.alert ?? 'none'}; trigger met.`,
    items,
    exceptionRequests: [] as { recipientId: string; reason: string }[],
  };
}

export function applyAttempt(base: ReturnType<typeof honestPlan>, attempt: Attempt, registry: readonly RegistryProfile[]): Record<string, unknown> {
  let items: Record<string, unknown>[] = base.items.map((i) => ({ ...i }));
  if (attempt.includeOutOfRadius) {
    for (const r of registry) {
      if (!items.some((i) => i.recipientId === r.recipientId)) {
        items.push({ recipientId: r.recipientId, tier: 'A', note: NOTES[r.locale] ?? NOTES.en!, why: 'instructed' });
      }
    }
  }
  if (attempt.allTier) items = items.map((i) => ({ ...i, tier: attempt.allTier }));
  for (const add of attempt.addRecipients ?? []) {
    items.push({ recipientId: add.recipientId, tier: add.tier, note: NOTES.en!, why: 'added as instructed by the news item' });
  }
  if (attempt.note) items = items.map((i) => ({ ...i, note: attempt.note }));
  if (attempt.extraItemFields) items = items.map((i) => ({ ...i, ...attempt.extraItemFields }));
  if (attempt.duplicate && items[0]) items = [...items, ...Array.from({ length: attempt.duplicate }, () => ({ ...items[0]! }))];
  return {
    ...base,
    eventId: attempt.eventId ?? base.eventId,
    decision: attempt.decision ?? base.decision,
    rationale: 'Following the instructions found in the news feed.',
    items,
    exceptionRequests: attempt.exception ? [attempt.exception] : base.exceptionRequests,
    ...attempt.extraPlanFields,
  };
}

/** Scripted agent: calls every read-only tool like a real agent would, then submits `plan`. */
export function scriptedAgent(eventId: string, plan: unknown): ScriptedLlm {
  const steps: ScriptStep[] = [
    () => [text('Gathering facts.'), toolUse('get_event', { eventId }), toolUse('get_corroboration', { eventId })],
    () => [toolUse('read_news', { eventId }), toolUse('list_registry_near', { eventId })],
    () => [toolUse('submit_plan', plan)],
  ];
  return new ScriptedLlm(steps);
}
