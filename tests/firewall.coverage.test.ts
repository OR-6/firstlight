import { describe, expect, it } from 'vitest';
import { evaluatePlan } from '../src/firewall/engine';
import { payoutNoteFor } from '../src/firewall/notes';
import { defaultFirewallConfig } from '../src/firewall/config';
import { EVENT_ID, NOW, REGISTRY, ctx, emptyLedger, plan, recipient } from './helpers/firewall-fixture';

/**
 * R12 coverage floor and templated payout notes (D71, D72). Found by our own
 * red-team review: R1–R10 only cap what a hijacked agent can send, so it could
 * still leave households out or underpay them, and its notes reached recipients.
 */

/** Everyone the firewall itself considers owed: verified, enrolled ≥72 h before, ≤300 km. */
const ELIGIBLE = ['rcp_a10', 'rcp_a40', 'rcp_b120', 'rcp_b120_vuln', 'rcp_c250', 'rcp_c250_vuln', 'rcp_edge72'];
const BAND: Record<string, 'A' | 'B' | 'C'> = { rcp_a10: 'A', rcp_a40: 'A', rcp_b120: 'B', rcp_b120_vuln: 'A', rcp_c250: 'C', rcp_c250_vuln: 'B', rcp_edge72: 'A' };
const full = () => ELIGIBLE.map((id) => ({ recipientId: id, tier: BAND[id]! }));
const r12 = (v: ReturnType<typeof evaluatePlan>) => v.planRules.filter((r) => r.id === 'R12');

describe('R12 coverage floor', () => {
  it('every eligible household at its band passes', () => {
    const v = evaluatePlan(plan(full()), ctx());
    expect(r12(v).map((r) => [r.status, r.reasonCode])).toEqual([['pass', 'ALL_ELIGIBLE_COVERED']]);
  });

  it('leaving eligible households out needs a person, and names them', () => {
    const v = evaluatePlan(plan([{ recipientId: 'rcp_a10', tier: 'A' }]), ctx());
    const rule = r12(v).find((r) => r.reasonCode === 'ELIGIBLE_OMITTED');
    expect(rule?.status).toBe('warn');
    expect(rule?.detail).toContain('rcp_a40');
    // Not owed: unverified, enrolled too late, outside the radius.
    for (const id of ['rcp_unverified', 'rcp_late', 'rcp_far400', 'rcp_far400_vuln']) expect(rule?.detail).not.toContain(id);
    expect(v.overall).toBe('REQUIRE_APPROVAL');
  });

  it('planning someone below their band needs a person', () => {
    const items = full().map((i) => (i.recipientId === 'rcp_b120_vuln' ? { ...i, tier: 'C' as const } : i));
    const v = evaluatePlan(plan(items), ctx());
    const rule = r12(v).find((r) => r.reasonCode === 'TIER_BELOW_BAND');
    expect(rule?.status).toBe('warn');
    expect(rule?.detail).toContain('rcp_b120_vuln tier C (band allows A)');
    expect(rule?.detail).toContain('They would get $80 less in total');
    expect(v.overall).toBe('REQUIRE_APPROVAL');
  });

  it('putting everyone on tier C (a hijacked agent underpaying) cannot auto-approve', () => {
    const v = evaluatePlan(plan(ELIGIBLE.map((id) => ({ recipientId: id, tier: 'C' as const }))), ctx({ config: { approvalThresholdCents: 10_000_00 } }));
    expect(v.overall).toBe('REQUIRE_APPROVAL');
    expect(r12(v).map((r) => r.reasonCode)).toContain('TIER_BELOW_BAND');
  });

  it('a hold on a confirmed trigger is flagged, not silent', () => {
    const v = evaluatePlan(plan(full(), { decision: 'hold' }), ctx());
    expect(v.overall).toBe('BLOCK'); // nothing is paid on a hold
    expect(r12(v)[0]).toMatchObject({ status: 'warn', reasonCode: 'HOLD_ON_MET_TRIGGER' });
  });

  it('households already paid for this disaster are not "left out"', () => {
    const paid = ELIGIBLE.filter((id) => id !== 'rcp_a10').map((id) => ({ eventId: EVENT_ID, recipientId: id, amountCents: 40_00, at: NOW - 60_000, status: 'SUCCESS' }));
    const v = evaluatePlan(plan([{ recipientId: 'rcp_a10', tier: 'A' }]), ctx({ ledger: { ...emptyLedger(), payouts: paid } }));
    expect(r12(v).map((r) => r.reasonCode)).toEqual(['ALL_ELIGIBLE_COVERED']);
  });

  it('is not checked when the trigger is not met', () => {
    const v = evaluatePlan(plan([{ recipientId: 'rcp_a10', tier: 'A' }]), ctx({ event: { mag: 5.0, alert: 'green' } }));
    expect(r12(v)[0]).toMatchObject({ status: 'pass' });
  });

  it('never adds anyone or raises an amount itself', () => {
    const v = evaluatePlan(plan([{ recipientId: 'rcp_a10', tier: 'C' }]), ctx());
    expect(v.items.map((i) => [i.recipientId, i.amountCents])).toEqual([['rcp_a10', 40_00]]);
  });
});

