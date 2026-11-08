/**
 * The audit hash chain, recomputed in the browser with WebCrypto. Same formula
 * as src/ledger/audit.ts and scripts/verify-chain.ts (the manifest's
 * receiptFormat.auditChain):
 *
 *   hash = sha256_hex(prevHash + canonicalJson({ seq, ts, type, payload }))
 *   prevHash of seq 1 = 64 zeros
 *
 * Nothing here talks to the server: it works on entries already fetched, and
 * the tamper demo edits an in-memory copy only.
 */

export type ChainEntry = { seq: number; tsMs: number; type: string; payload: unknown; prevHash: string; hash: string };

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
  return JSON.stringify(v);
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function entryHash(prevHash: string, e: Pick<ChainEntry, 'seq' | 'tsMs' | 'type' | 'payload'>): Promise<string> {
  return sha256Hex(prevHash + canonical({ seq: e.seq, ts: e.tsMs, type: e.type, payload: e.payload }));
}

export type Recheck =
  | { ok: true; checked: number; fromGenesis: boolean; headHash: string; target: ChainEntry | null }
  | { ok: false; checked: number; fromGenesis: boolean; brokenAtSeq: number; why: 'gap' | 'link' | 'hash' };

/**
 * Recompute the chain in seq order. Anchored at the genesis hash when the
 * entries start at seq 1, otherwise at the oldest entry's prevHash. With
 * `upToHash`, stops there and fails if that hash is never reached.
 */
export async function recomputeChain(entries: readonly ChainEntry[], upToHash?: string): Promise<Recheck> {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  const fromGenesis = sorted[0]?.seq === 1;
  let prev = fromGenesis ? GENESIS : (sorted[0]?.prevHash ?? GENESIS);
  let checked = 0;
  for (const [i, e] of sorted.entries()) {
    if (i > 0 && e.seq !== sorted[i - 1]!.seq + 1) return { ok: false, checked, fromGenesis, brokenAtSeq: e.seq, why: 'gap' };
    if (e.prevHash !== prev) return { ok: false, checked, fromGenesis, brokenAtSeq: e.seq, why: 'link' };
    if ((await entryHash(prev, e)) !== e.hash) return { ok: false, checked, fromGenesis, brokenAtSeq: e.seq, why: 'hash' };
    checked++;
    if (upToHash && e.hash === upToHash) return { ok: true, checked, fromGenesis, headHash: e.hash, target: e };
    prev = e.hash;
  }
  if (upToHash) return { ok: false, checked, fromGenesis, brokenAtSeq: -1, why: 'gap' };
  return { ok: true, checked, fromGenesis, headHash: prev, target: null };
}

/** The entry the demo edits by default: the first money step if there is one, otherwise one in the middle. Never the newest, so a later entry shows the broken link. */
export function defaultTamperSeq(entries: readonly ChainEntry[]): number | null {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  if (sorted.length < 2) return sorted[0]?.seq ?? null;
  const notLast = sorted.slice(0, -1);
  const pick =
    notLast.find((e) => e.type === 'payout.reserved') ??
    notLast.find((e) => e.type === 'firewall.verdict') ??
    notLast.find((e) => e.type === 'donation.captured') ??
    notLast[Math.floor(notLast.length / 2)]!;
  return pick.seq;
}

/** The edit an insider might make: more money, a friendlier verdict, or failing those a changed field. */
export function tamperPayload(payload: unknown): { payload: unknown; what: string } {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? (structuredClone(payload) as Record<string, unknown>) : null;
  if (!p) return { payload: { original: payload ?? null, edited: true }, what: 'wrapped the payload in an edited object' };
  for (const key of ['totalCents', 'amountCents', 'feeCents', 'capCents'] as const) {
    if (typeof p[key] === 'number') {
      const from = p[key] as number;
      p[key] = from + 100_000;
      return { payload: p, what: `${key} ${from} → ${from + 100_000} (an extra $1,000)` };
    }
  }
  if (typeof p.overall === 'string' && p.overall !== 'ALLOW') {
    const from = p.overall;
    p.overall = 'ALLOW';
    return { payload: p, what: `overall ${from} → ALLOW` };
  }
  if (typeof p.decision === 'string' && p.decision !== 'approve') {
    const from = p.decision;
    p.decision = 'approve';
    return { payload: p, what: `decision ${from} → approve` };
  }
  p.edited = true;
  return { payload: p, what: 'added "edited": true' };
}

export type TamperResult = {
  editedSeq: number;
  what: string;
  checked: number;
  fromGenesis: boolean;
  /** Edit the payload only: the entry's stored hash no longer matches its contents. */
  payloadOnly: Recheck;
  /** Edit the payload and re-hash that entry too: the next entry's prevHash no longer links to it. */
  rehashed: Recheck;
};

/**
 * Edit one entry's payload in a deep copy of `entries` and recompute the chain
 * twice: once as is, once with the edited entry re-hashed to cover the edit.
 * The input is never changed.
 */
export async function tamperWithCopy(entries: readonly ChainEntry[], seq: number): Promise<TamperResult | null> {
  const copy = structuredClone([...entries]).sort((a, b) => a.seq - b.seq);
  const i = copy.findIndex((e) => e.seq === seq);
  if (i < 0) return null;
  const { payload, what } = tamperPayload(copy[i]!.payload);
  copy[i] = { ...copy[i]!, payload };
  const payloadOnly = await recomputeChain(copy);
  const rehashedCopy = [...copy];
  rehashedCopy[i] = { ...copy[i]!, hash: await entryHash(copy[i]!.prevHash, copy[i]!) };
  const rehashed = await recomputeChain(rehashedCopy);
  return { editedSeq: seq, what, checked: copy.length, fromGenesis: copy[0]?.seq === 1, payloadOnly, rehashed };
}
