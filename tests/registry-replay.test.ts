import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultFirewallConfig } from '../src/firewall/config';
import { distanceKm } from '../src/firewall/geo';
import { maxAllowedTier } from '../src/firewall/tiers';
import { LlmFixtureMissingError, RecordingLlm, ReplayLlm, fixtureKey } from '../src/llm/replay';
import { ScriptedLlm, text } from '../src/llm/scripted';
import { parsePayees } from '../src/registry/payees';
import { loadRegistry, parseRegistry } from '../src/registry/registry';
import seed from '../src/registry/registry.seed.json' with { type: 'json' };
import { corroborationFrom, usgsReviewedFallback } from '../src/signals/corroboration';
import { loadReplayEvent } from '../src/signals/replay';

describe('registry', () => {
  it('seed is valid, synthetic, and has no contact details', () => {
    const r = loadRegistry();
    expect(r).toHaveLength(8);
    expect(JSON.stringify(seed)).not.toMatch(/@/);
  });

  it('every registration is > 72 h before the replay event', () => {
    const eventTime = loadReplayEvent('us6000u18k').event.time;
    for (const r of loadRegistry()) expect(Date.parse(r.registeredAt)).toBeLessThan(eventTime - 72 * 3_600_000);
  });

  it('demo geometry: tiers the firewall will allow for the Panama event', () => {
    const e = loadReplayEvent('us6000u18k').event;
    const tiers = loadRegistry().map((r) => [r.recipientId, maxAllowedTier(distanceKm(e.epicentre, r.home), r.flags, defaultFirewallConfig())]);
    expect(tiers).toEqual([
      ['rcp_01', 'A'],
      ['rcp_02', 'A'],
      ['rcp_03', 'B'],
      ['rcp_04', 'A'], // band B + mobility_impaired
      ['rcp_05', 'B'],
      ['rcp_06', 'A'], // band B + elderly_living_alone
      ['rcp_07', 'C'],
      ['rcp_08', null], // outside radius
    ]);
  });

  it.each([
    ['duplicate id', { recipients: [seed.recipients[0], seed.recipients[0]] }, /duplicate/],
    ['email field smuggled into a profile', { recipients: [{ ...seed.recipients[0], email: 'x@y.z' }] }, /Unrecognized|unrecognized/],
    ['bad id', { recipients: [{ ...seed.recipients[0], recipientId: 'attacker@x' }] }, /Invalid|invalid/],
  ])('rejects %s', (_n, raw, msg) => {
    expect(() => parseRegistry(raw)).toThrow(msg);
  });
});

describe('payee map', () => {
  const ids = new Set(['rcp_01', 'rcp_02']);
  it('normalises and validates', () => {
    expect([...parsePayees({ rcp_01: ' A@Example.com ' }, ids)]).toEqual([['rcp_01', 'a@example.com']]);
  });
  it.each([
    ['unknown recipient', { rcp_99: 'a@example.com' }, /unknown recipientId/],
    ['shared address', { rcp_01: 'a@example.com', rcp_02: 'A@example.com' }, /reused/],
    ['not an email', { rcp_01: 'nope' }, /email/i],
  ])('rejects %s', (_n, raw, msg) => {
    expect(() => parsePayees(raw, ids)).toThrow(msg);
  });
});

describe('corroboration', () => {
  it('uses EMSC when it has a match', () => {
    expect(loadReplayEvent('us6000u18k').corroboration.mode).toBe('emsc');
  });
  it('falls back to USGS reviewed + PAGER, marked not independent', () => {
    const e = loadReplayEvent('us6000u18k').event;
    const r = corroborationFrom(e, { type: 'FeatureCollection', features: [] });
    expect(r.mode).toBe('fallback');
    expect(r.observations[0]?.independent).toBe(false);
    expect(usgsReviewedFallback({ ...e, status: 'automatic' }).mode).toBe('none');
  });
});

describe('LLM replay fixtures', () => {
  const req = { model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user' as const, content: 'hi' }] };

  it('key is stable across key order and changes with content', () => {
    expect(fixtureKey(req)).toBe(fixtureKey({ messages: req.messages, max_tokens: 10, model: 'claude-opus-5-5' }));
    expect(fixtureKey({ ...req, messages: [{ role: 'user', content: 'hi!' }] })).not.toBe(fixtureKey(req));
  });

  it('records then replays the same response; unknown requests fail loudly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fl-llm-'));
    const recorded = await new RecordingLlm(new ScriptedLlm(() => [text('hello')]), dir).create(req);
    expect(readdirSync(dir)).toHaveLength(1);
    expect(await new ReplayLlm(dir).create(req)).toEqual(recorded);
    await expect(new ReplayLlm(dir).create({ ...req, max_tokens: 11 })).rejects.toBeInstanceOf(LlmFixtureMissingError);
  });
});

describe('recording never overwrites an existing fixture', () => {
  it('a second run with a shared first request reuses the recorded answer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fl-llm-'));
    const req = { model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user' as const, content: 'shared prefix' }] };
    const first = await new RecordingLlm(new ScriptedLlm(() => [text('answer A')]), dir).create(req);
    const live = new ScriptedLlm(() => [text('answer B')]);
    const second = await new RecordingLlm(live, dir).create(req);
    expect(second).toEqual(first);
    expect(live.requests).toHaveLength(0); // the live model was not asked again
  });
});
