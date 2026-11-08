import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * recipientId → sandbox PayPal email. The ONLY place payee addresses exist.
 * Imported by the payout executor alone (enforced by tests/isolation.test.ts),
 * so neither the agent nor the firewall can read or influence an address.
 *
 * Source, first match wins:
 *   PAYEES_JSON   env var holding the JSON (for hosting, e.g. Render)
 *   PAYEES_FILE   path to a JSON file (default config/payees.sandbox.json, gitignored)
 * Format: { "rcp_01": "sb-...@personal.example.com", ... }
 */
const PayeeMapSchema = z.record(z.string().regex(/^rcp_[a-z0-9_]{1,40}$/), z.email().max(254));
export type PayeeMap = ReadonlyMap<string, string>;

type Env = Record<string, string | undefined>;

export function parsePayees(raw: unknown, knownIds?: ReadonlySet<string>): PayeeMap {
  const trimmed =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]))
      : raw;
  const obj = PayeeMapSchema.parse(trimmed);
  const seen = new Map<string, string>();
  for (const [id, email] of Object.entries(obj)) {
    if (knownIds && !knownIds.has(id)) throw new Error(`payee map has unknown recipientId ${id}`);
    const norm = email.trim().toLowerCase();
    const clash = [...seen.entries()].find(([, e]) => e === norm);
    if (clash) throw new Error(`payee email reused by ${clash[0]} and ${id}`);
    seen.set(id, norm);
  }
  return seen;
}

export function loadPayees(env: Env = process.env, knownIds?: ReadonlySet<string>): PayeeMap {
  if (env.PAYEES_JSON?.trim()) return parsePayees(JSON.parse(env.PAYEES_JSON), knownIds);
  const path = env.PAYEES_FILE?.trim() || 'config/payees.sandbox.json';
  if (!existsSync(/*turbopackIgnore: true*/ path)) throw new Error(`no payee map: set PAYEES_JSON or create ${path} (see config/payees.sandbox.example.json)`);
  return parsePayees(JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, 'utf8')), knownIds);
}
