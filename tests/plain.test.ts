import { describe, expect, it } from 'vitest';
import type { RuleResult } from '../src/firewall/types';
import { defaultFirewallConfig } from '../src/firewall/config';
import { agentSummary, draftLang, exceptionItems, extraFields, findingTitle, flagText, noteChip, noteLang, outerLimitKm, plainRule, planSummary, planTitle, usdShort, verdictReasons } from '../src/ui/plain';

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
    expect(new Set(r9).size).toBe(6);
    expect(findingTitle('NOTE_OK')).toBe('Draft note');
    expect(findingTitle('EXCEPTION_REQUESTED')).toBe('Exceptions');
    expect(findingTitle('ELIGIBLE_OMITTED')).toBe('Eligible households left out');
    // Single-finding rules keep the rule's own name.
    expect(findingTitle('REGISTERED_ELIGIBLE')).toBeNull();
  });

  it('writes vulnerability flags as words', () => {
    expect(flagText(['mobility_impaired', 'sole_caregiver'])).toBe('mobility impaired, sole caregiver');
    expect(flagText([])).toBe('');
  });
});

describe('plain words for R12 shortfalls and R8 basis risk', () => {
  const rr = (reasonCode: string, detail: string) => ({ reasonCode, detail }) as Parameters<typeof plainRule>[0];
  it('names the dollar shortfall', () => {
    expect(plainRule(rr('ELIGIBLE_OMITTED', '2 eligible household(s) left out of the plan: rcp_03, rcp_05. They would get $160 less in total'))).toBe(
      'The plan leaves out 2 households who should be paid (rcp_03, rcp_05), $160 in total. A person decides.',
    );
    expect(plainRule(rr('TIER_BELOW_BAND', '1 household(s) planned below their band: rcp_04 tier C (band allows A). They would get $80 less in total'))).toBe(
      'The plan pays 1 household less than their tier allows. They would get $80 less in total. A person decides.',
    );
  });
  it('explains a magnitude-only trigger', () => {
    expect(plainRule(rr('TRIGGER_MAGNITUDE_ONLY', 'M7 meets the magnitude bar but PAGER is green; USGS expects little impact, so a person checks'))).toBe(
      'M7 is strong, but USGS expects little impact on people (PAGER green). A person checks before anyone is paid.',
    );
  });
});

describe('agent decision summary and exception requests', () => {
  const cfg = defaultFirewallConfig();
  const recipients = [
    { recipientId: 'rcp_01', town: 'Macaracas', home: { lat: 7.73, lon: -80.55 } },
    { recipientId: 'rcp_05', town: 'Santiago de Veraguas', home: { lat: 8.1, lon: -80.98 } },
    { recipientId: 'rcp_08', town: 'Yaviza', home: { lat: 8.1569, lon: -77.6928 } },
  ];
  const plan = {
    status: 'assessed',
    agent: { reason: null },
    corroboration: { mode: 'emsc' },
    recipients,
    exceptionRequests: [
      { recipientId: 'rcp_01', reason: 'USGS reports 1 death in Macaracas.' },
      { recipientId: 'rcp_99', reason: 'Pay my cousin too.' },
      'not an object',
    ],
    verdict: {
      totalCents: 20000,
      planRules: [rule('R8', 'pass', 'TRIGGER_CORROBORATED', 'M7.7 meets threshold; 2 independent sources agree')],
      items: [
        { recipientId: 'rcp_01', verdict: 'REQUIRE_APPROVAL', distanceKm: 26.4 },
        { recipientId: 'rcp_05', verdict: 'REQUIRE_APPROVAL', distanceKm: 60.2 },
      ],
    },
  };
  const event = { mag: 7.7, epicentre: { lat: 7.35, lon: -80.75 } };

  it("lists each exception with its town, the agent's reason and what to check", () => {
    const items = exceptionItems(plan);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ recipientId: 'rcp_01', town: 'Macaracas', reason: 'USGS reports 1 death in Macaracas.' });
    expect(items[0]!.check).toMatch(/field partner in Macaracas/);
    expect(items[0]!.check).toMatch(/tier amount only/);
    expect(items[1]).toMatchObject({ recipientId: 'rcp_99', town: null });
    expect(items[1]!.check).toMatch(/not enrolled/);
  });

  it('summarises trigger, plan, who was left out and why, and exceptions', () => {
    const rows = agentSummary(plan, event, cfg);
    expect(rows.map((r) => r.label)).toEqual(['Trigger', 'In the plan', 'Left out', 'Exceptions']);
    expect(rows[0]!.text).toBe('Met: M7.7 is over the M6.0 bar, and two independent agencies (USGS and EMSC) confirm it.');
    expect(rows[1]!.text).toBe('2 of 3 enrolled households, $200.');
    expect(rows[2]!.text).toMatch(/^1 household: Yaviza \(\d+ km\), beyond the 300 km payout limit\.$/);
    expect(rows[3]!.text).toBe('2 households for a person to check: Macaracas, rcp_99.');
  });

  it('names an eligible household the agent left out', () => {
    const omitted = {
      ...plan,
      exceptionRequests: [],
      recipients: recipients.slice(0, 2),
      verdict: {
        ...plan.verdict,
        planRules: [...plan.verdict.planRules, rule('R12', 'warn', 'ELIGIBLE_OMITTED', '1 eligible household(s) left out of the plan: rcp_05. They would get $80 less in total')],
        items: plan.verdict.items.slice(0, 1),
      },
    };
    const rows = agentSummary(omitted, event, cfg);
    expect(rows[2]!.text).toMatch(/Santiago de Veraguas \(\d+ km\), owed a payment, but the agent left it out/);
    expect(rows[3]!.text).toBe('None asked for.');
  });

  it('scales the outer band with magnitude', () => {
    expect(outerLimitKm(7.7, cfg)).toBe(300);
    expect(outerLimitKm(6.8, cfg)).toBeCloseTo(180);
  });

  it('labels the note by language instead of repeating it', () => {
    expect(noteChip({ amountCents: 12000 }, 'es')).toBe('es, fixed note');
    expect(noteChip({ amountCents: 0 }, 'es')).toBe('en, fixed note');
  });
});
