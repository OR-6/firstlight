import { describe, expect, it } from 'vitest';
import type { EventView, PlanView } from '../src/server/views';
import { auditLink, buildStops, currentStage, pacedStops, type Stop } from '../src/ui/MoneyPath';
import { decisionBarText, ghostPlanCaption, householdsWithin, menuButtonLabel, suiteHeadline } from '../src/ui/plain';

const stop = (name: string, state: Stop['state'], extra: Partial<Stop> = {}): Stop => ({ name, state, headline: `${name} headline`, detail: '', ...extra });

const items = (n: number, blocked = 0) => [
  ...Array.from({ length: n }, () => ({ verdict: 'REQUIRE_APPROVAL' })),
  ...Array.from({ length: blocked }, () => ({ verdict: 'BLOCK' })),
];

describe("money's-path board", () => {
  it('labels audit links "See in audit" and keeps the entry number in the tooltip', () => {
    const a = auditLink(stop('Firewall', 'done', { seq: 4, hash: 'abc123' }));
    expect(a).toEqual({ href: '/audit#seq-4', label: 'See in audit', title: 'Audit entry 4, hash abc123', ariaLabel: 'See in audit: Firewall, entry 4' });
    expect(auditLink(stop('Agent', 'done'))).toBeNull();
  });

  it('names the stage a person can act on in the phone summary, ahead of an earlier warning', () => {
    const stops = [
      stop('Signal', 'done'),
      stop('Sentinel', 'wait'),
      stop('Agent', 'done'),
      stop('Firewall', 'wait'),
      stop('Approval', 'wait', { decide: true }),
      stop('PayPal', 'idle'),
      stop('Recipients', 'idle'),
    ];
    expect(currentStage(stops)).toBe('Stage 5 of 7: waiting for a person');
  });

  it('falls back to the first stage not done, and says when all are done', () => {
    expect(currentStage([stop('Signal', 'done'), stop('Firewall', 'stop', { headline: 'Blocked' })])).toBe('Stage 2 of 2: Firewall, blocked');
    expect(currentStage([stop('Signal', 'info'), stop('Agent', 'done')])).toBe('All 2 stages done');
  });

  it('marks an allowed plan that has not been sent as ready for a person to send', () => {
    const plan = {
      status: 'verdict',
      decision: 'trigger',
      sentinel: { injectionSuspected: false, findings: [] },
      agent: { reason: null },
      verdict: { overall: 'ALLOW', totalCents: 12000, items: [{ verdict: 'ALLOW' }] },
      approval: null,
      batch: null,
      trail: [],
      corroboration: { mode: 'emsc' },
    } as unknown as PlanView;
    const event = { mag: 7.7, alert: 'orange', corroboration: { mode: 'emsc' } } as unknown as EventView;
    const stops = buildStops(event, plan);
    expect(stops[5]).toMatchObject({ name: 'PayPal', state: 'wait', headline: 'Ready to send', decide: true });
    expect(currentStage(stops)).toBe('Stage 6 of 7: ready for a person to send');
  });

  it('paces stages for recordings: later stages read "Not run" until revealed', () => {
    const stops = [stop('Signal', 'done'), stop('Sentinel', 'done'), stop('Agent', 'wait')];
    expect(pacedStops(stops, null)).toBe(stops);
    expect(pacedStops(stops, 3)).toBe(stops);
    const paced = pacedStops(stops, 1);
    expect(paced[0]).toBe(stops[0]);
    expect(paced.slice(1)).toEqual([
      { name: 'Sentinel', state: 'idle', headline: 'Not run', detail: '' },
      { name: 'Agent', state: 'idle', headline: 'Not run', detail: '' },
    ]);
  });
});

describe('mobile cues', () => {
  it('puts pending approvals in the menu button name', () => {
    expect(menuButtonLabel(false, 0)).toBe('Menu');
    expect(menuButtonLabel(false, 1)).toBe('Menu, 1 approval waiting');
    expect(menuButtonLabel(false, 3)).toBe('Menu, 3 approvals waiting');
    expect(menuButtonLabel(true, 3)).toBe('Close menu');
  });

  it('words the sticky decision bar without middle dots', () => {
    const waiting = { verdict: { overall: 'REQUIRE_APPROVAL', totalCents: 68000, items: items(7, 1) }, approval: null, batch: null };
    expect(decisionBarText(waiting)).toBe('$680 to 7 households, needs a person');
    expect(decisionBarText({ ...waiting, approval: { decision: 'approve' } })).toBe('$680 to 7 households, ready to send');
    expect(decisionBarText({ ...waiting, approval: { decision: 'deny' } })).toBeNull();
    expect(decisionBarText({ ...waiting, batch: { id: 1 } })).toBeNull();
    expect(decisionBarText({ verdict: { overall: 'BLOCK', totalCents: 0, items: items(0, 2) }, approval: null, batch: null })).toBeNull();
    expect(decisionBarText(waiting)).not.toContain('·');
  });
});

describe('empty plan table', () => {
  it('counts enrolled households inside the outer band', () => {
    const epicentre = { lat: 8.5, lon: -80.5 };
    const homes = [
      { home: { lat: 8.5, lon: -80.4 } }, // ~11 km
      { home: { lat: 9.5, lon: -80.5 } }, // ~111 km
      { home: { lat: 11.0, lon: -80.5 } }, // ~278 km
      { home: { lat: 12.0, lon: -80.5 } }, // ~389 km
    ];
    expect(householdsWithin(homes, epicentre, 300)).toBe(3);
    expect(ghostPlanCaption(3, 300)).toBe("3 enrolled households within 300 km will appear here, with the firewall's check for each.");
    expect(ghostPlanCaption(1, 300)).toMatch(/^1 enrolled household within/);
  });
});

describe('red-team headline', () => {
  it('says $0 when no attack paid anyone not owed', () => {
    expect(suiteHeadline({ payloads: 27, firewall: { unauthorisedCents: 0, payloadsWithUnauthorisedPayout: 0 } })).toBe('27 of 27 attacks stopped: $0 reached anyone not owed');
    expect(suiteHeadline({ payloads: 27, firewall: { unauthorisedCents: 12000, payloadsWithUnauthorisedPayout: 1 } })).toBe('1 of 27 attacks paid someone not owed: $120 in total');
  });

  it('uses the words of the Firewall column', () => {
    const results = (held: number, blocked: number) => [...Array.from({ length: held }, () => ({ verdict: 'REQUIRE_APPROVAL' })), ...Array.from({ length: blocked }, () => ({ verdict: 'BLOCK' }))];
    const clean = { unauthorisedCents: 0, payloadsWithUnauthorisedPayout: 0 };
    expect(suiteHeadline({ payloads: 27, firewall: clean, results: results(27, 0) })).toBe('27 of 27 held for a person: $0 reached anyone not owed');
    expect(suiteHeadline({ payloads: 27, firewall: clean, results: results(26, 1) })).toBe('26 of 27 held for a person, 1 blocked: $0 reached anyone not owed');
    expect(suiteHeadline({ payloads: 3, firewall: clean, results: results(0, 3) })).toBe('3 of 3 blocked: $0 reached anyone not owed');
  });
});
