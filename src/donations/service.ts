import { randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalJson, sha256Hex } from '../lib/canonical';
import type { AuditEntry, AuditLog } from '../ledger/audit';
import { instanceId, type Db } from '../ledger/db';
import type { Ledger } from '../ledger/ledger';
import type { DonationOrders, OrderConfirmation } from '../paypal/orders';
import {
  ALLOWANCE_ID_RE,
  ALLOWANCE_TOKEN_RE,
  MANAGE_KEY_RE,
  MAX_MANAGE_KEYS,
  allowanceHandle,
  allowanceStatus,
  payerCheck,
  checkAllowance,
  committedCents,
  evaluateAllowanceRequest,
  parseAgentDonation,
  type AllowanceState,
} from './allowance';
import { HumanGate } from './human-gate';
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
  /** sha256 of the PayPal payer id that approved it (agent donations). Never the raw id; never public. */
  payer_hash: string | null;
};

export type AllowanceRow = {
  id: string;
  token_hash: string;
  label: string;
  cap_cents: number;
  created_ms: number;
  expires_ms: number;
  revoked_ms: number | null;
  /** sha256 of the PayPal payer id this allowance is tied to (set by the first approval). */
  payer_hash: string | null;
  /** sha256 of the person's manage key (alm_…), which lists and revokes the allowance. */
  manage_hash: string | null;
};

/** What PayPal told us about a capture (from a verified webhook). */
export type CaptureEvent = { orderId: string | null; captureId: string; reason?: string | null };
/** A refund or reversal of a capture (from a verified webhook). */
export type ReturnEvent = {
  captureId: string | null;
  orderId: string | null;
  refId: string | null;
  eventId: string;
  amountCents: number | null;
  /** Set when staff refunded it from the console (POST /api/donations/{receiptId}/refund). */
  initiatedBy?: 'operator';
  reason?: string;
};

/** Statuses after the money arrived; a late COMPLETED never overwrites these. */
const AFTER_CAPTURE = ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REVERSED'];
const ALLOWANCE_HTTP: Record<string, number> = {
  ALLOWANCE_REQUIRED: 401,
  ALLOWANCE_UNKNOWN: 401,
  ALLOWANCE_REVOKED: 403,
  ALLOWANCE_EXPIRED: 403,
  ALLOWANCE_EXCEEDED: 403,
};

/** Held: approved by a PayPal account other than the one the allowance is tied to. Never credited. */
const HELD = 'PAYER_MISMATCH';

export const hashAllowanceToken = (token: string) => sha256Hex(token);
export const hashManageKey = (key: string) => sha256Hex(`manage:${key}`);

/** Ledger ref of a refund debit held while PayPal is asked (see refund()). */
const reserveRef = (ref: string) => `reserve:${ref}`;

/** What a receipt does and does not show (also in the manifest). */
export const RECEIPT_PROVES =
  "This donation is recorded in Firstlight's hash-chained audit log (recompute the chain yourself from /api/audit), and the pool totals are shown. paypalConfirmed is what PayPal itself reports for the order when the receipt is fetched, and the donor can match paypal.captureId against the payment in their own PayPal account's activity. It does not show where each dollar went: the pool is shared, so a donation is not earmarked to any recipient.";

/** Receipt lookups at PayPal: cached per order, and capped across everyone (receipts are public). */
const CONFIRM_TTL_MS = 30_000;
const CONFIRM_FAIL_TTL_MS = 10_000;
const CONFIRM_PER_MINUTE = 30;

