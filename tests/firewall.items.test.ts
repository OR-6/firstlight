import { describe, expect, it } from 'vitest';
import { evaluatePlan } from '../src/firewall/engine';
import type { ReasonCode, RegistryRecipient, Tier, VerdictKind } from '../src/firewall/types';
import {
  DAY,
  EVENT_ID,
  EVENT_TIME,
  HOUR,
  NOW,
  REGISTRY,
  ctx,
  emptyLedger,
  plan,
  recipient,
  type CtxOverrides,
  type ItemInput,
} from './helpers/firewall-fixture';

/**
 * Item-level rules (R1 registry, R2 tier band, R3 amount, R4 caps, R6
 * duplicates, R9 note hygiene). Each row submits a plan and checks the first
 * item's verdict, amount, allowed tier and that a reason code appears in its
 * trace.
 */
type Row = {
  name: string;
  items: ItemInput[];
  ctx?: CtxOverrides;
  /** Expectations for items[expectIndex] (default 0). */
  expectIndex?: number;
  verdict: VerdictKind;
  amountCents: number;
  allowedTier?: Tier | null;
  code: ReasonCode;
  note?: string;
};

const fallback = ctx().config.fallbackNote;
const withRecipients = (...extra: RegistryRecipient[]): CtxOverrides => ({ registry: [...REGISTRY, ...extra] });
const priorPayout = (p: Partial<{ eventId: string; recipientId: string; amountCents: number; at: number; status: string }>) =>
  ({
    ledger: {
      ...emptyLedger(),
      payouts: [{ eventId: 'us_other', recipientId: 'rcp_a10', amountCents: 40_00, at: NOW - 30 * DAY, status: 'SUCCESS', ...p }],
    },
  }) satisfies CtxOverrides;

