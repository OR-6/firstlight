import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SPEC: the firewall is pure, deterministic code with no I/O and no LLM calls.
 * This test enforces that mechanically so a future change can't quietly add a
 * clock read, a DB query, a network call, or an import from the agent side.
 */
const ROOT = join(import.meta.dirname, '..', 'src', 'firewall');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const FORBIDDEN: [string, RegExp][] = [
  ['clock read', /\bDate\.now\b|new Date\(|performance\.now/],
  ['randomness', /Math\.random|randomUUID|getRandomValues/],
  ['network', /\bfetch\(|XMLHttpRequest|WebSocket/],
  ['environment', /process\.env/],
  ['filesystem / process', /from ['"](node:)?(fs|child_process|net|http|https|dgram|worker_threads)['"]/],
  ['database', /better-sqlite3|from ['"]\.\.\/(\.\.\/)?ledger/],
  ['agent / LLM / PayPal modules', /from ['"](\.\.\/)+(agent|llm|paypal|signals)\b/],
];

describe('firewall purity', () => {
  const sources = files(ROOT);

  it('covers the whole firewall directory', () => {
    expect(sources.length).toBeGreaterThanOrEqual(15);
  });

  it.each(FORBIDDEN)('no %s in src/firewall', (_what, pattern) => {
    const offenders = sources.filter((f) => pattern.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
