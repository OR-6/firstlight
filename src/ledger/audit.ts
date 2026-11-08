import { canonicalJson, sha256Hex } from '../lib/canonical';
import type { Db } from './db';

export const GENESIS_HASH = '0'.repeat(64);

export type AuditEntry = {
  seq: number;
  tsMs: number;
  type: string;
  payload: unknown;
  prevHash: string;
  hash: string;
};

export type ChainCheck =
  | { ok: true; count: number; headHash: string }
  | { ok: false; count: number; brokenAtSeq: number; reason: string };

// Pure chain functions ----------------------------------------------------------

/** hash = sha256(prevHash + canonicalJson({seq, ts, type, payload})). */
export function entryHash(prevHash: string, e: { seq: number; tsMs: number; type: string; payload: unknown }): string {
  return sha256Hex(prevHash + canonicalJson({ seq: e.seq, ts: e.tsMs, type: e.type, payload: e.payload }));
}

/** Recompute the chain. Detects edited payloads, reordering, gaps and splices. */
export function verifyEntries(entries: readonly AuditEntry[], upToHash?: string): ChainCheck {
  let prev = GENESIS_HASH;
  let count = 0;
  for (const [i, e] of entries.entries()) {
    if (e.seq !== i + 1) return { ok: false, count, brokenAtSeq: e.seq, reason: `expected seq ${i + 1}` };
    if (e.prevHash !== prev) return { ok: false, count, brokenAtSeq: e.seq, reason: 'prevHash does not match previous entry' };
    if (entryHash(prev, e) !== e.hash) return { ok: false, count, brokenAtSeq: e.seq, reason: 'hash does not match contents' };
    prev = e.hash;
    count++;
    if (upToHash && e.hash === upToHash) return { ok: true, count, headHash: e.hash };
  }
  if (upToHash) return { ok: false, count, brokenAtSeq: -1, reason: 'hash not found in chain' };
  return { ok: true, count, headHash: prev };
}

const SECRET_KEY = /secret|token|password|authorization|api[-_]?key|client[-_]?id|cookie/i;

/** Replace values of secret-looking keys before anything is logged. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redactSecrets(v);
    return out;
  }
  return value;
}

// SQLite-backed log -------------------------------------------------------------

export class AuditLog {
  constructor(
    private readonly db: Db,
    private readonly clock: () => number = Date.now,
    /** Called after each committed append (live dashboard updates). Errors are swallowed. */
    private readonly onAppend?: (entry: AuditEntry) => void,
  ) {}

  /** Append one entry. Serialised in a transaction so concurrent appends can't fork the chain. */
  append(type: string, payload: unknown): AuditEntry {
    const clean = redactSecrets(payload);
    const tx = this.db.transaction((): AuditEntry => {
      const head = this.db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as
        | { seq: number; hash: string }
        | undefined;
      const seq = (head?.seq ?? 0) + 1;
      const prevHash = head?.hash ?? GENESIS_HASH;
      const tsMs = this.clock();
      const hash = entryHash(prevHash, { seq, tsMs, type, payload: clean });
      this.db
        .prepare('INSERT INTO audit_log (seq, ts_ms, type, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)')
        .run(seq, tsMs, type, canonicalJson(clean), prevHash, hash);
      return { seq, tsMs, type, payload: clean, prevHash, hash };
    });
    const entry = tx.immediate();
    try {
      this.onAppend?.(entry);
    } catch {
      /* listeners must never break the audit path */
    }
    return entry;
  }

  entries(): AuditEntry[] {
    const rows = this.db.prepare('SELECT seq, ts_ms, type, payload, prev_hash, hash FROM audit_log ORDER BY seq').all() as {
      seq: number;
      ts_ms: number;
      type: string;
      payload: string;
      prev_hash: string;
      hash: string;
    }[];
    return rows.map((r) => ({
      seq: r.seq,
      tsMs: r.ts_ms,
      type: r.type,
      payload: JSON.parse(r.payload) as unknown,
      prevHash: r.prev_hash,
      hash: r.hash,
    }));
  }

  head(): string {
    const row = this.db.prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined;
    return row?.hash ?? GENESIS_HASH;
  }

  verify(upToHash?: string): ChainCheck {
    return verifyEntries(this.entries(), upToHash);
  }

  /** R11 support: the executor refuses verdicts that were never logged. */
  hasVerdict(digest: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM audit_log WHERE type = 'firewall.verdict' AND json_extract(payload, '$.digest') = ? LIMIT 1")
      .get(digest);
    return row !== undefined;
  }
}
