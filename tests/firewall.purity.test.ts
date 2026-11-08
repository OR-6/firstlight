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

describe('firewall purity: everything it imports', () => {
  // Every module reachable from src/firewall, followed through relative imports.
  // Outside packages are allowed only from a short list.
  const ALLOWED_PACKAGES = new Set(['zod', 'node:crypto']);
  const SRC = join(import.meta.dirname, '..', 'src');

  function reachable(): { files: string[]; packages: string[] } {
    const seen = new Set<string>();
    const packages = new Set<string>();
    const queue = files(ROOT);
    while (queue.length) {
      const f = queue.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const m of readFileSync(f, 'utf8').matchAll(/(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1]!;
        if (!spec.startsWith('.')) {
          packages.add(spec);
          continue;
        }
        const base = join(f, '..', spec);
        const file = [`${base}.ts`, join(base, 'index.ts')].find((p) => {
          try {
            return statSync(p).isFile();
          } catch {
            return false;
          }
        });
        if (file) queue.push(file);
      }
    }
    return { files: [...seen], packages: [...packages] };
  }

  it('only imports allowed packages, transitively', () => {
    expect(reachable().packages.filter((p) => !ALLOWED_PACKAGES.has(p))).toEqual([]);
  });

  it.each(FORBIDDEN.slice(0, 5))('no %s anywhere the firewall reaches', (_what, pattern) => {
    const outside = reachable().files.filter((f) => !f.startsWith(ROOT));
    expect(outside.every((f) => f.startsWith(SRC))).toBe(true);
    expect(outside.filter((f) => pattern.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
});
