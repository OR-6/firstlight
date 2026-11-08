/**
 * Standalone check of Firstlight's audit hash chain, written from the
 * algorithm published in the manifest (receiptFormat.auditChain), not from
 * the server code: nothing here imports from src/. A donor agent can run this
 * against GET /api/audit instead of trusting GET /api/audit/verify.
 *
 *   hash = sha256_hex(prevHash + canonicalJson({ seq, ts, type, payload }))
 *   prevHash of seq 1 = 64 zeros
 */
import { createHash } from 'node:crypto';

export type PublicAuditEntry = { seq: number; tsMs: number; type: string; payload: unknown; prevHash: string; hash: string };

export const GENESIS = '0'.repeat(64);

/** Keys sorted (JS default order), no whitespace, undefined-valued keys left out. */
export function canonical(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) throw new TypeError('non-finite number in payload');
  return JSON.stringify(v);
}

export function hashOf(prevHash: string, e: { seq: number; tsMs: number; type: string; payload: unknown }): string {
  return createHash('sha256')
    .update(prevHash + canonical({ seq: e.seq, ts: e.tsMs, type: e.type, payload: e.payload }), 'utf8')
    .digest('hex');
}

export type ChainResult =
  | { ok: true; checked: number; fromGenesis: boolean; target: { seq: number; hash: string } }
  | { ok: false; checked: number; reason: string };

/**
 * Recompute the chain in seq order up to `targetHash`. If the entries don't
 * start at seq 1 (the log is longer than one page), the oldest entry's
 * prevHash is taken as the anchor and `fromGenesis` is false.
 */
export function verifyChain(entries: readonly PublicAuditEntry[], targetHash: string): ChainResult {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  const first = sorted[0];
  if (!first) return { ok: false, checked: 0, reason: 'no audit entries' };
  const fromGenesis = first.seq === 1;
  let prev = fromGenesis ? GENESIS : first.prevHash;
  let expectedSeq = first.seq;
  let checked = 0;
  for (const e of sorted) {
    if (e.seq !== expectedSeq) return { ok: false, checked, reason: `gap: expected seq ${expectedSeq}, got ${e.seq}` };
    if (e.prevHash !== prev) return { ok: false, checked, reason: `seq ${e.seq}: prevHash does not match the previous entry` };
    if (hashOf(prev, e) !== e.hash) return { ok: false, checked, reason: `seq ${e.seq}: hash does not match its contents` };
    checked++;
    if (e.hash === targetHash) return { ok: true, checked, fromGenesis, target: { seq: e.seq, hash: e.hash } };
    prev = e.hash;
    expectedSeq++;
  }
  return { ok: false, checked, reason: 'the receipt hash is not in the entries fetched' };
}
