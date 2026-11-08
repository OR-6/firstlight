import { randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalJson, sha256Hex } from '../lib/canonical';
import type { AuditEntry, AuditLog } from '../ledger/audit';
import { instanceId, type Db } from '../ledger/db';
import type { Ledger } from '../ledger/ledger';
import type { DonationOrders } from '../paypal/orders';
import {
  ALLOWANCE_ID_RE,
  ALLOWANCE_TOKEN_RE,
  allowanceStatus,
  checkAllowance,
  committedCents,
  evaluateAllowanceRequest,
  parseAgentDonation,
  type AllowanceState,
} from './allowance';
import { evaluateDonation, type DonationPolicyConfig, type RecentDonation } from './policy';

/**
 * Donations: create a PayPal order, let a HUMAN approve it on PayPal, then
 * capture and credit the internal pool ledger exactly once.
 *
 * A donor agent can only create an order, and only under an allowance a
 * person created for it (a cap and an expiry, enforced here). It can never
 * move anyone's money on its own: the approval happens on PayPal's page, by a
 * person.
 */
export type DonationSource = 'human' | 'agent';

export type DonationRow = {
  id: number;
  receipt_id: string;
  source: DonationSource;
  donor_ref: string;
  message: string | null;
  amount_cents: number;
  idempotency_key: string | null;
  order_id: string | null;
  approval_url: string | null;
  capture_id: string | null;
  status: string;
  created_ms: number;
  captured_ms: number | null;
  allowance_id: string | null;
  refunded_cents: number;
};

export type AllowanceRow = {
  id: string;
  token_hash: string;
  label: string;
  cap_cents: number;
  created_ms: number;
  expires_ms: number;
  revoked_ms: number | null;
};

/** What PayPal told us about a capture (from a verified webhook). */
export type CaptureEvent = { orderId: string | null; captureId: string; reason?: string | null };
/** A refund or reversal of a capture (from a verified webhook). */
export type ReturnEvent = { captureId: string | null; orderId: string | null; refId: string | null; eventId: string; amountCents: number | null };

/** Statuses after the money arrived; a late COMPLETED never overwrites these. */
const AFTER_CAPTURE = ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REVERSED'];
const ALLOWANCE_HTTP: Record<string, number> = {
  ALLOWANCE_REQUIRED: 401,
  ALLOWANCE_UNKNOWN: 401,
  ALLOWANCE_REVOKED: 403,
  ALLOWANCE_EXPIRED: 403,
  ALLOWANCE_EXCEEDED: 403,
};

export const hashAllowanceToken = (token: string) => sha256Hex(token);

/** What a receipt does and does not show (also in the manifest). */
export const RECEIPT_PROVES =
  "This donation is recorded in Firstlight's hash-chained audit log (recompute the chain yourself from /api/audit), and the pool totals are shown. It does not show where each dollar went: the pool is shared, so a donation is not earmarked to any recipient.";

function toState(a: AllowanceRow): AllowanceState {
  return { id: a.id, label: a.label, capCents: a.cap_cents, expiresMs: a.expires_ms, revokedMs: a.revoked_ms };
}

export class DonationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'DonationError';
  }
}

