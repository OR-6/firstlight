import { randomBytes } from 'node:crypto';
import { canonicalJson, sha256Hex } from '../lib/canonical';
import type { AuditEntry, AuditLog } from '../ledger/audit';
import { instanceId, type Db } from '../ledger/db';
import type { Ledger } from '../ledger/ledger';
import type { DonationOrders } from '../paypal/orders';
import { evaluateDonation, type DonationPolicyConfig, type RecentDonation } from './policy';

/**
 * Donations: create a PayPal order, let a HUMAN approve it on PayPal, then
 * capture and credit the internal pool ledger exactly once.
 *
 * A donor agent can only create an order. It can never move anyone's money
 * on its own: the approval happens on PayPal's page, by a person.
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
};

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

export type CreatedDonation = { receiptId: string; orderId: string; approvalUrl: string; amountUsd: string; status: string; replayed: boolean };

export class DonationService {
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

  /** Validate, create the PayPal order, return where the human approves it. */
  async create(raw: unknown, source: DonationSource): Promise<CreatedDonation> {
    // Replay of the same idempotency key from the same donor → same receipt, no new order.
    const pre = raw && typeof raw === 'object' ? (raw as { donor_ref?: unknown; idempotency_key?: unknown }) : {};
    if (typeof pre.donor_ref === 'string' && typeof pre.idempotency_key === 'string') {
      const existing = this.deps.db
        .prepare('SELECT * FROM donations WHERE donor_ref = ? AND idempotency_key = ?')
        .get(pre.donor_ref.trim(), pre.idempotency_key) as DonationRow | undefined;
      if (existing?.order_id) return this.toCreated(existing, true);
    }

    const decision = evaluateDonation(raw, { now: this.now(), recent: this.recent(), config: this.deps.policy });
    if (!decision.ok) {
      this.deps.audit.append('donation.rejected', { source, code: decision.code });
      throw new DonationError(decision.code, decision.message, decision.code.endsWith('RATE_LIMIT') || decision.code === 'CARD_TESTING_PATTERN' ? 429 : 400);
    }

    const receiptId = `rcpt_${randomBytes(8).toString('hex')}`;
    const createdMs = this.now();
    this.deps.db
      .prepare(
        `INSERT INTO donations (receipt_id, source, donor_ref, message, amount_cents, idempotency_key, status, created_ms)
         VALUES (?, ?, ?, ?, ?, ?, 'CREATING', ?)`,
      )
      .run(receiptId, source, decision.donorRef, decision.message, decision.amountCents, decision.idempotencyKey, createdMs);

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
      this.deps.db
        .prepare("UPDATE donations SET order_id = ?, approval_url = ?, status = 'AWAITING_APPROVAL' WHERE receipt_id = ?")
        .run(order.orderId, order.approvalUrl, receiptId);
      this.deps.audit.append('donation.created', {
        receiptId,
        source,
        amountCents: decision.amountCents,
        orderId: order.orderId,
        // donor_ref is untrusted text; recorded as data only.
        donorRef: decision.donorRef,
      });
      return { receiptId, orderId: order.orderId, approvalUrl: order.approvalUrl, amountUsd: (decision.amountCents / 100).toFixed(2), status: 'AWAITING_APPROVAL', replayed: false };
    } catch (err) {
      this.deps.db.prepare("UPDATE donations SET status = 'FAILED' WHERE receipt_id = ?").run(receiptId);
      this.deps.audit.append('donation.failed', { receiptId, stage: 'create', message: (err as Error).message.slice(0, 200) });
      throw new DonationError('PAYPAL', (err as Error).message, 502);
    }
  }

  /**
   * Capture after the payer approved on PayPal, and credit the pool once.
   * Safe to call repeatedly (return URL, webhook, retries): the capture uses a
   * fixed PayPal-Request-Id and the ledger credit is unique per capture id.
   */
  async capture(receiptId: string, orderIdFromReturn?: string): Promise<DonationRow> {
    const d = this.get(receiptId);
    if (!d || !d.order_id) throw new DonationError('NOT_FOUND', 'No donation with that receipt.', 404);
    if (orderIdFromReturn && orderIdFromReturn !== d.order_id) throw new DonationError('ORDER_MISMATCH', 'This approval does not belong to that receipt.', 400);
    if (d.status === 'CAPTURED') return d;
    if (d.status === 'CANCELED' || d.status === 'FAILED') throw new DonationError('NOT_CAPTURABLE', `This donation is ${d.status.toLowerCase()}.`, 409);

    const requestId = sha256Hex(canonicalJson({ instance: instanceId(this.deps.db), receiptId, op: 'capture' }));
    const res = await this.deps.orders().capture(d.order_id, requestId);
    if (res.status !== 'COMPLETED' || res.captureStatus !== 'COMPLETED' || !res.captureId) {
      this.deps.audit.append('donation.capture_pending', { receiptId, orderStatus: res.status, captureStatus: res.captureStatus });
      return this.get(receiptId)!;
    }
    return this.credit(receiptId, res.captureId, res.amountCents ?? d.amount_cents);
  }

  /** Webhook PAYMENT.CAPTURE.COMPLETED (verified upstream). */
  onCaptureCompleted(orderId: string | undefined, captureId: string, amountCents: number | null): DonationRow | null {
    if (!orderId) return null;
    const d = this.byOrder(orderId);
    if (!d) return null;
    return this.credit(d.receipt_id, captureId, amountCents ?? d.amount_cents);
  }

  private credit(receiptId: string, captureId: string, capturedCents: number): DonationRow {
    const d = this.get(receiptId)!;
    // Only ever credit what the donor asked for; a mismatch is logged, never trusted upward.
    const cents = Math.min(capturedCents, d.amount_cents);
    const { credited } = this.deps.ledger.creditDonation(captureId, cents);
    if (d.status !== 'CAPTURED') {
      this.deps.db
        .prepare("UPDATE donations SET status = 'CAPTURED', capture_id = ?, captured_ms = ? WHERE receipt_id = ? AND status != 'CAPTURED'")
        .run(captureId, this.now(), receiptId);
    }
    if (credited) {
      this.deps.audit.append('donation.captured', {
        receiptId,
        captureId,
        amountCents: cents,
        mismatch: capturedCents !== d.amount_cents ? { expected: d.amount_cents, captured: capturedCents } : undefined,
      });
    }
    return this.get(receiptId)!;
  }

  cancel(receiptId: string): void {
    const res = this.deps.db.prepare("UPDATE donations SET status = 'CANCELED' WHERE receipt_id = ? AND status = 'AWAITING_APPROVAL'").run(receiptId);
    if (res.changes) this.deps.audit.append('donation.canceled', { receiptId });
  }

  private toCreated(d: DonationRow, replayed: boolean): CreatedDonation {
    return {
      receiptId: d.receipt_id,
      orderId: d.order_id!,
      approvalUrl: d.approval_url ?? '',
      amountUsd: (d.amount_cents / 100).toFixed(2),
      status: d.status,
      replayed,
    };
  }

  /** Agent-readable receipt (SPEC §5.6b), with audit references a donor can verify. */
  receipt(receiptId: string) {
    const d = this.get(receiptId);
    if (!d) return null;
    const entries = this.deps.audit.entries();
    const find = (type: string): AuditEntry | undefined => entries.find((e) => e.type === type && (e.payload as { receiptId?: string }).receiptId === receiptId);
    const created = find('donation.created');
    const captured = find('donation.captured');
    const head = this.deps.audit.head();
    const pool = this.poolStatus();
    return {
      receiptId: d.receipt_id,
      status: d.status,
      source: d.source,
      amountUsd: (d.amount_cents / 100).toFixed(2),
      currency: 'USD',
      donorRef: d.donor_ref,
      createdAt: new Date(d.created_ms).toISOString(),
      capturedAt: d.captured_ms ? new Date(d.captured_ms).toISOString() : null,
      paypal: { orderId: d.order_id, captureId: d.capture_id, environment: 'sandbox' },
      audit: {
        created: created ? { seq: created.seq, hash: created.hash } : null,
        captured: captured ? { seq: captured.seq, hash: captured.hash } : null,
        headHash: head,
        verifyUrl: captured ? `/api/audit/verify?upTo=${captured.hash}` : created ? `/api/audit/verify?upTo=${created.hash}` : null,
      },
      poolSummary: { totalDisbursedUsd: (pool.disbursedCents / 100).toFixed(2), recipientsCount: pool.recipientsPaid, batchIds: pool.batchIds, auditHeadHash: head },
      sandbox: true,
    };
  }

  poolStatus() {
    const db = this.deps.db;
    const disbursed = db
      .prepare("SELECT COALESCE(SUM(amount_cents),0) AS c, COUNT(*) AS n FROM payout_items WHERE status IN ('SUCCESS','UNCLAIMED','PENDING','RESERVED','ONHOLD')")
      .get() as { c: number; n: number };
    const donations = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS c, COUNT(*) AS n FROM donations WHERE status = 'CAPTURED'").get() as { c: number; n: number };
    const batchIds = (db.prepare('SELECT paypal_batch_id FROM payout_batches WHERE paypal_batch_id IS NOT NULL ORDER BY id').all() as { paypal_batch_id: string }[]).map((b) => b.paypal_batch_id);
    return {
      balanceCents: this.deps.ledger.poolBalanceCents(),
      disbursedCents: disbursed.c,
      recipientsPaid: disbursed.n,
      donationsCents: donations.c,
      donationsCount: donations.n,
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
