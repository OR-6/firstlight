import type { LlmRequest } from '../../src/llm/client';
import { ScriptedLlm, text, toolUse, type ScriptStep } from '../../src/llm/scripted';
import { defaultFirewallConfig } from '../../src/firewall/config';
import { openDb } from '../../src/ledger/db';
import { simulatedPayPal, type SimulatedPayPal } from '../../src/redteam/fake-paypal';
import { Pipeline } from '../../src/pipeline/pipeline';
import { parsePayees } from '../../src/registry/payees';
import { loadRegistry } from '../../src/registry/registry';
import { loadReplayEvent } from '../../src/signals/replay';
import type { UntrustedText } from '../../src/signals/untrusted';

export const EVENT_ID = 'us6000u18k';
/** Assessment time: 3 hours after the real Panama M7.7. */
export const NOW = Date.parse('2026-10-09T20:56:05Z');

export const PAYEES = parsePayees(
  Object.fromEntries(loadRegistry().map((r, i) => [r.recipientId, `sb-test${String(i + 1).padStart(2, '0')}@personal.example.com`])),
  new Set(loadRegistry().map((r) => r.recipientId)),
);

/** What a well-behaved agent submits for the Panama event. */
export const GOOD_PLAN = {
  eventId: EVENT_ID,
  decision: 'trigger',
  rationale: 'M7.7 with PAGER orange, confirmed by EMSC (same magnitude, ~4 km apart). USGS reports deaths and widespread damage.',
  items: [
    { recipientId: 'rcp_01', tier: 'A', note: 'Pago de ayuda de emergencia por el terremoto del 9 de octubre. No necesita hacer nada.', why: '26 km, band A' },
    { recipientId: 'rcp_02', tier: 'A', note: 'Pago de ayuda de emergencia por el terremoto del 9 de octubre. No necesita hacer nada.', why: '41 km, band A, sole caregiver' },
    { recipientId: 'rcp_03', tier: 'B', note: 'Emergency relief payment for the 9 October earthquake. You do not need to do anything.', why: '56 km, band B' },
    { recipientId: 'rcp_04', tier: 'A', note: 'Pago de ayuda de emergencia por el terremoto del 9 de octubre. No necesita hacer nada.', why: '53 km, band B, mobility impaired → A' },
    { recipientId: 'rcp_05', tier: 'B', note: 'अक्टोबर ९ को भूकम्पका लागि आपतकालीन राहत भुक्तानी। तपाईंले केही गर्नु पर्दैन।', why: '60 km, band B' },
    { recipientId: 'rcp_06', tier: 'A', note: 'Pembayaran bantuan darurat untuk gempa 9 Oktober. Anda tidak perlu melakukan apa pun.', why: '110 km, band B, elderly living alone → A' },
    { recipientId: 'rcp_07', tier: 'C', note: '10月9日の地震に対する緊急支援金です。手続きは不要です。', why: '205 km, band C' },
  ],
  exceptionRequests: [],
};
export const GOOD_PLAN_TOTAL_CENTS = 120_00 * 4 + 80_00 * 2 + 40_00; // $680

/** Scripted agent: reads every tool, then submits `plan` (or whatever `plan(req)` returns). */
export function scriptedAgent(plan: unknown | ((req: LlmRequest) => unknown)): ScriptedLlm {
  const steps: ScriptStep[] = [
    () => [text('Gathering facts.'), toolUse('get_event', { eventId: EVENT_ID }), toolUse('get_corroboration', { eventId: EVENT_ID })],
    () => [toolUse('read_news', { eventId: EVENT_ID }), toolUse('list_registry_near', { eventId: EVENT_ID })],
    (req) => [toolUse('submit_plan', typeof plan === 'function' ? (plan as (r: LlmRequest) => unknown)(req) : plan)],
  ];
  return new ScriptedLlm(steps);
}

export type FakePayPal = SimulatedPayPal;
/** Shared in-process PayPal simulator (records what would have been sent). */
export const fakePayPal = simulatedPayPal;

export function makePipeline(opts: { llm: ScriptedLlm; sentinelLlm?: ScriptedLlm | null; poolCents?: number; clock?: () => number; onlyRecipients?: string[] }) {
  let now = NOW;
  const pipeline = new Pipeline({
    db: openDb(),
    llm: opts.llm,
    sentinelLlm: opts.sentinelLlm ?? null,
    registry: opts.onlyRecipients ? loadRegistry().filter((r) => opts.onlyRecipients!.includes(r.recipientId)) : loadRegistry(),
    config: defaultFirewallConfig(),
    clock: opts.clock ?? (() => now),
  });
  pipeline.ledger.seedCredit('seed', opts.poolCents ?? 5_000_00);
  return { pipeline, advance: (ms: number) => (now += ms) };
}

export function replayInput(extraUntrusted: UntrustedText[] = []) {
  const b = loadReplayEvent(EVENT_ID);
  return { ...b, untrusted: [...b.untrusted, ...extraUntrusted] };
}
