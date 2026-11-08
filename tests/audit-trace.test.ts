/**
 * Traceability and tamper evidence on the dashboard: the audit filter
 * (plan, batch, type), each batch's links into it, and the in-browser
 * "tamper with a copy" recompute. None of it writes to the log.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditLog, verifyEntries } from '../src/ledger/audit';
import { openDb } from '../src/ledger/db';
import { auditHref, trailGroups } from '../src/ui/audit-links';
import { GENESIS, defaultTamperSeq, recomputeChain, tamperPayload, tamperWithCopy } from '../src/ui/chain';
import { auditRefs, filterAudit, type BatchRef } from '../src/server/views';
import { GET as getAudit } from '@/app/api/audit/route';
import { POST as assess } from '@/app/api/events/[id]/assess/route';

// ── a log shaped like one real payout: verdict → approval → reserve → PayPal → webhooks → status ──

function payoutLog() {
  let t = 1_000;
  const db = openDb();
  const log = new AuditLog(db, () => (t += 1000));
  log.append('signal.received', { eventId: 'us6000u18k' });
  log.append('firewall.verdict', { planId: 1, eventId: 'us6000u18k', overall: 'REQUIRE_APPROVAL', totalCents: 68_000 });
  log.append('approval.decided', { planId: 1, decision: 'approve' });
  log.append('payout.reserved', { planId: 1, batchId: 1, totalCents: 68_000, items: 7 });
  log.append('paypal.payout.created', { planId: 1, batchId: 1, paypalBatchId: '9GE626X9SA3NE', batchStatus: 'PENDING' });
  log.append('paypal.webhook', { eventId: 'WH-1', eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', payoutBatchId: '9GE626X9SA3NE' });
  log.append('paypal.payout.status', { batchId: 1, paypalBatchId: '9GE626X9SA3NE', batchStatus: 'PROCESSING', changes: [] });
  log.append('paypal.webhook', { eventId: 'WH-2', eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', payoutBatchId: '9GE626X9SA3NE' });
  log.append('paypal.payout.status', { batchId: 1, paypalBatchId: '9GE626X9SA3NE', batchStatus: 'SUCCESS', changes: [] });
  log.append('donation.captured', { receiptId: 'rcpt_0123456789abcdef', amountCents: 500 });
  log.append('firewall.verdict', { planId: 2, eventId: 'us6000u18k', overall: 'BLOCK', totalCents: 0 });
  return log;
}
const BATCHES: BatchRef[] = [{ id: 1, planId: 1, paypalBatchId: '9GE626X9SA3NE' }];
const seqs = (es: { seq: number }[]) => es.map((e) => e.seq);

describe('audit filter', () => {
  const entries = payoutLog().entries();

  it('ties a webhook that names only PayPal’s batch id to our batch and its plan', () => {
    expect(auditRefs(entries[5]!, BATCHES)).toEqual({ planId: 1, batchId: 1, paypalBatchId: '9GE626X9SA3NE' });
    expect(auditRefs(entries[3]!, BATCHES)).toEqual({ planId: 1, batchId: 1, paypalBatchId: '9GE626X9SA3NE' });
    expect(auditRefs(entries[9]!, BATCHES)).toEqual({ planId: null, batchId: null, paypalBatchId: null });
  });

  it('by batch: our id and PayPal’s id give the same trail, reserved → created → webhooks → status', () => {
    const byOurs = filterAudit(entries, BATCHES, { batch: '1' });
    const byPayPal = filterAudit(entries, BATCHES, { batch: '9GE626X9SA3NE' });
    expect(seqs(byOurs)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(seqs(byPayPal)).toEqual(seqs(byOurs));
    expect(byOurs.map((e) => e.type)).toEqual(['payout.reserved', 'paypal.payout.created', 'paypal.webhook', 'paypal.payout.status', 'paypal.webhook', 'paypal.payout.status']);
  });

  it('by plan: the verdict, the decision and every entry of its batch, nothing from another plan', () => {
    expect(seqs(filterAudit(entries, BATCHES, { plan: 1 }))).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(seqs(filterAudit(entries, BATCHES, { plan: 2 }))).toEqual([11]);
  });

  it('by type: exact types, comma lists and prefixes, combined with the other parts', () => {
    expect(seqs(filterAudit(entries, BATCHES, { types: ['paypal.webhook'] }))).toEqual([6, 8]);
    expect(seqs(filterAudit(entries, BATCHES, { types: ['paypal.*'] }))).toEqual([5, 6, 7, 8, 9]);
    expect(seqs(filterAudit(entries, BATCHES, { types: ['firewall.verdict', 'donation.*'] }))).toEqual([2, 10, 11]);
    expect(seqs(filterAudit(entries, BATCHES, { plan: 1, types: ['firewall.verdict'] }))).toEqual([2]);
    expect(seqs(filterAudit(entries, BATCHES, { batch: 'NOPE' }))).toEqual([]);
  });

  it('a batch’s trail on /payouts groups by type and links into the filtered log', () => {
    const trail = filterAudit(entries, BATCHES, { batch: '1' });
    expect(trailGroups(trail).map((g) => `#${g.firstSeq} ${g.label}`)).toEqual(['#4 money reserved', '#5 PayPal accepted the batch', '#6 2 verified webhooks', '#7 2 status updates']);
    expect(auditHref({ batch: '9GE626X9SA3NE', type: 'paypal.webhook' }, 6)).toBe('/audit?batch=9GE626X9SA3NE&type=paypal.webhook#seq-6');
    expect(auditHref({ plan: 1 })).toBe('/audit?plan=1');
    expect(auditHref({})).toBe('/audit');
  });
});

describe('GET /api/audit filters (read-only)', () => {
  beforeAll(() => {
    vi.stubEnv('FIRSTLIGHT_DB', ':memory:');
    vi.stubEnv('DEMO_MODE', 'replay');
    vi.stubEnv('PAYPAL_ENV', '');
    vi.stubEnv('PAYPAL_CLIENT_ID', '');
    vi.stubEnv('PAYPAL_CLIENT_SECRET', '');
    vi.stubEnv('PAYEES_JSON', '');
    vi.stubEnv('PAYEES_FILE', 'config/does-not-exist.json');
  });
  afterAll(() => vi.unstubAllEnvs());
  const get = async (q: string) => {
    const res = await getAudit(new Request(`http://localhost/api/audit${q}`));
    return { status: res.status, body: (await res.json()) as { count: number; matched: number; filter: unknown; entries: { seq: number; type: string; payload: { planId?: number } }[]; error?: string } };
  };

  it('filters by type and plan, keeps the whole-log count, and writes nothing', async () => {
    const res = await assess(new Request('http://localhost/x', { method: 'POST', body: '{"redteam":false}', headers: { 'Content-Type': 'application/json' } }), { params: Promise.resolve({ id: 'us6000u18k' }) });
    expect(res.status).toBe(200);
    const planId = ((await res.json()) as { id: number }).id;
    const all = await get('');
    expect(all.body.filter).toBeNull();
    const verdicts = await get('?type=firewall.verdict');
    expect(verdicts.status).toBe(200);
    expect(verdicts.body.entries.map((e) => e.type)).toEqual(['firewall.verdict']);
    expect(verdicts.body).toMatchObject({ count: all.body.count, matched: 1, filter: { plan: null, batch: null, types: ['firewall.verdict'] } });
    const plan = await get(`?plan=${planId}`);
    expect(plan.body.entries.length).toBeGreaterThan(0);
    expect(plan.body.entries.every((e) => e.payload.planId === planId)).toBe(true);
    expect((await get('?plan=999')).body.entries).toEqual([]);
    // Blank form fields mean "no filter"; the log did not grow from reading it.
    const blank = await get('?plan=&batch=&type=');
    expect(blank.body.filter).toBeNull();
    expect(blank.body.count).toBe(all.body.count);
  });

  it('refuses malformed filters with 422', async () => {
    for (const q of ['?plan=abc', '?plan=0', '?batch=a%20b', '?type=DROP%20TABLE', '?type=paypal.*.*']) {
      const r = await get(q);
      expect({ q, status: r.status, error: r.body.error }).toEqual({ q, status: 422, error: 'INVALID_REQUEST' });
    }
  });
});

describe('tamper with a copy (browser recompute)', () => {
  it('recomputes the real chain exactly as the server does', async () => {
    const entries = payoutLog().entries();
    expect(verifyEntries(entries).ok).toBe(true);
    const r = await recomputeChain(entries);
    expect(r).toMatchObject({ ok: true, checked: entries.length, fromGenesis: true, headHash: entries.at(-1)!.hash });
    // Newest-first input (as GET /api/audit returns it) is sorted first.
    expect((await recomputeChain([...entries].reverse())).ok).toBe(true);
    // A later page anchors at its oldest entry's prevHash.
    expect(await recomputeChain(entries.slice(4))).toMatchObject({ ok: true, fromGenesis: false });
    expect(GENESIS).toBe(entries[0]!.prevHash);
  });

  it('editing one payload in the copy is caught at that entry; re-hashing it moves the break to the next one', async () => {
    const entries = payoutLog().entries();
    const before = JSON.stringify(entries);
    const seq = defaultTamperSeq(entries)!;
    expect(seq).toBe(4); // the first money step: payout.reserved
    const r = (await tamperWithCopy(entries, seq))!;
    expect(r.what).toBe('totalCents 68000 → 168000 (an extra $1,000)');
    expect(r.payloadOnly).toMatchObject({ ok: false, brokenAtSeq: 4, why: 'hash', checked: 3 });
    expect(r.rehashed).toMatchObject({ ok: false, brokenAtSeq: 5, why: 'link' });
    // The server's own check agrees on where it breaks.
    const edited = structuredClone(entries);
    edited[3]!.payload = { ...(edited[3]!.payload as object), totalCents: 168_000 };
    expect(verifyEntries(edited)).toMatchObject({ ok: false, brokenAtSeq: 4 });
    // The input was a copy: nothing changed.
    expect(JSON.stringify(entries)).toBe(before);
    expect(verifyEntries(entries).ok).toBe(true);
  });

  it('re-hashing the newest entry passes the recompute, which the page explains with the published head hash', async () => {
    const entries = payoutLog().entries();
    const r = (await tamperWithCopy(entries, entries.at(-1)!.seq))!;
    expect(r.payloadOnly).toMatchObject({ ok: false, brokenAtSeq: entries.at(-1)!.seq });
    expect(r.rehashed.ok).toBe(true);
    expect(r.rehashed.ok && r.rehashed.headHash).not.toBe(entries.at(-1)!.hash);
  });

  it('the edit is the one an insider would want, and an unknown entry is refused', async () => {
    expect(tamperPayload({ overall: 'BLOCK' }).what).toBe('overall BLOCK → ALLOW');
    expect(tamperPayload({ decision: 'deny' }).what).toBe('decision deny → approve');
    expect(tamperPayload({ eventId: 'x' })).toEqual({ payload: { eventId: 'x', edited: true }, what: 'added "edited": true' });
    expect(await tamperWithCopy(payoutLog().entries(), 999)).toBeNull();
  });
});