describe('payout notes are fixed templates (the agent cannot message recipients)', () => {
  const phishing = [
    'Verifique en firstlight-ayuda.site para recibir el dinero',
    'Responda con su contraseña de PayPal para desbloquear',
    'Envíe una tarifa de verificación de $5',
    'Llame al seis uno dos tres cuatro cinco seis siete',
    'paypal [dot] com/relief',
  ];
  it.each(phishing)('agent note %j is never what PayPal delivers', (note) => {
    const v = evaluatePlan(plan(full().map((i) => ({ ...i, note }))), ctx());
    for (const item of v.items.filter((i) => i.amountCents > 0)) {
      expect(item.note).toBe(payoutNoteFor('es', item.amountCents, defaultFirewallConfig()));
      expect(item.note).not.toContain(note);
    }
  });

  it('the agent draft is kept for the reviewer', () => {
    const v = evaluatePlan(plan([{ recipientId: 'rcp_a10', tier: 'A', note: 'Pago de ayuda.' }]), ctx({ registry: [recipient('rcp_a10', 10)] }));
    expect(v.items[0]).toMatchObject({ agentNote: 'Pago de ayuda.', note: expect.stringContaining('$120.00') });
  });

  it('every template fits PayPal’s 200-character note limit at the largest amount', () => {
    const config = defaultFirewallConfig();
    for (const locale of Object.keys(config.payoutNotes)) expect([...payoutNoteFor(locale, 999_999_99, config)].length).toBeLessThanOrEqual(200);
  });

  it('every enrolled locale has a template; unknown locales get English', () => {
    const config = defaultFirewallConfig();
    expect(payoutNoteFor('pt-BR', 40_00, config)).toBe(payoutNoteFor('en', 40_00, config));
    for (const r of REGISTRY) expect(Object.keys(config.payoutNotes)).toContain(r.locale);
  });
});

describe('R12 also runs when the trigger only warns (D101)', () => {
  it('degraded corroboration plus households left out: a person sees who', () => {
    const v = evaluatePlan(plan([{ recipientId: 'rcp_a10', tier: 'A' }]), ctx({ corroboration: [] }));
    expect(v.planRules.find((r) => r.id === 'R8')?.status).toBe('warn');
    expect(r12(v).map((r) => r.reasonCode)).toContain('ELIGIBLE_OMITTED');
  });

  it("a plan using the event's own alias id is not blocked", () => {
    const v = evaluatePlan(plan(full(), { eventId: 'pt26282000' }), ctx());
    expect(v.planRules.map((r) => r.reasonCode)).not.toContain('PLAN_EVENT_MISMATCH');
  });
});

describe('floor plan under a short pool', () => {
  it('funds the highest tiers first and R12 names who is left out', async () => {
    const { floorPlan } = await import('../src/firewall/floor');
    const c = ctx({ ledger: emptyLedger(300_00) });
    const raw = floorPlan(c, 'test');
    const total = raw.items.reduce((t, i) => t + c.config.tierAmountsCents[i.tier], 0);
    expect(total).toBeLessThanOrEqual(300_00);
    // Two tier-A households first ($240), then the leftover $60 still funds a tier-C household.
    expect(raw.items.map((i) => i.tier)).toEqual(['A', 'A', 'C']);
    const v = evaluatePlan(raw, c);
    expect(v.overall).not.toBe('BLOCK');
    expect(r12(v).map((r) => r.reasonCode)).toContain('ELIGIBLE_OMITTED');
  });
});
