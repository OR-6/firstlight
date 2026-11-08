import { describe, expect, it } from 'vitest';
import {
  ALLOWANCE_LIMITS,
  checkAllowance,
  committedCents,
  evaluateAllowanceRequest,
  parseAgentDonation,
  type AllowanceState,
} from '../src/donations/allowance';
import { DonationError, hashAllowanceToken } from '../src/donations/service';
import { DNOW, donationSetup } from './helpers/donation-fixture';

const HOUR = 3_600_000;
const TOKEN = `alw_${'A'.repeat(32)}`;

// ── pure: creating an allowance ────────────────────────────────────────────

describe('allowance request (pure)', () => {
  const ok = { label: 'samaritan-agent', cap_usd: 20, expires_in_hours: 24 };
  it.each([
    ['valid', ok, true, null],
    ['$1 cap', { ...ok, cap_usd: 1 }, true, null],
    ['$100 cap', { ...ok, cap_usd: 100 }, true, null],
    ['string cap', { ...ok, cap_usd: '12.50' }, true, null],
    ['$0.99 cap', { ...ok, cap_usd: 0.99 }, false, 'CAP_OUT_OF_RANGE'],
    ['$100.01 cap', { ...ok, cap_usd: 100.01 }, false, 'CAP_OUT_OF_RANGE'],
    ['three decimals', { ...ok, cap_usd: 10.005 }, false, 'AMOUNT_PRECISION'],
    ['1 hour', { ...ok, expires_in_hours: 1 }, true, null],
    ['7 days', { ...ok, expires_in_hours: 168 }, true, null],
    ['0 hours', { ...ok, expires_in_hours: 0 }, false, 'INVALID_REQUEST'],
    ['7 days + 1 hour', { ...ok, expires_in_hours: 169 }, false, 'INVALID_REQUEST'],
    ['fractional hours', { ...ok, expires_in_hours: 1.5 }, false, 'INVALID_REQUEST'],
    ['65-char label', { ...ok, label: 'a'.repeat(65) }, false, 'INVALID_REQUEST'],
    ['markup in label', { ...ok, label: '<b>agent</b>' }, false, 'INVALID_REQUEST'],
    ['empty label', { ...ok, label: '   ' }, false, 'INVALID_REQUEST'],
    ['unknown field', { ...ok, owner_email: 'x@example.com' }, false, 'UNKNOWN_FIELDS'],
    ['missing expiry', { label: 'a', cap_usd: 5 }, false, 'INVALID_REQUEST'],
    ['not an object', 'give me money', false, 'INVALID_REQUEST'],
  ])('%s', (_n, input, pass, code) => {
    const d = evaluateAllowanceRequest(input, { now: DNOW, createdLast10Min: 0 });
    expect(d.ok).toBe(pass);
    if (!d.ok) expect(d.code).toBe(code);
  });

  it('expiry is computed from ctx.now, cap in cents', () => {
    const d = evaluateAllowanceRequest(ok, { now: DNOW, createdLast10Min: 0 });
    expect(d).toEqual({ ok: true, label: 'samaritan-agent', capCents: 20_00, expiresMs: DNOW + 24 * HOUR });
  });

  it('throttles allowance creation across everyone', () => {
    const d = evaluateAllowanceRequest(ok, { now: DNOW, createdLast10Min: ALLOWANCE_LIMITS.globalPer10Min });
    expect(d).toMatchObject({ ok: false, code: 'GLOBAL_RATE_LIMIT' });
  });
});

// ── pure: the agent's request shape ────────────────────────────────────────

describe('agent donation request (pure)', () => {
  it.each([
    ['valid', { amount_usd: 5, allowance_token: TOKEN }, true, null],
    ['with message and key', { amount_usd: 5, allowance_token: TOKEN, message: 'hi', idempotency_key: 'key-12345678' }, true, null],
    ['no token', { amount_usd: 5 }, false, 'ALLOWANCE_REQUIRED'],
    ['self-asserted donor_ref', { amount_usd: 5, allowance_token: TOKEN, donor_ref: 'someone-famous' }, false, 'UNKNOWN_FIELDS'],
    ['malformed token', { amount_usd: 5, allowance_token: 'alw_short' }, false, 'INVALID_REQUEST'],
    ['token of the wrong kind', { amount_usd: 5, allowance_token: `rcpt_${'a'.repeat(16)}` }, false, 'INVALID_REQUEST'],
    ['short idempotency key', { amount_usd: 5, allowance_token: TOKEN, idempotency_key: 'abc' }, false, 'INVALID_REQUEST'],
    ['not an object', [1, 2], false, 'INVALID_REQUEST'],
  ])('%s', (_n, input, pass, code) => {
    const p = parseAgentDonation(input);
    expect(p.ok).toBe(pass);
    if (!p.ok) expect(p.code).toBe(code);
  });

  it('explains that donor_ref comes from the allowance', () => {
    const p = parseAgentDonation({ amount_usd: 5, allowance_token: TOKEN, donor_ref: 'x' });
    expect(!p.ok && p.message).toMatch(/donor_ref is set from your allowance label/);
  });
});