export type AllowanceView = {
  allowanceId: string;
  label: string;
  status: 'active' | 'revoked' | 'expired' | 'used_up';
  capUsd: string;
  committedUsd: string;
  remainingUsd: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

export type CreatedDonation = {
  receiptId: string;
  orderId: string;
  approvalUrl: string;
  amountUsd: string;
  status: string;
  replayed: boolean;
  allowance?: AllowanceView;
};

type Debit = { debited: boolean; shortfallCents: number; balanceBeforeCents: number };

export class DonationService {
  /** Refused donation attempts by rule code, since the server started. */
  readonly rejected: Record<string, number> = {};
  constructor(
    private readonly deps: {
      db: Db;
      audit: AuditLog;
      ledger: Ledger;
      orders: () => DonationOrders;
      baseUrl: () => string;
      clock?: () => number;
      policy?: DonationPolicyConfig;
    },
  ) {}

  private now() {
    return (this.deps.clock ?? Date.now)();
  }

  private recent(): RecentDonation[] {
    const since = this.now() - 24 * 3_600_000;
    return (
      this.deps.db.prepare('SELECT donor_ref, amount_cents, created_ms, status FROM donations WHERE created_ms > ?').all(since) as {
        donor_ref: string;
        amount_cents: number;
        created_ms: number;
        status: string;
      }[]
    ).map((r) => ({ donorRef: r.donor_ref, amountCents: r.amount_cents, at: r.created_ms, status: r.status }));
  }

  get(receiptId: string): DonationRow | undefined {
    return this.deps.db.prepare('SELECT * FROM donations WHERE receipt_id = ?').get(receiptId) as DonationRow | undefined;
  }

  byOrder(orderId: string): DonationRow | undefined {
    return this.deps.db.prepare('SELECT * FROM donations WHERE order_id = ?').get(orderId) as DonationRow | undefined;
  }

  private refuse(code: string, message: string, status: number): never {
    // Counted, not chained: anyone can send invalid bodies, and they must not bury the real story in the audit log.
    this.rejected[code] = (this.rejected[code] ?? 0) + 1;
    throw new DonationError(code, message, status);
  }

  /**
   * Validate, create the PayPal order, return where the human approves it.
   * Agent donations need an allowance token; donor_ref is then the
   * allowance's label and the amount must fit in what is left of it.
   */
  async create(raw: unknown, source: DonationSource): Promise<CreatedDonation> {
    let allowance: AllowanceRow | undefined;
    let input: unknown = raw;
    if (source === 'agent') {
      const p = parseAgentDonation(raw);
      if (!p.ok) this.refuse(p.code, p.message, ALLOWANCE_HTTP[p.code] ?? 400);
      allowance = this.allowanceByToken(p.token);
      if (!allowance) this.refuse('ALLOWANCE_UNKNOWN', 'That allowance_token is not valid. Ask your person for a new one at /agents.', 401);
      input = { ...p.policyInput, donor_ref: allowance.label };
    }

    // Replay of the same idempotency key (same allowance, or same human donor) → same receipt, no new order.
    const pre = input && typeof input === 'object' ? (input as { donor_ref?: unknown; idempotency_key?: unknown }) : {};
    if (typeof pre.donor_ref === 'string' && typeof pre.idempotency_key === 'string') {
      const donorRef = pre.donor_ref.trim();
      const existing = (
        allowance
          ? this.deps.db.prepare('SELECT * FROM donations WHERE allowance_id = ? AND idempotency_key = ?').get(allowance.id, pre.idempotency_key)
          : this.deps.db.prepare('SELECT * FROM donations WHERE donor_ref = ? AND idempotency_key = ? AND allowance_id IS NULL').get(donorRef, pre.idempotency_key)
      ) as DonationRow | undefined;
      if (existing) {
        const asked = Math.round(Number((input as { amount_usd?: unknown }).amount_usd) * 100);
        if (Number.isFinite(asked) && asked !== existing.amount_cents) {
          throw new DonationError('IDEMPOTENCY_MISMATCH', 'That idempotency_key was already used for a different amount. Use a new key.', 409);
        }
        if (existing.order_id && existing.status !== 'FAILED') return this.toCreated(existing, true);
        if (existing.status === 'CREATING') throw new DonationError('IN_PROGRESS', 'This donation is still being created. Try again in a moment.', 409);
        // FAILED before PayPal gave us an order: clear it so the retry can go through.
        if (existing.status === 'FAILED') this.deps.db.prepare("DELETE FROM donations WHERE receipt_id = ? AND status = 'FAILED'").run(existing.receipt_id);
      } else if (this.deps.db.prepare('SELECT 1 FROM donations WHERE donor_ref = ? AND idempotency_key = ?').get(donorRef, pre.idempotency_key)) {
        // Same label and key under another allowance (or a person using an agent's label): never hand over someone else's receipt.
        throw new DonationError('IDEMPOTENCY_CONFLICT', 'That idempotency_key is already in use for this donor name. Use a new key.', 409);
      }
    }

    const now = this.now();
    const decision = evaluateDonation(input, { now, recent: this.recent(), config: this.deps.policy });
    if (!decision.ok) {
      this.refuse(decision.code, decision.message, decision.code.endsWith('RATE_LIMIT') || decision.code === 'CARD_TESTING_PATTERN' ? 429 : 400);
    }
    if (allowance) {
      // No await between this check and the INSERT below, so two concurrent requests can't both spend the same allowance.
      const check = checkAllowance(toState(allowance), decision.amountCents, { now, donations: this.allowanceDonations(allowance.id) });
      if (!check.ok) this.refuse(check.code, check.message, ALLOWANCE_HTTP[check.code] ?? 403);
    }

    const receiptId = `rcpt_${randomBytes(8).toString('hex')}`;
    this.deps.db
      .prepare(
        `INSERT INTO donations (receipt_id, source, donor_ref, message, amount_cents, idempotency_key, status, created_ms, allowance_id)
         VALUES (?, ?, ?, ?, ?, ?, 'CREATING', ?, ?)`,
      )
      .run(receiptId, source, decision.donorRef, decision.message, decision.amountCents, decision.idempotencyKey, now, allowance?.id ?? null);

    const base = this.deps.baseUrl().replace(/\/$/, '');
    const requestId = sha256Hex(canonicalJson({ instance: instanceId(this.deps.db), receiptId, op: 'create' }));
    try {
      const order = await this.deps.orders().create({
        amountCents: decision.amountCents,
        receiptId,
        description: 'Donation to the Firstlight relief pool (sandbox)',
        returnUrl: `${base}/api/donations/return?receipt=${receiptId}`,
        cancelUrl: `${base}/api/donations/cancel?receipt=${receiptId}`,
        requestId,
      });
      // Only CREATING moves on: an allowance revoked meanwhile has already cancelled this row.
      this.deps.db
        .prepare("UPDATE donations SET order_id = ?, approval_url = ?, status = CASE status WHEN 'CREATING' THEN 'AWAITING_APPROVAL' ELSE status END WHERE receipt_id = ?")
        .run(order.orderId, order.approvalUrl, receiptId);
      this.deps.audit.append('donation.created', {
        receiptId,
        source,
        amountCents: decision.amountCents,
        orderId: order.orderId,
        // donor_ref is untrusted text; recorded as data only. For agents it is the allowance label.
        donorRef: decision.donorRef,
        allowanceId: allowance?.id,
      });
      return this.toCreated(this.get(receiptId)!, false);
    } catch (err) {
      this.deps.db.prepare("UPDATE donations SET status = 'FAILED' WHERE receipt_id = ?").run(receiptId);
      this.deps.audit.append('donation.failed', { receiptId, stage: 'create', message: (err as Error).message.slice(0, 200), allowanceId: allowance?.id });
      throw new DonationError('PAYPAL', (err as Error).message, 502);
    }
  }

  /**
   * Capture after the payer approved on PayPal, and credit the pool once.
   * Safe to call repeatedly (return URL, webhooks, retries): the capture uses a
   * fixed PayPal-Request-Id and the ledger credit is unique per capture id.
   */
  async capture(receiptId: string, orderIdFromReturn?: string): Promise<DonationRow> {
    const d = this.get(receiptId);
    if (!d || !d.order_id) throw new DonationError('NOT_FOUND', 'No donation with that receipt.', 404);
    if (orderIdFromReturn && orderIdFromReturn !== d.order_id) throw new DonationError('ORDER_MISMATCH', 'This approval does not belong to that receipt.', 400);
    if (AFTER_CAPTURE.includes(d.status)) return d;
    if (d.status === 'CANCELED' || d.status === 'FAILED' || d.status === 'DENIED') throw new DonationError('NOT_CAPTURABLE', `This donation is ${d.status.toLowerCase()}.`, 409);

    const requestId = sha256Hex(canonicalJson({ instance: instanceId(this.deps.db), receiptId, op: 'capture' }));
    const res = await this.deps.orders().capture(d.order_id, requestId);
    // A capture refunded since still happened: book it, and the refund debits it.
    const captured = res.captureStatus === 'COMPLETED' || res.captureStatus === 'PARTIALLY_REFUNDED' || res.captureStatus === 'REFUNDED';
    if (res.status !== 'COMPLETED' || !captured || !res.captureId) {
      if (res.captureStatus === 'PENDING' && res.captureId) return this.markPending(d, res.captureId, null);
      this.deps.audit.append('donation.capture_pending', { receiptId, orderStatus: res.status, captureStatus: res.captureStatus });
      return this.get(receiptId)!;
    }
    return this.credit(receiptId, res.captureId, res.amountCents ?? d.amount_cents);
  }

  /** Webhook PAYMENT.CAPTURE.COMPLETED (verified upstream). */
  onCaptureCompleted(orderId: string | undefined, captureId: string, amountCents: number | null): DonationRow | null {
    const d = this.findByCapture(captureId, orderId ?? null);
    if (!d) return null;
    return this.credit(d.receipt_id, captureId, amountCents ?? d.amount_cents);
  }

  /** Webhook PAYMENT.CAPTURE.PENDING (verified upstream): record the status, credit nothing. */
  onCapturePending(e: CaptureEvent): DonationRow | null {
    const d = this.findByCapture(e.captureId, e.orderId);
    return d ? this.markPending(d, e.captureId, e.reason ?? null) : null;
  }

  /** PayPal holds the capture (PENDING). Recorded, not credited. */
  private markPending(d: DonationRow, captureId: string, reason: string | null): DonationRow {
    const res = this.deps.db
      .prepare("UPDATE donations SET status = 'PENDING', capture_id = COALESCE(capture_id, ?) WHERE receipt_id = ? AND status IN ('CREATING','AWAITING_APPROVAL')")
      .run(captureId, d.receipt_id);
    if (res.changes) this.deps.audit.append('donation.capture_pending', { receiptId: d.receipt_id, captureId, reason: reason ?? undefined, allowanceId: d.allowance_id ?? undefined });
    return this.get(d.receipt_id)!;
  }

  /**
   * Webhook PAYMENT.CAPTURE.DENIED (verified upstream). A denied capture is
   * never credited; if it somehow was, the credit is reversed.
   */
  onCaptureDenied(e: CaptureEvent): DonationRow | null {
    const d = this.findByCapture(e.captureId, e.orderId);
    if (!d || d.status === 'DENIED') return d ?? null;
    const tx = this.deps.db.transaction(() => {
      const toReverse = this.deps.ledger.donationCreditCents(e.captureId) - d.refunded_cents;
      let reversed: Debit = { debited: false, shortfallCents: 0, balanceBeforeCents: 0 };
      if (toReverse > 0) reversed = this.deps.ledger.debitDonation('donation_reversal', `denied:${e.captureId}`, toReverse);
      const reversedCents = reversed.debited ? toReverse : 0;
      this.deps.db
        .prepare("UPDATE donations SET status = 'DENIED', capture_id = COALESCE(capture_id, ?), refunded_cents = refunded_cents + ? WHERE receipt_id = ?")
        .run(e.captureId, reversedCents, d.receipt_id);
      this.deps.audit.append('donation.denied', {
        receiptId: d.receipt_id,
        captureId: e.captureId,
        allowanceId: d.allowance_id ?? undefined,
        reason: e.reason ?? undefined,
        creditReversedCents: reversedCents,
        ...this.poolFlags(reversed),
      });
    });
    tx.immediate();
    return this.get(d.receipt_id)!;
  }

  /**
   * Webhooks PAYMENT.CAPTURE.REFUNDED / PAYMENT.CAPTURE.REVERSED (verified
   * upstream): the money went back to the donor, so it leaves the pool.
   * Idempotent per PayPal refund/reversal id (else per webhook event id).
   * Never debits more than was credited for the donation; a debit that takes
   * the pool below zero is booked (the money is gone) and flagged in the audit entry.
   */
  onCaptureReturned(kind: 'refund' | 'reversal', e: ReturnEvent): DonationRow | null {
    const d = this.findByCapture(e.captureId, e.orderId);
    if (!d) return null;
    const captureId = e.captureId ?? d.capture_id;
    // A refund proves the capture completed: book the credit first if we never heard about it.
    if (captureId && this.deps.ledger.donationCreditCents(captureId) === 0 && d.status !== 'DENIED') this.credit(d.receipt_id, captureId, d.amount_cents, kind);

    const ledgerKind = kind === 'refund' ? 'donation_refund' : 'donation_reversal';
    const ref = `${kind}:${e.refId ?? `event:${e.eventId}`}`;
    const tx = this.deps.db.transaction(() => {
      if (this.deps.db.prepare('SELECT 1 FROM ledger_entries WHERE kind = ? AND ref = ?').get(ledgerKind, ref)) return; // seen this refund before
      const cur = this.get(d.receipt_id)!;
      const credited = captureId ? this.deps.ledger.donationCreditCents(captureId) : 0;
      const room = Math.max(0, credited - cur.refunded_cents);
      const asked = e.amountCents ?? room;
      const cents = Math.min(asked, room);
      const debit: Debit = cents > 0 ? this.deps.ledger.debitDonation(ledgerKind, ref, cents) : { debited: false, shortfallCents: 0, balanceBeforeCents: 0 };
      const recorded = debit.debited ? cents : 0;
      const total = cur.refunded_cents + recorded;
      const status = total >= cur.amount_cents ? (kind === 'refund' ? 'REFUNDED' : 'REVERSED') : total > 0 ? 'PARTIALLY_REFUNDED' : cur.status;
      this.deps.db.prepare('UPDATE donations SET status = ?, refunded_cents = ? WHERE receipt_id = ?').run(status, total, cur.receipt_id);
      this.deps.audit.append(kind === 'refund' ? 'donation.refunded' : 'donation.reversed', {
        receiptId: cur.receipt_id,
        captureId: captureId ?? undefined,
        paypalRefId: e.refId ?? undefined,
        eventId: e.eventId,
        allowanceId: cur.allowance_id ?? undefined,
        amountCents: recorded,
        totalReturnedCents: total,
        exceedsDonation: asked > room ? { askedCents: asked, recordedCents: recorded } : undefined,
        ...this.poolFlags(debit),
      });
    });
    tx.immediate();
    return this.get(d.receipt_id)!;
  }

  /**
   * Webhook CHECKOUT.ORDER.APPROVED (verified upstream): the donor approved on
   * PayPal but may never come back to the return URL. Capture server-side
   * through the same idempotent path the return route uses.
   */
  async onOrderApproved(orderId: string): Promise<DonationRow | null> {
    const d = this.byOrder(orderId);
    if (!d || d.status !== 'AWAITING_APPROVAL') return d ?? null;
    try {
      return await this.capture(d.receipt_id);
    } catch (err) {
      // Cancelled meanwhile (e.g. its allowance was revoked): nothing to capture, and PayPal needn't retry.
      if (err instanceof DonationError && (err.code === 'NOT_CAPTURABLE' || err.code === 'NOT_FOUND')) return this.get(d.receipt_id) ?? null;
      throw err;
    }
  }

  private findByCapture(captureId: string | null, orderId: string | null): DonationRow | undefined {
    const byCapture = captureId ? (this.deps.db.prepare('SELECT * FROM donations WHERE capture_id = ?').get(captureId) as DonationRow | undefined) : undefined;
    return byCapture ?? (orderId ? this.byOrder(orderId) : undefined);
  }

  private poolFlags(debit: Debit) {
    if (!debit.debited || debit.shortfallCents === 0) return {};
    return { flag: 'POOL_NEGATIVE', poolShortfallCents: debit.shortfallCents, poolBalanceAfterCents: this.deps.ledger.poolBalanceCents() };
  }

  private credit(receiptId: string, captureId: string, capturedCents: number, learnedFrom?: 'refund' | 'reversal'): DonationRow {
    const d = this.get(receiptId)!;
    // Only ever credit what the donor asked for; a mismatch is logged, never trusted upward.
    const cents = Math.min(capturedCents, d.amount_cents);
    const { credited } = this.deps.ledger.creditDonation(captureId, cents);
    if (!AFTER_CAPTURE.includes(d.status)) {
      this.deps.db
        .prepare("UPDATE donations SET status = 'CAPTURED', capture_id = ?, captured_ms = ? WHERE receipt_id = ? AND status NOT IN ('CAPTURED','PARTIALLY_REFUNDED','REFUNDED','REVERSED')")
        .run(captureId, this.now(), receiptId);
    }
    if (credited) {
      this.deps.audit.append('donation.captured', {
        receiptId,
        captureId,
        amountCents: cents,
        allowanceId: d.allowance_id ?? undefined,
        learnedFrom,
        mismatch: capturedCents !== d.amount_cents ? { expected: d.amount_cents, captured: capturedCents } : undefined,
      });
    }
    return this.get(receiptId)!;
  }

  /** Cancel a pending donation. Needs the PayPal order id (PayPal's `token` on the cancel URL). */
  cancel(receiptId: string, orderId: string): boolean {
    const res = this.deps.db
      .prepare("UPDATE donations SET status = 'CANCELED' WHERE receipt_id = ? AND order_id = ? AND status = 'AWAITING_APPROVAL'")
      .run(receiptId, orderId);
    if (res.changes) this.deps.audit.append('donation.canceled', { receiptId });
    return res.changes > 0;
  }

  // ── allowances ─────────────────────────────────────────────────────────────

  private allowanceByToken(token: string): AllowanceRow | undefined {
    if (!ALLOWANCE_TOKEN_RE.test(token)) return undefined;
    return this.deps.db.prepare('SELECT * FROM allowances WHERE token_hash = ?').get(hashAllowanceToken(token)) as AllowanceRow | undefined;
  }

  private allowanceRow(id: string): AllowanceRow | undefined {
    return this.deps.db.prepare('SELECT * FROM allowances WHERE id = ?').get(id) as AllowanceRow | undefined;
  }

  private allowanceDonations(allowanceId: string): { status: string; amountCents: number }[] {
    return (this.deps.db.prepare('SELECT status, amount_cents FROM donations WHERE allowance_id = ?').all(allowanceId) as { status: string; amount_cents: number }[]).map((r) => ({
      status: r.status,
      amountCents: r.amount_cents,
    }));
  }

  private allowanceView(a: AllowanceRow): AllowanceView {
    const committed = committedCents(this.allowanceDonations(a.id));
    const usdOf = (c: number) => (c / 100).toFixed(2);
    const status = allowanceStatus(toState(a), committed, this.now());
    return {
      allowanceId: a.id,
      label: a.label,
      status,
      capUsd: usdOf(a.cap_cents),
      committedUsd: usdOf(committed),
      remainingUsd: status === 'active' ? usdOf(Math.max(0, a.cap_cents - committed)) : '0.00',
      createdAt: new Date(a.created_ms).toISOString(),
      expiresAt: new Date(a.expires_ms).toISOString(),
      revokedAt: a.revoked_ms ? new Date(a.revoked_ms).toISOString() : null,
    };
  }

  /** A person lets one agent donate up to a cap until an expiry. The token is returned once; only its sha256 is stored. */
  createAllowance(raw: unknown): AllowanceView & { allowanceToken: string } {
    const now = this.now();
    const recent = (this.deps.db.prepare('SELECT COUNT(*) AS n FROM allowances WHERE created_ms > ?').get(now - 10 * 60_000) as { n: number }).n;
    const dec = evaluateAllowanceRequest(raw, { now, createdLast10Min: recent });
    if (!dec.ok) this.refuse(dec.code, dec.message, dec.code === 'GLOBAL_RATE_LIMIT' ? 429 : 400);
    const token = `alw_${randomBytes(24).toString('base64url')}`;
    const id = `alid_${randomBytes(8).toString('hex')}`;
    this.deps.db
      .prepare('INSERT INTO allowances (id, token_hash, label, cap_cents, created_ms, expires_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, hashAllowanceToken(token), dec.label, dec.capCents, now, dec.expiresMs);
    // Never the token (nor its hash) in the audit log: the log is public.
    this.deps.audit.append('allowance.created', { allowanceId: id, label: dec.label, capCents: dec.capCents, expiresMs: dec.expiresMs });
    return { ...this.allowanceView(this.allowanceRow(id)!), allowanceToken: token };
  }

  /** The allowance a token belongs to, or null. */
  allowanceForToken(token: string): AllowanceView | null {
    const a = this.allowanceByToken(token);
    return a ? this.allowanceView(a) : null;
  }

  /**
   * Revoke an allowance. Needs its id AND its token: the id is public (audit
   * log), the token only the person and their agent have. Donations still
   * waiting for approval under it are cancelled, so they can't be captured.
   */
  revokeAllowance(id: string, token: unknown): AllowanceView {
    const a = ALLOWANCE_ID_RE.test(id) ? this.allowanceRow(id) : undefined;
    const ok =
      a !== undefined &&
      typeof token === 'string' &&
      ALLOWANCE_TOKEN_RE.test(token) &&
      timingSafeEqual(Buffer.from(hashAllowanceToken(token), 'hex'), Buffer.from(a.token_hash, 'hex'));
    // One answer for "no such id" and "wrong token", so the endpoint is no oracle.
    if (!ok || !a) this.refuse('ALLOWANCE_NOT_FOUND', 'No allowance with that id and token.', 404);
    if (a.revoked_ms !== null) return this.allowanceView(a);
    const tx = this.deps.db.transaction(() => {
      this.deps.db.prepare('UPDATE allowances SET revoked_ms = ? WHERE id = ? AND revoked_ms IS NULL').run(this.now(), id);
      const pending = (this.deps.db.prepare("SELECT receipt_id FROM donations WHERE allowance_id = ? AND status IN ('CREATING','AWAITING_APPROVAL')").all(id) as { receipt_id: string }[]).map(
        (r) => r.receipt_id,
      );
      this.deps.db.prepare("UPDATE donations SET status = 'CANCELED' WHERE allowance_id = ? AND status IN ('CREATING','AWAITING_APPROVAL')").run(id);
      this.deps.audit.append('allowance.revoked', { allowanceId: id, canceledReceipts: pending });
    });
    tx.immediate();
    return this.allowanceView(this.allowanceRow(id)!);
  }

  private toCreated(d: DonationRow, replayed: boolean): CreatedDonation {
    const a = d.allowance_id ? this.allowanceRow(d.allowance_id) : undefined;
    return {
      receiptId: d.receipt_id,
      orderId: d.order_id!,
      approvalUrl: d.approval_url ?? '',
      amountUsd: (d.amount_cents / 100).toFixed(2),
      status: d.status,
      replayed,
      ...(a ? { allowance: this.allowanceView(a) } : {}),
    };
  }

  /** Agent-readable receipt (SPEC §5.6b), with audit references a donor can verify. */
  receipt(receiptId: string) {
    const d = this.get(receiptId);
    if (!d) return null;
    const entries = this.deps.audit.entries();
    const mine = (e: AuditEntry) => (e.payload as { receiptId?: string }).receiptId === receiptId;
    const find = (type: string): AuditEntry | undefined => entries.find((e) => e.type === type && mine(e));
    const created = find('donation.created');
    const captured = find('donation.captured');
    const lifecycle = entries
      .filter((e) => ['donation.capture_pending', 'donation.denied', 'donation.refunded', 'donation.reversed', 'donation.canceled'].includes(e.type) && mine(e))
      .map((e) => ({ type: e.type, seq: e.seq, hash: e.hash }));
    const head = this.deps.audit.head();
    const pool = this.poolStatus();
    return {
      receiptId: d.receipt_id,
      status: d.status,
      source: d.source,
      amountUsd: (d.amount_cents / 100).toFixed(2),
      refundedUsd: (d.refunded_cents / 100).toFixed(2),
      currency: 'USD',
      donorRef: d.donor_ref,
      allowanceId: d.allowance_id,
      createdAt: new Date(d.created_ms).toISOString(),
      capturedAt: d.captured_ms ? new Date(d.captured_ms).toISOString() : null,
      paypal: { orderId: d.order_id, captureId: d.capture_id, environment: 'sandbox' },
      audit: {
        created: created ? { seq: created.seq, hash: created.hash } : null,
        captured: captured ? { seq: captured.seq, hash: captured.hash } : null,
        lifecycle,
        headHash: head,
        verifyUrl: captured ? `/api/audit/verify?upTo=${captured.hash}` : created ? `/api/audit/verify?upTo=${created.hash}` : null,
        entriesUrl: '/api/audit?limit=1000',
      },
      poolSummary: { totalDisbursedUsd: (pool.disbursedCents / 100).toFixed(2), recipientsCount: pool.recipientsPaid, batchIds: pool.batchIds, auditHeadHash: head },
      whatThisProves: RECEIPT_PROVES,
      sandbox: true,
    };
  }

  poolStatus() {
    const db = this.deps.db;
    const disbursed = db
      .prepare("SELECT COALESCE(SUM(amount_cents),0) AS c, COUNT(*) AS n FROM payout_items WHERE status IN ('SUCCESS','UNCLAIMED','PENDING','RESERVED','ONHOLD')")
      .get() as { c: number; n: number };
    // Net of refunds and reversals (those are negative ledger entries).
    const net = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS c FROM ledger_entries WHERE kind IN ('donation_credit','donation_refund','donation_reversal')").get() as { c: number };
    const count = db.prepare("SELECT COUNT(*) AS n FROM donations WHERE status IN ('CAPTURED','PARTIALLY_REFUNDED')").get() as { n: number };
    const batchIds = (db.prepare('SELECT paypal_batch_id FROM payout_batches WHERE paypal_batch_id IS NOT NULL ORDER BY id').all() as { paypal_batch_id: string }[]).map((b) => b.paypal_batch_id);
    return {
      balanceCents: this.deps.ledger.poolBalanceCents(),
      disbursedCents: disbursed.c,
      recipientsPaid: disbursed.n,
      donationsCents: net.c,
      donationsCount: count.n,
      batchIds,
    };
  }

  /** Public feed of recent donations. donor_ref and message are returned as plain data; the UI escapes them. */
  feed(limit = 30) {
    return (this.deps.db.prepare('SELECT * FROM donations ORDER BY id DESC LIMIT ?').all(limit) as DonationRow[]).map((d) => ({
      receiptId: d.receipt_id,
      source: d.source,
      donorRef: d.donor_ref,
      message: d.message,
      amountUsd: (d.amount_cents / 100).toFixed(2),
      status: d.status,
      createdAt: new Date(d.created_ms).toISOString(),
    }));
  }
}
