import { describe, expect, it } from 'vitest';
import type { RuleResult } from '../src/firewall/types';
import { draftLang, extraFields, findingTitle, flagText, noteLang, plainRule, planSummary, planTitle, usdShort, verdictReasons } from '../src/ui/plain';

const rule = (id: RuleResult['id'], status: RuleResult['status'], reasonCode: RuleResult['reasonCode'], detail: string, scope: RuleResult['scope'] = 'plan'): RuleResult => ({
  id,
  scope,
  status,
  reasonCode,
  detail,
});

describe('plain-language firewall wording', () => {
  it('rewrites the approval threshold in plain words', () => {
    expect(plainRule(rule('R10', 'warn', 'OVER_APPROVAL_THRESHOLD', 'total $680.00 > auto-approve limit $300.00'))).toBe(
      '$680 is over the $300 that can be sent without review.',
    );
  });

  it('keeps every R10 reason and can drop the generic warnings line', () => {
    const r = rule('R10', 'warn', 'OVER_APPROVAL_THRESHOLD', 'total $680.00 > auto-approve limit $300.00; 1 item(s) blocked; other rules raised warnings');
    expect(plainRule(r)).toContain('1 household in the plan');
    expect(plainRule(r)).toContain('Other checks raised warnings.');
    expect(plainRule(r, { omitWarningsSummary: true })).not.toContain('Other checks');
  });

  it('describes distance rules with rounded kilometres', () => {
    expect(plainRule(rule('R2', 'block', 'OUTSIDE_MAX_RADIUS', '343.2 km from epicentre; max radius 300 km', 'item'))).toBe(
      '343 km from the epicentre, beyond the 300 km limit for any payment.',
    );
    expect(plainRule(rule('R2', 'pass', 'TIER_WITHIN_BAND', 'tier A at 53.3 km; max A (band B, +1 tier for mobility impaired)', 'item'))).toBe(
      '53 km from the epicentre. Tier A is allowed: band B, one tier higher for mobility impaired.',
    );
  });

  it('falls back to the raw detail for unrecognised text', () => {
    expect(plainRule(rule('R5', 'warn', 'BUDGET_SOFT_LIMIT', 'something new'))).toBe('Something new.');
  });

  it('formats short dollars', () => {
    expect(usdShort(68000)).toBe('$680');
    expect(usdShort(8050)).toBe('$80.50');
  });

  it('puts the approval reason first for an item that needs approval', () => {
    const reasons = verdictReasons({
      verdict: 'REQUIRE_APPROVAL',
      ruleTrace: [rule('R2', 'warn', 'TIER_DOWNGRADED', 'agent requested tier A; 120.0 km allows at most B', 'item'), rule('R10', 'warn', 'OVER_APPROVAL_THRESHOLD', 'total $680.00 > auto-approve limit $300.00; other rules raised warnings')],
    });
    expect(reasons[0]).toBe('$680 is over the $300 that can be sent without review.');
    expect(reasons[1]).toContain('so it was lowered');
  });

  it('marks a replaced agent draft as English', () => {
    expect(draftLang({ ruleTrace: [rule('R9', 'warn', 'NOTE_REPLACED', 'note contains a link or domain; fallback text used', 'item')] }, 'es')).toBe('en');
    expect(draftLang({ ruleTrace: [rule('R9', 'pass', 'NOTE_OK', '42 chars', 'item')] }, 'es')).toBe('es');
  });

  it('the note PayPal sends is in the household language when paid, English fallback when not', () => {
    expect(noteLang({ amountCents: 120_00 }, 'ja')).toBe('ja');
    expect(noteLang({ amountCents: 0 }, 'ja')).toBe('en');
  });

  it('explains R12 findings in plain words', () => {
    expect(plainRule(rule('R12', 'warn', 'ELIGIBLE_OMITTED', '2 eligible household(s) left out of the plan: rcp_03, rcp_05', 'plan'))).toBe(
      'The plan leaves out 2 households who should be paid (rcp_03, rcp_05). A person decides.',
    );
  });
});

describe('plan headings and summary', () => {
  const recipients = [
    { recipientId: 'a', town: 'Macaracas', home: { lat: 7.73, lon: -80.55 } },
    { recipientId: 'b', town: 'Yaviza', home: { lat: 8.1569, lon: -77.6928 } },
  ];
  const plan = {
    id: 1,
    status: 'assessed',
    decision: 'trigger',
    agent: { reason: null },
    corroboration: { mode: 'emsc' },
    recipients,
    verdict: {
      totalCents: 12000,
      planRules: [rule('R8', 'pass', 'TRIGGER_CORROBORATED', 'M7.7 meets threshold; 2 independent sources agree')],
      items: [{ recipientId: 'a', verdict: 'REQUIRE_APPROVAL', distanceKm: 26.4 }],
    },
  };
  const event = { mag: 7.7, place: '10 km WSW of Pitaloza Arriba, Panama', epicentre: { lat: 7.35, lon: -80.75 } };

  it('titles a plan by its earthquake', () => {
    expect(planTitle(plan, event)).toBe('M7.7 Panama earthquake: 1 household, $120');
    expect(planTitle(plan, null)).toBe('Plan 1: 1 household, $120');
  });

  it('summarises the decision and who was left out', () => {
    const s = planSummary(plan, event);
    expect(s).toMatch(/^Trigger: M7\.7 confirmed by two agencies\. 1 of 2 households in the plan\. 1 left out: Yaviza \(\d+ km\)\.$/);
  });
});

describe('machine strings in plain words', () => {
  it('summarises extra plan fields instead of dumping JSON paths', () => {
    expect(extraFields('ignored unknown field(s): $.items[0].amount, $.items[0].receiver, $.items[1].amount')).toBe('added payout fields: amount, receiver');
    expect(extraFields('ignored unknown field(s): $.receiver')).toBe('added plan field: receiver');
    expect(extraFields('ignored unknown field(s): $.items[0].email, $.override')).toBe('added payout field: email; added plan field: override');
    expect(extraFields('nothing listed')).toBeNull();
    const t = plainRule(rule('R9', 'warn', 'PLAN_UNKNOWN_FIELDS', 'ignored unknown field(s): $.items[0].amount, $.items[0].receiver'));
    expect(t).toBe('The agent added payout fields: amount, receiver. They were ignored, and a person checks the plan.');
    expect(t).not.toContain('$.');
  });

  it('gives each R9 and R12 finding its own title', () => {
    const r9 = ['PLAN_CLEAN', 'PLAN_UNKNOWN_FIELDS', 'INJECTION_SUSPECTED', 'EXCEPTION_REQUESTED', 'AGENT_ESCALATED', 'NOTE_OK'].map(findingTitle);
    expect(r9.every((x) => typeof x === 'string' && x.length > 0)).toBe(true);
    expect(new Set(r9.slice(0, 5)).size).toBe(5);
    expect(findingTitle('ELIGIBLE_OMITTED')).toBe('Eligible households left out');
    // Single-finding rules keep the rule's own name.
    expect(findingTitle('REGISTERED_ELIGIBLE')).toBeNull();
  });

  it('writes vulnerability flags as words', () => {
    expect(flagText(['mobility_impaired', 'sole_caregiver'])).toBe('mobility impaired, sole caregiver');
    expect(flagText([])).toBe('');
  });
});