const rows: Row[] = [
  // ── R1 registry ──────────────────────────────────────────────────────────
  { name: 'R1 pass: verified recipient registered 30d before', items: [{ recipientId: 'rcp_a10', tier: 'A' }], verdict: 'ALLOW', amountCents: 120_00, allowedTier: 'A', code: 'REGISTERED_ELIGIBLE' },
  { name: 'R1 block: recipientId not in registry', items: [{ recipientId: 'rcp_nobody', tier: 'C' }], verdict: 'BLOCK', amountCents: 0, allowedTier: null, code: 'UNKNOWN_RECIPIENT' },
  { name: 'R1 block: agent puts an email where an id goes', items: [{ recipientId: 'attacker@evil.example', tier: 'A' }], verdict: 'BLOCK', amountCents: 0, code: 'UNKNOWN_RECIPIENT' },
  { name: 'R1 block: homoglyph id (full-width zero)', items: [{ recipientId: 'rcp_a1０', tier: 'A' }], verdict: 'BLOCK', amountCents: 0, code: 'UNKNOWN_RECIPIENT' },
  { name: 'R1 block: case-variant id', items: [{ recipientId: 'RCP_A10', tier: 'A' }], verdict: 'BLOCK', amountCents: 0, code: 'UNKNOWN_RECIPIENT' },
  { name: 'R1 block: id with trailing space', items: [{ recipientId: 'rcp_a10 ', tier: 'A' }], verdict: 'BLOCK', amountCents: 0, code: 'UNKNOWN_RECIPIENT' },
  { name: 'R1 block: unverified recipient', items: [{ recipientId: 'rcp_unverified', tier: 'A' }], verdict: 'BLOCK', amountCents: 0, code: 'RECIPIENT_UNVERIFIED' },
  { name: 'R1 block: registered 71h before event', items: [{ recipientId: 'rcp_late', tier: 'A' }], verdict: 'BLOCK', amountCents: 0, code: 'REGISTERED_TOO_LATE' },
  { name: 'R1 pass: registered exactly 72h before (boundary)', items: [{ recipientId: 'rcp_edge72', tier: 'A' }], verdict: 'ALLOW', amountCents: 120_00, code: 'REGISTERED_ELIGIBLE' },
  { name: 'R1 block: registered after the event (post-event signup)', items: [{ recipientId: 'rcp_post', tier: 'A' }], ctx: withRecipients(recipient('rcp_post', 5, { registeredAt: EVENT_TIME + HOUR })), verdict: 'BLOCK', amountCents: 0, code: 'REGISTERED_TOO_LATE' },

  // ── R2 tier band / R3 amount ─────────────────────────────────────────────
  { name: 'R2 pass: tier A at 40 km', items: [{ recipientId: 'rcp_a40', tier: 'A' }], verdict: 'ALLOW', amountCents: 120_00, allowedTier: 'A', code: 'TIER_WITHIN_BAND' },
  { name: 'R2 pass: tier A at exactly 50 km (band edge inclusive)', items: [{ recipientId: 'rcp_50', tier: 'A' }], ctx: withRecipients(recipient('rcp_50', 50)), verdict: 'ALLOW', amountCents: 120_00, allowedTier: 'A', code: 'TIER_WITHIN_BAND' },
  { name: 'R2 downgrade: tier A at 50.1 km → B', items: [{ recipientId: 'rcp_50p', tier: 'A' }], ctx: withRecipients(recipient('rcp_50p', 50.1)), verdict: 'REQUIRE_APPROVAL', amountCents: 80_00, allowedTier: 'B', code: 'TIER_DOWNGRADED' },
  { name: 'R2 downgrade: escalation attempt A at 120 km → B', items: [{ recipientId: 'rcp_b120', tier: 'A' }], verdict: 'REQUIRE_APPROVAL', amountCents: 80_00, allowedTier: 'B', code: 'TIER_DOWNGRADED' },
  { name: 'R2 pass: vulnerability uplift B-band → A', items: [{ recipientId: 'rcp_b120_vuln', tier: 'A' }], verdict: 'ALLOW', amountCents: 120_00, allowedTier: 'A', code: 'TIER_WITHIN_BAND' },
  { name: 'R2 downgrade: uplift is one tier only (C-band vuln asks A → B)', items: [{ recipientId: 'rcp_c250_vuln', tier: 'A' }], verdict: 'REQUIRE_APPROVAL', amountCents: 80_00, allowedTier: 'B', code: 'TIER_DOWNGRADED' },
  { name: 'R2 downgrade: C-band asks A → C', items: [{ recipientId: 'rcp_c250', tier: 'A' }], verdict: 'REQUIRE_APPROVAL', amountCents: 40_00, allowedTier: 'C', code: 'TIER_DOWNGRADED' },
  { name: 'R2 pass: agent may choose lower than allowed (A-band, tier C)', items: [{ recipientId: 'rcp_a10', tier: 'C' }], verdict: 'ALLOW', amountCents: 40_00, allowedTier: 'C', code: 'TIER_WITHIN_BAND' },
  { name: 'R2 pass: exactly at 300 km max radius', items: [{ recipientId: 'rcp_300', tier: 'C' }], ctx: withRecipients(recipient('rcp_300', 300)), verdict: 'ALLOW', amountCents: 40_00, allowedTier: 'C', code: 'TIER_WITHIN_BAND' },
  { name: 'R2 block: 300.1 km is outside the radius', items: [{ recipientId: 'rcp_300p', tier: 'C' }], ctx: withRecipients(recipient('rcp_300p', 300.1)), verdict: 'BLOCK', amountCents: 0, allowedTier: null, code: 'OUTSIDE_MAX_RADIUS' },
  { name: 'R2 block: 400 km outside radius', items: [{ recipientId: 'rcp_far400', tier: 'C' }], verdict: 'BLOCK', amountCents: 0, code: 'OUTSIDE_MAX_RADIUS' },
  { name: 'R2 block: vulnerability uplift cannot rescue out-of-radius', items: [{ recipientId: 'rcp_far400_vuln', tier: 'C' }], verdict: 'BLOCK', amountCents: 0, code: 'OUTSIDE_MAX_RADIUS' },
  { name: 'R3: amount always comes from the configured tier table', items: [{ recipientId: 'rcp_a10', tier: 'A' }], ctx: { config: { tierAmountsCents: { A: 101_23, B: 50_00, C: 10_00 } } }, verdict: 'ALLOW', amountCents: 101_23, code: 'AMOUNT_FROM_TIER_TABLE' },

  // ── R4 per-recipient caps ────────────────────────────────────────────────
  { name: 'R4 block: rolling 90d cap ($40 earlier + $120 > $150)', items: [{ recipientId: 'rcp_a10', tier: 'A' }], ctx: priorPayout({}), verdict: 'BLOCK', amountCents: 0, code: 'RECIPIENT_ROLLING_CAP_EXCEEDED' },
  { name: 'R4 pass: rolling cap boundary ($30 + $120 = $150)', items: [{ recipientId: 'rcp_a10', tier: 'A' }], ctx: priorPayout({ amountCents: 30_00 }), verdict: 'ALLOW', amountCents: 120_00, code: 'WITHIN_RECIPIENT_CAPS' },
  { name: 'R4 pass: payout 91 days ago is outside the window', items: [{ recipientId: 'rcp_a10', tier: 'A' }], ctx: priorPayout({ amountCents: 120_00, at: NOW - 91 * DAY }), verdict: 'ALLOW', amountCents: 120_00, code: 'WITHIN_RECIPIENT_CAPS' },
  { name: 'R4 pass: FAILED payout never left the pool, does not count', items: [{ recipientId: 'rcp_a10', tier: 'A' }], ctx: priorPayout({ amountCents: 120_00, status: 'FAILED' }), verdict: 'ALLOW', amountCents: 120_00, code: 'WITHIN_RECIPIENT_CAPS' },
  { name: 'R4 block: UNCLAIMED payout still counts', items: [{ recipientId: 'rcp_a10', tier: 'A' }], ctx: priorPayout({ amountCents: 120_00, status: 'UNCLAIMED' }), verdict: 'BLOCK', amountCents: 0, code: 'RECIPIENT_ROLLING_CAP_EXCEEDED' },
  { name: 'R4 block: per-event cap below tier amount', items: [{ recipientId: 'rcp_a10', tier: 'A' }], ctx: { config: { perRecipientEventCapCents: 100_00 } }, verdict: 'BLOCK', amountCents: 0, code: 'RECIPIENT_EVENT_CAP_EXCEEDED' },

  // ── R6 duplicates / revisions ────────────────────────────────────────────
  { name: 'R6 block: already paid for this event', items: [{ recipientId: 'rcp_a10', tier: 'A' }], ctx: priorPayout({ eventId: EVENT_ID, amountCents: 120_00, at: NOW - HOUR }), verdict: 'BLOCK', amountCents: 0, code: 'ALREADY_PAID_FOR_EVENT' },
  { name: 'R6 block: already paid under a USGS alias id', items: [{ recipientId: 'rcp_a10', tier: 'A' }], ctx: priorPayout({ eventId: 'pt26282000', at: NOW - HOUR }), verdict: 'BLOCK', amountCents: 0, code: 'ALREADY_PAID_FOR_EVENT' },
  { name: 'R6 block: prior FAILED payout still blocks a re-pay via plan', items: [{ recipientId: 'rcp_a10', tier: 'A' }], ctx: priorPayout({ eventId: EVENT_ID, status: 'FAILED', at: NOW - HOUR }), verdict: 'BLOCK', amountCents: 0, code: 'ALREADY_PAID_FOR_EVENT' },
  { name: 'R6 block: second entry for the same recipient in one plan', items: [{ recipientId: 'rcp_a10', tier: 'C' }, { recipientId: 'rcp_a10', tier: 'A' }], expectIndex: 1, verdict: 'BLOCK', amountCents: 0, code: 'DUPLICATE_IN_PLAN' },
  { name: 'R6: first entry of a duplicated recipient survives but needs approval', items: [{ recipientId: 'rcp_a10', tier: 'C' }, { recipientId: 'rcp_a10', tier: 'A' }], expectIndex: 0, verdict: 'REQUIRE_APPROVAL', amountCents: 40_00, code: 'ITEMS_BLOCKED' },
  {
    name: 'R6 block: spoofed duplicate event (new id, same place and time)',
    items: [{ recipientId: 'rcp_a10', tier: 'A' }],
    ctx: {
      ledger: {
        ...emptyLedger(),
        payouts: [{ eventId: 'spoof_123', recipientId: 'rcp_a10', amountCents: 120_00, at: NOW - HOUR, status: 'SUCCESS' }],
        paidEvents: [{ eventId: 'spoof_123', aliases: [], time: EVENT_TIME + 60_000, epicentre: { lat: 7.65, lon: -80.7 } }],
      },
      config: { perRecipientRollingCapCents: 1_000_00 }, // isolate R6 from R4
    },
    verdict: 'BLOCK',
    amountCents: 0,
    code: 'ALREADY_PAID_FOR_SAME_DISASTER',
  },
  {
    name: 'R6 block: earlier event lists our id as its alias',
    items: [{ recipientId: 'rcp_a10', tier: 'A' }],
    ctx: {
      ledger: {
        ...emptyLedger(),
        payouts: [{ eventId: 'ci_far', recipientId: 'rcp_a10', amountCents: 40_00, at: NOW - HOUR, status: 'SUCCESS' }],
        paidEvents: [{ eventId: 'ci_far', aliases: [EVENT_ID], time: EVENT_TIME - 30 * DAY, epicentre: { lat: 40, lon: 0 } }],
      },
      config: { perRecipientRollingCapCents: 1_000_00 },
    },
    verdict: 'BLOCK',
    amountCents: 0,
    code: 'ALREADY_PAID_FOR_SAME_DISASTER',
  },
  {
    name: 'R6 pass: a distant, older disaster is a different event',
    items: [{ recipientId: 'rcp_a10', tier: 'A' }],
    ctx: {
      ledger: {
        ...emptyLedger(),
        payouts: [{ eventId: 'us_old', recipientId: 'rcp_a10', amountCents: 40_00, at: NOW - 100 * DAY, status: 'SUCCESS' }],
        paidEvents: [{ eventId: 'us_old', aliases: [], time: EVENT_TIME - 100 * DAY, epicentre: { lat: 14, lon: -90 } }],
      },
    },
    verdict: 'ALLOW',
    amountCents: 120_00,
    code: 'FIRST_PAYOUT',
  },

  // ── R9 note hygiene ──────────────────────────────────────────────────────
  { name: 'R9 note: link replaced', items: [{ recipientId: 'rcp_a10', tier: 'A', note: 'Claim at https://evil.example/claim' }], verdict: 'REQUIRE_APPROVAL', amountCents: 120_00, code: 'NOTE_REPLACED', note: fallback },
  { name: 'R9 note: bare domain replaced', items: [{ recipientId: 'rcp_a10', tier: 'A', note: 'Visita relief-help.xyz para verificar' }], verdict: 'REQUIRE_APPROVAL', amountCents: 120_00, code: 'NOTE_REPLACED', note: fallback },
  { name: 'R9 note: email replaced', items: [{ recipientId: 'rcp_a10', tier: 'A', note: 'Reply to agent@relief.example' }], verdict: 'REQUIRE_APPROVAL', amountCents: 120_00, code: 'NOTE_REPLACED', note: fallback },
  { name: 'R9 note: full-width @ email replaced', items: [{ recipientId: 'rcp_a10', tier: 'A', note: 'Escribe a pago＠relief．example' }], verdict: 'REQUIRE_APPROVAL', amountCents: 120_00, code: 'NOTE_REPLACED', note: fallback },
  { name: 'R9 note: phone number replaced', items: [{ recipientId: 'rcp_a10', tier: 'A', note: 'Llame al +507 6123-4567 para desbloquear' }], verdict: 'REQUIRE_APPROVAL', amountCents: 120_00, code: 'NOTE_REPLACED', note: fallback },
  { name: 'R9 note: zero-width character replaced', items: [{ recipientId: 'rcp_a10', tier: 'A', note: 'Pago de ayuda​ de emergencia' }], verdict: 'REQUIRE_APPROVAL', amountCents: 120_00, code: 'NOTE_REPLACED', note: fallback },
  { name: 'R9 note: 201 characters replaced', items: [{ recipientId: 'rcp_a10', tier: 'A', note: 'a'.repeat(201) }], verdict: 'REQUIRE_APPROVAL', amountCents: 120_00, code: 'NOTE_REPLACED', note: fallback },
  { name: 'R9 note: exactly 200 characters kept', items: [{ recipientId: 'rcp_a10', tier: 'A', note: 'a'.repeat(200) }], verdict: 'ALLOW', amountCents: 120_00, code: 'NOTE_OK', note: 'a'.repeat(200) },
  { name: 'R9 note: non-Latin script kept (Nepali)', items: [{ recipientId: 'rcp_a10', tier: 'A', note: 'आपतकालीन राहत भुक्तानी। तपाईंलाई केही गर्नु पर्दैन।' }], verdict: 'ALLOW', amountCents: 120_00, code: 'NOTE_OK', note: 'आपतकालीन राहत भुक्तानी। तपाईंलाई केही गर्नु पर्दैन।' },
  { name: 'R9 note: empty note uses fallback without warning', items: [{ recipientId: 'rcp_a10', tier: 'A', note: '   ' }], verdict: 'ALLOW', amountCents: 120_00, code: 'NOTE_OK', note: fallback },
];

describe('firewall item rules', () => {
  it.each(rows)('$name', (row) => {
    const v = evaluatePlan(plan(row.items), ctx(row.ctx));
    const item = v.items[row.expectIndex ?? 0];
    expect(item, 'item verdict exists').toBeDefined();
    if (!item) return;
    expect(item.verdict).toBe(row.verdict);
    expect(item.amountCents).toBe(row.amountCents);
    if (row.allowedTier !== undefined) expect(item.allowedTier).toBe(row.allowedTier);
    expect(item.ruleTrace.map((r) => r.reasonCode)).toContain(row.code);
    if (row.note !== undefined) expect(item.note).toBe(row.note);
    if (item.verdict === 'BLOCK') expect(item.amountCents).toBe(0);
  });
});
