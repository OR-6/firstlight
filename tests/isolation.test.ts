import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Capability boundaries, enforced on imports:
 *  - the agent (and the LLM layer) can't reach payee emails, PayPal, the ledger or secrets;
 *  - payee emails are imported only by the pipeline's executor;
 *  - only src/paypal reads PayPal credentials.
 */
const SRC = join(import.meta.dirname, '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}
const rel = (p: string) => p.slice(SRC.length + 1);
const all = files(SRC).map((p) => ({ path: rel(p), code: readFileSync(p, 'utf8') }));

describe('module isolation', () => {
  it.each([
    ['agent/', /from ['"]\.\.\/(paypal|ledger|pipeline)\b|registry\/payees|process\.env|PAYPAL_/],
    ['llm/', /from ['"]\.\.\/(paypal|ledger|pipeline|registry|agent)\b/],
    ['signals/', /from ['"]\.\.\/(paypal|agent|pipeline)\b|registry\/payees/],
  ])('%s cannot reach payees, PayPal or the ledger', (dir, forbidden) => {
    const offenders = all.filter((f) => f.path.startsWith(dir) && forbidden.test(f.code)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('only the executor wiring imports the payee map', () => {
    const importers = all.filter((f) => /from ['"][./]*\/?registry\/payees['"]|from ['"]\.\/payees['"]/.test(f.code)).map((f) => f.path).sort();
    // pipeline: executor (type only); server/runtime: loads the real map for execute;
    // redteam/harness: builds synthetic harness addresses for the isolated simulation.
    expect(importers).toEqual(['pipeline/pipeline.ts', 'redteam/harness.ts', 'server/runtime.ts']);
    const pipeline = all.find((f) => f.path === 'pipeline/pipeline.ts')!.code;
    expect(pipeline).toMatch(/import type \{ PayeeMap \}/);
  });

  it('only src/paypal reads PayPal credentials', () => {
    const offenders = all.filter((f) => /PAYPAL_CLIENT_(ID|SECRET)/.test(f.code) && !f.path.startsWith('paypal/')).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