export type PayPalConfirmed = {
  status: string;
  captureId: string | null;
  captureStatus: string | null;
  amount: { currency: 'USD'; value: string } | null;
  checkedAt: string;
  source: OrderConfirmation['source'];
  /** PayPal's capture id and amount are the ones on this receipt. */
  matchesReceipt: boolean;
  fallbackReason?: string;
};

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
  /** Short public handle shown next to the label in the feed. */
  handle: string;
  paypalAccount: {
    /** True once the first donation approved on PayPal tied this allowance to that PayPal account. */
    tied: boolean;
    /** Donations under it so far that were approved by a different PayPal account and held, not credited. */
    heldForOtherAccount: number;
    note: string;
  };
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

  private readonly confirmations = new Map<string, { at: number; value: PayPalConfirmed | null; reason?: string }>();
  private confirmCalls: number[] = [];
  private readonly refunding = new Set<string>();
  /** Nonces for the /agents allowance form (per process: a restart voids them). */
  readonly humanGate = new HumanGate(() => this.now());

  private now() {
    return (this.deps.clock ?? Date.now)();
  }

  private recent(): RecentDonation[] {
    const since = this.now() - 24 * 3_600_000;
    return (
      this.deps.db.prepare('SELECT donor_ref, amount_cents, created_ms, status, allowance_id FROM donations WHERE created_ms > ?').all(since) as {
        donor_ref: string;
        amount_cents: number;
        created_ms: number;
        status: string;
        allowance_id: string | null;
      }[]
    ).map((r) => ({ donorRef: r.donor_ref, amountCents: r.amount_cents, at: r.created_ms, status: r.status, allowanceId: r.allowance_id }));
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
    } else if (raw && typeof raw === 'object' && (raw as { idempotency_key?: unknown }).idempotency_key !== undefined) {
      // People share names ("Anonymous"), so a key scoped to a name could hand one person another's approval link.
      this.refuse('IDEMPOTENCY_KEY_AGENT_ONLY', 'idempotency_key is only for agent donations under an allowance. Leave it out; the Donate page needs none.', 400);
    }

    // Replay of the same idempotency key under the same allowance → same receipt, no new order.
    const pre = input && typeof input === 'object' ? (input as { donor_ref?: unknown; idempotency_key?: unknown }) : {};
    if (allowance && typeof pre.donor_ref === 'string' && typeof pre.idempotency_key === 'string') {
      const donorRef = pre.donor_ref.trim();
      const existing = this.deps.db.prepare('SELECT * FROM donations WHERE allowance_id = ? AND idempotency_key = ?').get(allowance.id, pre.idempotency_key) as DonationRow | undefined;
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
        // Same label and key under an earlier allowance that held the label: never hand over someone else's receipt.
        throw new DonationError('IDEMPOTENCY_CONFLICT', 'That idempotency_key is already in use for this donor name. Use a new key.', 409);
      }
    }

    const now = this.now();
    const decision = evaluateDonation(input, { now, recent: this.recent(), config: this.deps.policy, allowanceId: allowance?.id });
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
    if (AFTER_CAPTURE.includes(d.status) || d.status === HELD) return d;
    if (d.status === 'CANCELED' || d.status === 'FAILED' || d.status === 'DENIED') throw new DonationError('NOT_CAPTURABLE', `This donation is ${d.status.toLowerCase()}.`, 409);

    // Agent donations: who approved it on PayPal? Checked BEFORE capturing, so a donation approved by
    // another PayPal account is simply never captured (no money moves, nothing to refund).
    let approver: string | null = null;
    if (d.allowance_id) {
      let look;
      try {
        look = await this.deps.orders().get(d.order_id);
      } catch (err) {
        throw new DonationError('PAYPAL', (err as Error).message, 502);
      }
      if (!look.payerId) {
        if (look.status === 'CREATED' || look.status === 'PAYER_ACTION_REQUIRED') throw new DonationError('NOT_APPROVED', 'This order has not been approved on PayPal yet.', 409);
        throw new DonationError('PAYER_UNKNOWN', 'PayPal did not say which account approved this order, so it was not captured. Try again.', 502);
      }
      approver = this.payerHash(look.payerId);
      if (this.tiePayer(this.get(receiptId)!, approver) === 'mismatch') return this.hold(receiptId, approver, null);
    }

    const requestId = sha256Hex(canonicalJson({ instance: instanceId(this.deps.db), receiptId, op: 'capture' }));
    const res = await this.deps.orders().capture(d.order_id, requestId);
    // Belt and braces: the capture response names the payer too. If it differs from the approval we checked, hold.
    if (approver && res.payerId && this.payerHash(res.payerId) !== approver) return this.hold(receiptId, this.payerHash(res.payerId), res.captureId);
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
  async onCaptureCompleted(orderId: string | undefined, captureId: string, amountCents: number | null): Promise<DonationRow | null> {
    const d = this.findByCapture(captureId, orderId ?? null);
    if (!d) return null;
    if (d.allowance_id && !d.payer_hash && d.order_id && d.status !== HELD) {
      // A capture we never checked the payer of (e.g. it was captured while our capture call timed out): check now.
      const look = await this.deps.orders().get(d.order_id);
      if (!look.payerId) throw new DonationError('PAYER_UNKNOWN', 'PayPal did not say which account approved this order.', 502);
      const approver = this.payerHash(look.payerId);
      if (this.tiePayer(d, approver) === 'mismatch') return this.hold(d.receipt_id, approver, captureId);
    }
    return this.credit(d.receipt_id, captureId, amountCents ?? d.amount_cents);
  }

  private payerHash(payerId: string): string {
    return sha256Hex(canonicalJson({ instance: instanceId(this.deps.db), payerId }));
  }

  /**
   * Tie the allowance to this PayPal account if it isn't tied yet, else compare.
   * Synchronous, in one transaction, so two first approvals can't both tie it.
   */
  private tiePayer(d: DonationRow, approver: string): 'bind' | 'match' | 'mismatch' {
    const tx = this.deps.db.transaction(() => {
      const a = this.allowanceRow(d.allowance_id!)!;
      const verdict = payerCheck(a.payer_hash, approver);
      if (verdict === 'bind') {
        this.deps.db.prepare('UPDATE allowances SET payer_hash = ? WHERE id = ? AND payer_hash IS NULL').run(approver, a.id);
        // Never the payer id or its hash in the public log: only that the allowance is now tied.
        this.deps.audit.append('allowance.payer_tied', { allowanceId: a.id, receiptId: d.receipt_id });
      }
      this.deps.db.prepare('UPDATE donations SET payer_hash = ? WHERE receipt_id = ?').run(approver, d.receipt_id);
      return verdict;
    });
    return tx.immediate();
  }

  /**
   * Approved by a different PayPal account than the allowance is tied to: hold it.
   * Before capture (captureId null) the order is left uncaptured, so the payer is
   * never charged and PayPal lets the approval lapse. If PayPal captured anyway,
   * the capture is recorded but never credited; staff refund it from the console.
   */
  private hold(receiptId: string, approver: string, captureId: string | null): DonationRow {
    const tx = this.deps.db.transaction(() => {
      const res = this.deps.db
        .prepare(`UPDATE donations SET status = '${HELD}', payer_hash = ?, capture_id = COALESCE(capture_id, ?) WHERE receipt_id = ? AND status IN ('CREATING','AWAITING_APPROVAL','PENDING')`)
        .run(approver, captureId, receiptId);
      if (!res.changes) return;
      const d = this.get(receiptId)!;
      this.deps.audit.append('donation.payer_mismatch', {
        receiptId,
        allowanceId: d.allowance_id ?? undefined,
        orderId: d.order_id ?? undefined,
        captureId: captureId ?? undefined,
        action: captureId ? 'captured_not_credited_refund_needed' : 'not_captured',
      });
    });
    tx.immediate();
    return this.get(receiptId)!;
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
    // A refund proves the capture completed: book the credit first if we never heard about it (credit() refuses held ones).
    if (captureId && this.deps.ledger.donationCreditCents(captureId) === 0 && d.status !== 'DENIED') this.credit(d.receipt_id, captureId, d.amount_cents, kind);

    const ledgerKind = kind === 'refund' ? 'donation_refund' : 'donation_reversal';
    const ref = `${kind}:${e.refId ?? `event:${e.eventId}`}`;
    const tx = this.deps.db.transaction(() => {
      if (this.deps.db.prepare('SELECT 1 FROM ledger_entries WHERE kind = ? AND ref = ?').get(ledgerKind, ref)) return; // seen this refund before
      // A staff refund PayPal left PENDING held its debit as a reservation: this booking replaces it.
      if (kind === 'refund') this.releaseReservation(reserveRef(ref));
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
        initiatedBy: e.initiatedBy,
        reason: e.reason,
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

  /**
   * Book a capture: ledger credit, status and the donation.captured audit entry
   * commit together or not at all, so a crash can't leave money credited with
   * no audit entry (or an audit entry with no credit).
   */
  private credit(receiptId: string, captureId: string, capturedCents: number, learnedFrom?: 'refund' | 'reversal'): DonationRow {
    const tx = this.deps.db.transaction(() => {
      const d = this.get(receiptId)!;
      // Held for a different PayPal account, or an agent donation whose payer was never checked: never credited.
      if (d.status === HELD || (d.allowance_id && !d.payer_hash)) return;
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
    });
    tx.immediate();
    return this.get(receiptId)!;
  }

  /**
   * Staff refund a captured donation from the console (POST
   * /api/donations/{receiptId}/refund). Refunds through PayPal (Payments
   * refund capture, with a PayPal-Request-Id so a retry never refunds twice),
   * then books it through the same idempotent path as the refund webhook, so a
   * later PAYMENT.CAPTURE.REFUNDED for the same refund changes nothing.
   * Refused if it would exceed what was captured and not yet returned, or take
   * the pool below zero. A held donation (PAYER_MISMATCH) that PayPal captured
   * anyway was never credited: it is refunded without touching the pool.
   *
   * The pool check and a reservation of the debit commit in one immediate
   * transaction BEFORE PayPal is asked, so a payout batch reserved while we
   * wait can't spend the same money. The reservation is a donation_refund
   * ledger entry with ref "reserve:…". PayPal's answer finalises it
   * (COMPLETED: swapped for the real refund entry in one transaction), keeps
   * it (PENDING: the refund webhook swaps it), or releases it (error).
   */
  async refund(receiptId: string, raw: unknown): Promise<DonationRow & { refundId: string; refundStatus: string }> {
    const body = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const extra = Object.keys(body).filter((k) => k !== 'amount_usd' && k !== 'reason');
    if (extra.length) this.refuse('UNKNOWN_FIELDS', `Unknown field(s): ${extra.slice(0, 5).join(', ')}. Allowed: amount_usd, reason.`, 400);
    const reason = typeof body.reason === 'string' ? body.reason.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 200) : undefined;
    let askedCents: number | null = null;
    if (body.amount_usd !== undefined) {
      const n = typeof body.amount_usd === 'number' ? body.amount_usd : typeof body.amount_usd === 'string' && /^\d{1,6}(\.\d{1,2})?$/.test(body.amount_usd) ? Number(body.amount_usd) : NaN;
      askedCents = Math.round(n * 100);
      if (!Number.isFinite(n) || Math.abs(n * 100 - askedCents) > 1e-6 || askedCents <= 0) this.refuse('INVALID_REQUEST', 'amount_usd must be a positive amount with at most 2 decimals.', 400);
    }

    const d = this.get(receiptId);
    if (!d) this.refuse('NOT_FOUND', 'No donation with that receipt.', 404);
    const heldCapture = d.status === HELD && d.capture_id !== null;
    if (!d.capture_id || !(['CAPTURED', 'PARTIALLY_REFUNDED'].includes(d.status) || heldCapture)) {
      this.refuse('NOT_REFUNDABLE', `Only a received donation can be refunded; this one is ${d.status.toLowerCase().replace(/_/g, ' ')}.`, 409);
    }
    const captureId = d.capture_id;
    const credited = this.deps.ledger.donationCreditCents(captureId);
    const room = heldCapture ? d.amount_cents - d.refunded_cents : Math.max(0, credited - d.refunded_cents);
    const cents = askedCents ?? room;
    if (cents <= 0) this.refuse('NOTHING_TO_REFUND', 'This donation has already been refunded in full.', 409);
    if (cents > room) this.refuse('REFUND_EXCEEDS_CAPTURE', `At most $${(room / 100).toFixed(2)} of this donation can still be refunded.`, 409);
    if (this.refunding.has(receiptId)) this.refuse('REFUND_IN_PROGRESS', 'A refund of this donation is already being sent to PayPal.', 409);

    // Same donation, same state, same amount → same PayPal-Request-Id: a retry after a crash can't refund twice.
    const requestId = sha256Hex(canonicalJson({ instance: instanceId(this.deps.db), receiptId, op: 'refund', refundedBefore: d.refunded_cents, cents }));
    const held = reserveRef(requestId);
    // A held capture was never in the pool, so there is nothing to reserve.
    if (!heldCapture) this.reserveRefund(held, cents);

    this.refunding.add(receiptId);
    try {
      let res;
      try {
        res = await this.deps.orders().refund({ captureId, amountCents: cents, requestId, note: 'Refund of your donation to the Firstlight relief pool (sandbox).' });
      } catch (err) {
        if (!heldCapture) this.releaseReservation(held);
        this.deps.audit.append('donation.refund_failed', { receiptId, captureId, amountCents: cents, initiatedBy: 'operator', message: (err as Error).message.slice(0, 200) });
        throw new DonationError('PAYPAL', (err as Error).message, 502);
      }
      if (res.status !== 'COMPLETED') {
        // PENDING (e.g. an eCheck): PayPal hasn't returned the money yet. The debit stays reserved under PayPal's
        // refund id; the refund webhook books it when it completes and drops the reservation in the same transaction.
        if (!heldCapture) this.keepReservation(held, `refund:${res.refundId}`);
        this.deps.audit.append('donation.refund_pending', { receiptId, captureId, paypalRefId: res.refundId, refundStatus: res.status, amountCents: cents, initiatedBy: 'operator', reason });
        return { ...this.get(receiptId)!, refundId: res.refundId, refundStatus: res.status };
      }
      const refunded = Math.min(res.amountCents ?? cents, cents);
      if (heldCapture) this.refundHeld(receiptId, captureId, res.refundId, refunded, reason);
      else {
        // Swap the reservation for the real refund entry in one transaction: the pool never counts it twice or not at all.
        const book = this.deps.db.transaction(() => {
          this.releaseReservation(held);
          this.onCaptureReturned('refund', { captureId, orderId: d.order_id, refId: res.refundId, eventId: `operator:${requestId.slice(0, 16)}`, amountCents: refunded, initiatedBy: 'operator', reason });
        });
        book.immediate();
      }
      return { ...this.get(receiptId)!, refundId: res.refundId, refundStatus: res.status };
    } finally {
      this.refunding.delete(receiptId);
    }
  }

  /** Check the pool and hold the refund's debit, atomically. A reservation a crash left for this same request is replaced, not counted twice. */
  private reserveRefund(ref: string, cents: number): void {
    const tx = this.deps.db.transaction(() => {
      this.releaseReservation(ref);
      const balance = this.deps.ledger.poolBalanceCents();
      if (balance - cents < 0) {
        this.refuse('POOL_WOULD_GO_NEGATIVE', `The pool has $${(balance / 100).toFixed(2)}; refunding $${(cents / 100).toFixed(2)} would take it below zero.`, 409);
      }
      this.deps.db.prepare("INSERT INTO ledger_entries (kind, amount_cents, ref, created_ms) VALUES ('donation_refund', ?, ?, ?)").run(-cents, ref, this.now());
    });
    tx.immediate();
  }

  private releaseReservation(ref: string): void {
    this.deps.db.prepare("DELETE FROM ledger_entries WHERE kind = 'donation_refund' AND ref = ?").run(ref);
  }

  /** PayPal left the refund PENDING: keep the debit held under PayPal's refund id, unless its webhook already booked it. */
  private keepReservation(ref: string, bookedRef: string): void {
    const tx = this.deps.db.transaction(() => {
      if (this.deps.db.prepare("SELECT 1 FROM ledger_entries WHERE kind = 'donation_refund' AND ref = ?").get(bookedRef)) this.releaseReservation(ref);
      else this.deps.db.prepare("UPDATE ledger_entries SET ref = ? WHERE kind = 'donation_refund' AND ref = ?").run(reserveRef(bookedRef), ref);
    });
    tx.immediate();
  }

  /** A held capture was never in the pool: record the refund, debit nothing. */
  private refundHeld(receiptId: string, captureId: string, refundId: string, cents: number, reason?: string): void {
    const tx = this.deps.db.transaction(() => {
      const cur = this.get(receiptId)!;
      const total = Math.min(cur.amount_cents, cur.refunded_cents + cents);
      this.deps.db.prepare('UPDATE donations SET refunded_cents = ? WHERE receipt_id = ?').run(total, receiptId);
      this.deps.audit.append('donation.refunded', {
        receiptId,
        captureId,
        paypalRefId: refundId,
        allowanceId: cur.allowance_id ?? undefined,
        initiatedBy: 'operator',
        reason,
        amountCents: cents,
        totalReturnedCents: total,
        poolDebitedCents: 0,
        note: 'held for a different PayPal account, never credited',
      });
    });
    tx.immediate();
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
    const held = (this.deps.db.prepare(`SELECT COUNT(*) AS n FROM donations WHERE allowance_id = ? AND status = '${HELD}'`).get(a.id) as { n: number }).n;
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
      handle: allowanceHandle(a.id),
      paypalAccount: {
        tied: a.payer_hash !== null,
        heldForOtherAccount: held,
        note:
          a.payer_hash === null
            ? 'Not tied yet: the first donation approved on PayPal ties this allowance to that PayPal account.'
            : `Every donation credited under this allowance was approved by the same PayPal account.${held ? ` ${held} approved by a different account ${held === 1 ? 'was' : 'were'} held and not credited.` : ''}`,
      },
    };
  }

  /**
   * A person lets one agent donate up to a cap until an expiry. Two secrets are
   * returned once, and only their hashes are stored: the agent's token (alw_…,
   * donates) and the person's manage key (alm_…, lists and revokes). The HTTP
   * route only lets a same-origin browser request with a fresh nonce get here.
   */
  createAllowance(raw: unknown): AllowanceView & { allowanceToken: string; manageKey: string } {
    const now = this.now();
    const recent = (this.deps.db.prepare('SELECT COUNT(*) AS n FROM allowances WHERE created_ms > ?').get(now - 10 * 60_000) as { n: number }).n;
    const activeLabels = (this.deps.db.prepare('SELECT label FROM allowances WHERE revoked_ms IS NULL AND expires_ms > ?').all(now) as { label: string }[]).map((r) => r.label);
    const dec = evaluateAllowanceRequest(raw, { now, createdLast10Min: recent, activeLabels });
    if (!dec.ok) this.refuse(dec.code, dec.message, dec.code === 'GLOBAL_RATE_LIMIT' ? 429 : dec.code === 'LABEL_TAKEN' ? 409 : 400);
    const token = `alw_${randomBytes(24).toString('base64url')}`;
    const manageKey = `alm_${randomBytes(24).toString('base64url')}`;
    const id = `alid_${randomBytes(8).toString('hex')}`;
    this.deps.db
      .prepare('INSERT INTO allowances (id, token_hash, label, cap_cents, created_ms, expires_ms, manage_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, hashAllowanceToken(token), dec.label, dec.capCents, now, dec.expiresMs, hashManageKey(manageKey));
    // Never a token or key (nor their hashes) in the audit log: the log is public.
    this.deps.audit.append('allowance.created', { allowanceId: id, label: dec.label, capCents: dec.capCents, expiresMs: dec.expiresMs });
    return { ...this.allowanceView(this.allowanceRow(id)!), allowanceToken: token, manageKey };
  }

  private allowanceByManageKey(key: string): AllowanceRow | undefined {
    if (!MANAGE_KEY_RE.test(key)) return undefined;
    return this.deps.db.prepare('SELECT * FROM allowances WHERE manage_hash = ?').get(hashManageKey(key)) as AllowanceRow | undefined;
  }

  /**
   * "Your allowances" on /agents: the browser sends the manage keys it kept.
   * One entry per key, in order; null for a key that matches nothing (e.g.
   * after a demo reset), so the page can forget it.
   */
  allowancesForManageKeys(keys: unknown): (AllowanceView | null)[] {
    if (!Array.isArray(keys) || keys.length > MAX_MANAGE_KEYS || keys.some((k) => typeof k !== 'string')) {
      this.refuse('INVALID_REQUEST', `manage_keys must be a list of up to ${MAX_MANAGE_KEYS} alm_… keys.`, 400);
    }
    return (keys as string[]).map((k) => {
      const a = this.allowanceByManageKey(k);
      return a ? this.allowanceView(a) : null;
    });
  }

  /** The allowance a token belongs to, or null. */
  allowanceForToken(token: string): AllowanceView | null {
    const a = this.allowanceByToken(token);
    return a ? this.allowanceView(a) : null;
  }

  /**
   * Revoke an allowance. Needs its id AND the person's manage key: the id is
   * public (audit log), the manage key only the person has. The agent's token
   * can't revoke, so an agent can't cancel what its person set up. Donations
   * still waiting for approval under it are cancelled, so they can't be captured.
   */
  revokeAllowance(id: string, manageKey: unknown): AllowanceView {
    if (typeof manageKey === 'string' && ALLOWANCE_TOKEN_RE.test(manageKey)) {
      this.refuse('MANAGE_KEY_REQUIRED', "Revoking needs the manage key (alm_…) the person got when they created the allowance. The agent's alw_… token can't revoke it.", 403);
    }
    const a = ALLOWANCE_ID_RE.test(id) ? this.allowanceRow(id) : undefined;
    const ok =
      a !== undefined &&
      a.manage_hash !== null &&
      typeof manageKey === 'string' &&
      MANAGE_KEY_RE.test(manageKey) &&
      timingSafeEqual(Buffer.from(hashManageKey(manageKey), 'hex'), Buffer.from(a.manage_hash, 'hex'));
    // One answer for "no such id" and "wrong key", so the endpoint is no oracle.
    if (!ok || !a) this.refuse('ALLOWANCE_NOT_FOUND', 'No allowance with that id and manage key.', 404);
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
      .filter(
        (e) =>
          ['donation.capture_pending', 'donation.payer_mismatch', 'donation.denied', 'donation.refund_pending', 'donation.refunded', 'donation.reversed', 'donation.canceled'].includes(e.type) &&
          mine(e),
      )
      .map((e) => ({ type: e.type, seq: e.seq, hash: e.hash }));
    const head = this.deps.audit.head();
    const pool = this.poolStatus();
    const a = d.allowance_id ? this.allowanceRow(d.allowance_id) : undefined;
    const same = a && d.payer_hash ? d.payer_hash === a.payer_hash : null;
    return {
      receiptId: d.receipt_id,
      status: d.status,
      source: d.source,
      amountUsd: (d.amount_cents / 100).toFixed(2),
      refundedUsd: (d.refunded_cents / 100).toFixed(2),
      currency: 'USD',
      donorRef: d.donor_ref,
      allowanceId: d.allowance_id,
      agentHandle: d.allowance_id ? allowanceHandle(d.allowance_id) : null,
      approval: {
        bySamePayPalAccount: same,
        note:
          same === true
            ? 'Approved by the same PayPal account as every other donation credited under this allowance.'
            : same === false
              ? 'Approved by a different PayPal account than the one this allowance is tied to, so it was held and not credited.'
              : a
                ? 'Not approved on PayPal yet.'
                : 'A person donating directly; no allowance.',
      },
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
      sandbox: true as const,
    };
  }

  /**
   * The receipt plus what PayPal itself says about the order right now
   * (GET /api/receipts/{id}, MCP get_receipt). Looked up through PayPal's hosted
   * MCP server (get_order only) with the Server SDK as fallback; cached for 30 s
   * per order and capped at 30 lookups a minute across everyone. A failed lookup
   * gives `paypalConfirmed: null` and a reason, never an error.
   */
  async receiptWithPayPal(receiptId: string) {
    const r = this.receipt(receiptId);
    if (!r) return null;
    const d = this.get(receiptId)!;
    const { value, reason } = await this.confirmAtPayPal(d);
    return { ...r, paypalConfirmed: value, ...(value ? {} : { paypalConfirmedReason: reason ?? 'not checked' }) };
  }

  private async confirmAtPayPal(d: DonationRow): Promise<{ value: PayPalConfirmed | null; reason?: string }> {
    if (!d.order_id) return { value: null, reason: 'NO_ORDER: PayPal never created an order for this donation.' };
    const now = this.now();
    const cached = this.confirmations.get(d.order_id);
    if (cached && now - cached.at < (cached.value ? CONFIRM_TTL_MS : CONFIRM_FAIL_TTL_MS)) return this.withMatch(cached, d);
    this.confirmCalls = this.confirmCalls.filter((t) => t > now - 60_000);
    if (this.confirmCalls.length >= CONFIRM_PER_MINUTE) return { value: null, reason: 'RATE_LIMITED: too many PayPal lookups in the last minute. Try again shortly.' };
    this.confirmCalls.push(now);
    let entry: { at: number; value: PayPalConfirmed | null; reason?: string };
    try {
      const orders = this.deps.orders();
      const c: OrderConfirmation = orders.confirm ? await orders.confirm(d.order_id) : { ...(await orders.get(d.order_id)), source: 'paypal_orders_api' };
      if (c.orderId !== d.order_id) throw new Error('PayPal returned a different order');
      entry = {
        at: now,
        value: {
          status: c.status,
          captureId: c.captureId,
          captureStatus: c.captureStatus,
          amount: c.amountCents === null ? null : { currency: 'USD', value: (c.amountCents / 100).toFixed(2) },
          checkedAt: new Date(now).toISOString(),
          source: c.source,
          matchesReceipt: false,
          ...(c.fallbackReason ? { fallbackReason: c.fallbackReason } : {}),
        },
      };
    } catch (err) {
      entry = { at: now, value: null, reason: `PAYPAL_UNAVAILABLE: ${(err as Error).message}`.slice(0, 200) };
    }
    this.confirmations.set(d.order_id, entry);
    if (this.confirmations.size > 500) this.confirmations.delete(this.confirmations.keys().next().value!);
    return this.withMatch(entry, d);
  }

  /** matchesReceipt is worked out against the receipt as it is now, not as it was when cached. */
  private withMatch(e: { value: PayPalConfirmed | null; reason?: string }, d: DonationRow): { value: PayPalConfirmed | null; reason?: string } {
    if (!e.value) return { value: null, reason: e.reason };
    const v = e.value;
    const matches = v.captureId === null ? d.capture_id === null : v.captureId === d.capture_id && v.amount?.value === (d.amount_cents / 100).toFixed(2);
    return { value: { ...v, matchesReceipt: matches } };
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
      // Labels are unique only while active; the handle tells two agents (or an agent and a person) apart.
      agentHandle: d.allowance_id ? allowanceHandle(d.allowance_id) : null,
      message: d.message,
      amountUsd: (d.amount_cents / 100).toFixed(2),
      status: d.status,
      createdAt: new Date(d.created_ms).toISOString(),
    }));
  }
}