// ── pure: may this allowance pay this much? ────────────────────────────────

describe('allowance check (pure)', () => {
  const a: AllowanceState = { id: 'alid_0000000000000001', label: 'agent', capCents: 20_00, expiresMs: DNOW + HOUR, revokedMs: null };
  const d = (status: string, amountCents: number) => ({ status, amountCents });

  it.each([
    ['nothing spent yet', a, 20_00, [], true, null],
    ['exactly what is left', a, 5_00, [d('CAPTURED', 15_00)], true, null],
    ['one cent over', a, 5_01, [d('CAPTURED', 15_00)], false, 'ALLOWANCE_EXCEEDED'],
    ['waiting-for-approval counts', a, 10_00, [d('AWAITING_APPROVAL', 15_00)], false, 'ALLOWANCE_EXCEEDED'],
    ['in-flight (CREATING) counts', a, 10_00, [d('CREATING', 15_00)], false, 'ALLOWANCE_EXCEEDED'],
    ['pending at PayPal counts', a, 10_00, [d('PENDING', 15_00)], false, 'ALLOWANCE_EXCEEDED'],
    ['partially refunded counts in full', a, 10_00, [d('PARTIALLY_REFUNDED', 15_00)], false, 'ALLOWANCE_EXCEEDED'],
    ['cancelled does not count', a, 20_00, [d('CANCELED', 15_00)], true, null],
    ['failed does not count', a, 20_00, [d('FAILED', 15_00)], true, null],
    ['denied does not count', a, 20_00, [d('DENIED', 15_00)], true, null],
    ['refunded does not count', a, 20_00, [d('REFUNDED', 15_00)], true, null],
    ['reversed does not count', a, 20_00, [d('REVERSED', 15_00)], true, null],
    ['unknown token', undefined, 1_00, [], false, 'ALLOWANCE_UNKNOWN'],
    ['revoked', { ...a, revokedMs: DNOW - 1 }, 1_00, [], false, 'ALLOWANCE_REVOKED'],
    ['expires exactly now', { ...a, expiresMs: DNOW }, 1_00, [], false, 'ALLOWANCE_EXPIRED'],
    ['expired an hour ago', { ...a, expiresMs: DNOW - HOUR }, 1_00, [], false, 'ALLOWANCE_EXPIRED'],
  ])('%s', (_n, allowance, cents, donations, pass, code) => {
    const r = checkAllowance(allowance, cents, { now: DNOW, donations });
    expect(r.ok).toBe(pass);
    if (!r.ok) expect(r.code).toBe(code);
  });

  it('committedCents sums only the counted statuses', () => {
    expect(committedCents([d('CAPTURED', 5_00), d('AWAITING_APPROVAL', 3_00), d('CANCELED', 50_00), d('REFUNDED', 7_00)])).toBe(8_00);
  });
});

// ── service: allowances end to end ─────────────────────────────────────────

