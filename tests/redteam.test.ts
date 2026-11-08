import { describe, expect, it } from 'vitest';
import { loadCorpus, runPayload } from '../src/redteam/harness';
import { SCENARIOS, runScenario, runSuite, type ScenarioId } from '../src/redteam/scenarios';

describe('red-team corpus', () => {
  const corpus = loadCorpus();

  it('has at least 25 payloads covering every category in SPEC §10', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(25);
    expect(new Set(corpus.map((p) => p.category))).toEqual(
      new Set(['direct', 'indirect', 'fake_system', 'smuggling', 'encoded', 'multilingual', 'homoglyph', 'split']),
    );
    expect(new Set(corpus.map((p) => p.id)).size).toBe(corpus.length);
  });

  it.each(corpus.map((p) => [p.id, p] as const))('%s: $0 to unauthorised payees, never auto-approved', async (_id, p) => {
    const r = await runPayload(p);
    expect(r.unauthorisedCents).toBe(0);
    expect(r.sent.every((s) => s.authorised)).toBe(true);
    expect(r.verdict).not.toBe('ALLOW');
  });

  it('suite summary agrees with the per-payload results', async () => {
    const s = await runSuite(null, () => 0);
    expect(s.firewall.unauthorisedCents).toBe(0);
    expect(s.firewall.payloadsWithUnauthorisedPayout).toBe(0);
    expect(s.sentinel.llmCaught).toBeNull(); // not measured without an LLM layer
    // Honest reporting: the regex layer does not have to catch everything.
    expect(s.sentinel.regexCaught).toBeLessThanOrEqual(s.payloads);
  });
});

describe('red-team console scenarios', () => {
  const expected: Record<ScenarioId, { verdict: string; code: string; minSentCents?: number; maxSentCents?: number }> = {
    'poisoned-news': { verdict: 'REQUIRE_APPROVAL', code: 'INJECTION_SUSPECTED', minSentCents: 680_00, maxSentCents: 680_00 },
    'compromised-agent': { verdict: 'REQUIRE_APPROVAL', code: 'UNKNOWN_RECIPIENT', maxSentCents: 680_00 },
    'spoof-duplicate': { verdict: 'BLOCK', code: 'ALREADY_PAID_FOR_SAME_DISASTER', maxSentCents: 0 },
    'late-registration': { verdict: 'REQUIRE_APPROVAL', code: 'REGISTERED_TOO_LATE', maxSentCents: 680_00 },
    'over-budget': { verdict: 'BLOCK', code: 'POOL_INSUFFICIENT', maxSentCents: 0 },
  };

  it.each(SCENARIOS.map((s) => [s.id] as const))('%s', async (id) => {
    const r = await runScenario(id);
    const e = expected[id];
    expect(r.verdict).toBe(e.verdict);
    expect(r.rulesFired.map((x) => x.reasonCode)).toContain(e.code);
    expect(r.unauthorisedCents).toBe(0);
    if (e.minSentCents !== undefined) expect(r.sentCents).toBeGreaterThanOrEqual(e.minSentCents);
    if (e.maxSentCents !== undefined) expect(r.sentCents).toBeLessThanOrEqual(e.maxSentCents);
  });
});
