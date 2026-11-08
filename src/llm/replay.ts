import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, sha256Hex } from '../lib/canonical';
import type { LlmClient, LlmRequest, LlmResponse } from './client';

/**
 * Replay mode (SPEC §9): LLM calls are served from /fixtures/llm, keyed by a
 * hash of the full request (model, system, tools, messages incl. tool results).
 * Any change to the prompt, tools or inputs changes the key, so a stale
 * fixture can never be served for a different question.
 */
export function fixtureKey(req: LlmRequest): string {
  return sha256Hex(canonicalJson(stripUndefined(req)));
}

export class LlmFixtureMissingError extends Error {
  constructor(readonly key: string) {
    super(`no LLM fixture for request ${key.slice(0, 12)}…; record fixtures with a real key (npm run record:fixtures)`);
    this.name = 'LlmFixtureMissingError';
  }
}

type Fixture = { key: string; model: string; recordedAt: string; request: LlmRequest; response: LlmResponse };

export class ReplayLlm implements LlmClient {
  readonly mode = 'replay' as const;
  constructor(private readonly dir = 'fixtures/llm') {}

  async create(req: LlmRequest): Promise<LlmResponse> {
    const key = fixtureKey(req);
    const path = join(this.dir, `${key}.json`);
    if (!existsSync(path)) throw new LlmFixtureMissingError(key);
    const fx = JSON.parse(readFileSync(path, 'utf8')) as Fixture;
    return fx.response;
  }
}

/**
 * Wraps a live client and saves every request/response pair as a fixture.
 *
 * An identical request that is already recorded is served from the fixture,
 * never re-asked: different runs often share a prefix (e.g. the first turn
 * before any untrusted text is read), and overwriting it with a fresh,
 * different answer would orphan every later turn recorded on top of it.
 */
export class RecordingLlm implements LlmClient {
  readonly mode = 'record' as const;
  constructor(
    private readonly inner: LlmClient,
    private readonly dir = 'fixtures/llm',
    private readonly clock: () => number = Date.now,
  ) {}

  async create(req: LlmRequest): Promise<LlmResponse> {
    const key = fixtureKey(req);
    const existing = join(this.dir, `${key}.json`);
    if (existsSync(existing)) return (JSON.parse(readFileSync(existing, 'utf8')) as Fixture).response;
    const response = await this.inner.create(req);
    mkdirSync(this.dir, { recursive: true });
    const fx: Fixture = { key, model: req.model, recordedAt: new Date(this.clock()).toISOString(), request: req, response };
    writeFileSync(join(this.dir, `${key}.json`), JSON.stringify(fx, null, 2) + '\n');
    return response;
  }
}

function stripUndefined(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v)) as unknown;
}