describe('allowances in the donation service', () => {
  it('returns the token once and stores only its sha256; the audit log never sees it', () => {
    const { svc, db, pipeline, allowance } = donationSetup();
    const a = allowance('helper-bot', 20, 24);
    expect(a.allowanceToken).toMatch(/^alw_[A-Za-z0-9_-]{32}$/);
    expect(a).toMatchObject({ label: 'helper-bot', capUsd: '20.00', remainingUsd: '20.00', status: 'active', expiresAt: new Date(DNOW + 24 * HOUR).toISOString() });
    const row = db.prepare('SELECT * FROM allowances WHERE id = ?').get(a.allowanceId) as Record<string, unknown>;
    expect(row.token_hash).toBe(hashAllowanceToken(a.allowanceToken));
    expect(JSON.stringify(row)).not.toContain(a.allowanceToken);
    const log = JSON.stringify(pipeline.audit.entries());
    expect(log).not.toContain(a.allowanceToken);
    expect(log).not.toContain(hashAllowanceToken(a.allowanceToken));
    expect(pipeline.audit.entries().at(-1)).toMatchObject({ type: 'allowance.created', payload: { allowanceId: a.allowanceId, label: 'helper-bot', capCents: 20_00 } });
    expect(svc.allowanceForToken(a.allowanceToken)?.allowanceId).toBe(a.allowanceId);
  });

  it('agent donations need a valid token; donor_ref is the allowance label', async () => {
    const { svc, allowance, pipeline } = donationSetup();
    await expect(svc.create({ amount_usd: 5 }, 'agent')).rejects.toMatchObject({ code: 'ALLOWANCE_REQUIRED', status: 401 });
    await expect(svc.create({ amount_usd: 5, allowance_token: TOKEN }, 'agent')).rejects.toMatchObject({ code: 'ALLOWANCE_UNKNOWN', status: 401 });
    const a = allowance('helper-bot');
    await expect(svc.create({ amount_usd: 5, allowance_token: a.allowanceToken, donor_ref: 'Red Cross' }, 'agent')).rejects.toMatchObject({ code: 'UNKNOWN_FIELDS' });
    const d = await svc.create({ amount_usd: 5, allowance_token: a.allowanceToken }, 'agent');
    expect(svc.get(d.receiptId)).toMatchObject({ donor_ref: 'helper-bot', allowance_id: a.allowanceId, source: 'agent' });
    expect(svc.feed()[0]).toMatchObject({ donorRef: 'helper-bot', source: 'agent' });
    expect(pipeline.audit.entries().at(-1)).toMatchObject({ type: 'donation.created', payload: { allowanceId: a.allowanceId, donorRef: 'helper-bot' } });
    expect(d.allowance).toMatchObject({ remainingUsd: '95.00', committedUsd: '5.00' });
  });

  it('enforces the cap: waiting and received donations count, cancelled ones free the room', async () => {
    const { svc, allowance } = donationSetup();
    const { allowanceToken: t } = allowance('capped', 10);
    const first = await svc.create({ amount_usd: 6, allowance_token: t }, 'agent');
    await expect(svc.create({ amount_usd: 5, allowance_token: t }, 'agent')).rejects.toMatchObject({ code: 'ALLOWANCE_EXCEEDED', status: 403 });
    await svc.capture(first.receiptId);
    await expect(svc.create({ amount_usd: 4.01, allowance_token: t }, 'agent')).rejects.toMatchObject({ code: 'ALLOWANCE_EXCEEDED' });
    const second = await svc.create({ amount_usd: 4, allowance_token: t }, 'agent');
    expect(second.allowance).toMatchObject({ remainingUsd: '0.00', status: 'used_up' });
    expect(svc.cancel(second.receiptId, second.orderId)).toBe(true);
    expect(svc.allowanceForToken(t)).toMatchObject({ remainingUsd: '4.00', status: 'active' });
  });

  it('two concurrent requests cannot both spend the same room', async () => {
    const { svc, allowance } = donationSetup();
    const { allowanceToken: t } = allowance('racer', 10);
    const results = await Promise.allSettled([svc.create({ amount_usd: 6, allowance_token: t }, 'agent'), svc.create({ amount_usd: 6, allowance_token: t }, 'agent')]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('an expired allowance is refused', async () => {
    const { svc, allowance, advance } = donationSetup();
    const { allowanceToken: t } = allowance('short-lived', 20, 1);
    advance(HOUR);
    await expect(svc.create({ amount_usd: 5, allowance_token: t }, 'agent')).rejects.toMatchObject({ code: 'ALLOWANCE_EXPIRED', status: 403 });
    expect(svc.allowanceForToken(t)?.status).toBe('expired');
  });

  it('revoking needs the id and the token, cancels waiting donations, and stops new ones', async () => {
    const { svc, allowance, pipeline } = donationSetup();
    const a = allowance('revocable', 50);
    const other = allowance('someone-else', 50);
    const waiting = await svc.create({ amount_usd: 5, allowance_token: a.allowanceToken }, 'agent');

    // A stranger who saw the id in the public audit log, with no token or the wrong one:
    expect(() => svc.revokeAllowance(a.allowanceId, undefined)).toThrow(DonationError);
    expect(() => svc.revokeAllowance(a.allowanceId, TOKEN)).toThrow(/No allowance with that id and token/);
    expect(() => svc.revokeAllowance(a.allowanceId, other.allowanceToken)).toThrow(/No allowance with that id and token/);
    expect(() => svc.revokeAllowance('alid_ffffffffffffffff', a.allowanceToken)).toThrow(/No allowance with that id and token/);
    expect(svc.allowanceForToken(a.allowanceToken)?.status).toBe('active');

    const v = svc.revokeAllowance(a.allowanceId, a.allowanceToken);
    expect(v).toMatchObject({ status: 'revoked', remainingUsd: '0.00' });
    expect(svc.get(waiting.receiptId)?.status).toBe('CANCELED');
    await expect(svc.capture(waiting.receiptId)).rejects.toMatchObject({ code: 'NOT_CAPTURABLE' });
    await expect(svc.create({ amount_usd: 5, allowance_token: a.allowanceToken }, 'agent')).rejects.toMatchObject({ code: 'ALLOWANCE_REVOKED' });
    const revoked = pipeline.audit.entries().filter((e) => e.type === 'allowance.revoked');
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.payload).toEqual({ allowanceId: a.allowanceId, canceledReceipts: [waiting.receiptId] });
    expect(JSON.stringify(revoked[0])).not.toContain(a.allowanceToken);

    // Revoking twice is harmless and writes nothing more.
    svc.revokeAllowance(a.allowanceId, a.allowanceToken);
    expect(pipeline.audit.entries().filter((e) => e.type === 'allowance.revoked')).toHaveLength(1);
    // The other allowance is untouched.
    expect(svc.allowanceForToken(other.allowanceToken)?.status).toBe('active');
  });

  it('idempotency keys are scoped to the allowance, never leaking another allowance’s receipt', async () => {
    const { svc, allowance, fake } = donationSetup();
    const a = allowance('same-name', 50);
    const b = allowance('same-name', 50);
    const first = await svc.create({ amount_usd: 5, allowance_token: a.allowanceToken, idempotency_key: 'key-12345678' }, 'agent');
    const replay = await svc.create({ amount_usd: 5, allowance_token: a.allowanceToken, idempotency_key: 'key-12345678' }, 'agent');
    expect(replay).toMatchObject({ receiptId: first.receiptId, replayed: true });
    await expect(svc.create({ amount_usd: 5, allowance_token: b.allowanceToken, idempotency_key: 'key-12345678' }, 'agent')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    expect(fake.calls.create).toHaveLength(1);
  });

  it('a replay still returns its receipt after the allowance is used up', async () => {
    const { svc, allowance } = donationSetup();
    const { allowanceToken: t } = allowance('exact', 5);
    const first = await svc.create({ amount_usd: 5, allowance_token: t, idempotency_key: 'key-abcdefgh' }, 'agent');
    const again = await svc.create({ amount_usd: 5, allowance_token: t, idempotency_key: 'key-abcdefgh' }, 'agent');
    expect(again.receiptId).toBe(first.receiptId);
  });

  it('captured donations reference the allowance in the audit log and the receipt', async () => {
    const { svc, allowance, pipeline } = donationSetup();
    const a = allowance('auditable');
    const d = await svc.create({ amount_usd: 7, allowance_token: a.allowanceToken }, 'agent');
    await svc.capture(d.receiptId);
    expect(pipeline.audit.entries().find((e) => e.type === 'donation.captured')?.payload).toMatchObject({ allowanceId: a.allowanceId });
    expect(svc.receipt(d.receiptId)).toMatchObject({ allowanceId: a.allowanceId, donorRef: 'auditable' });
  });

  it('people donating on /donate need no allowance', async () => {
    const { svc } = donationSetup();
    const d = await svc.create({ amount_usd: 10, donor_ref: 'Ana' }, 'human');
    expect(svc.get(d.receiptId)).toMatchObject({ allowance_id: null, donor_ref: 'Ana' });
    expect(d.allowance).toBeUndefined();
  });

  it('allowance refusals are counted, not written to the audit chain', async () => {
    const { svc, pipeline } = donationSetup();
    const before = pipeline.audit.entries().length;
    await expect(svc.create({ amount_usd: 5, allowance_token: TOKEN }, 'agent')).rejects.toBeTruthy();
    expect(pipeline.audit.entries()).toHaveLength(before);
    expect(svc.rejected.ALLOWANCE_UNKNOWN).toBe(1);
  });
});
