import 'server-only';
import type { SentinelReport } from '../agent/sentinel';
import { paypalConfigured, type PayPalClient } from '../paypal/client';
import { reconcileBatch, type BatchReconciliation, type LedgerBatchInput } from '../paypal/reconcile';
import { instanceId } from '../ledger/db';
import type { BatchRow } from '../ledger/ledger';
import type { Verdict } from '../firewall/types';
import type { AuditEntry } from '../ledger/audit';
import type { CorroborationReport } from '../signals/corroboration';
import { listReplayEvents, loadReplayEvent } from '../signals/replay';
import { firstlight, DEMO_POOL_CENTS } from './runtime';

/** JSON shapes the dashboard reads. Plain data only; no emails anywhere. */

export type PlanSummary = { id: number; eventId: string; version: number; status: string; overall: string | null; totalCents: number; createdMs: number; decision: string | null; approval: string | null; batchStatus: string | null; llmMode: string };

export function stateView() {
  const rt = firstlight();
  const { db, pipeline } = rt;
  const latest = db.prepare('SELECT id FROM plans ORDER BY id DESC LIMIT 1').get() as { id: number } | undefined;
  const pending = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM verdicts v LEFT JOIN approvals a ON a.plan_id = v.plan_id
         WHERE v.overall = 'REQUIRE_APPROVAL' AND a.plan_id IS NULL`,
      )
      .get() as { n: number }
  ).n;
  const disbursed = (
    db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS c, COUNT(*) AS n FROM payout_items WHERE status IN ('SUCCESS','UNCLAIMED','PENDING','RESERVED','ONHOLD')").get() as {
      c: number;
      n: number;
    }
  );
  return {
    sandbox: true,
    llmMode: rt.llmMode,
    paypalConfigured: paypalConfigured(),
    pool: { balanceCents: pipeline.ledger.poolBalanceCents(), seededCents: DEMO_POOL_CENTS, disbursedCents: disbursed.c, recipientsPaid: disbursed.n },
    events: listReplayEvents(),
    latestPlanId: latest?.id ?? null,
    pendingApprovals: pending,
    auditHead: pipeline.audit.head(),
  };
}

export function eventView(eventId: string) {
  const rt = firstlight();
  const bundle = loadReplayEvent(eventId);
  const stored = rt.pipeline.events.get(eventId);
  const e = stored ?? bundle.event;
  return {
    id: e.id,
    title: e.title,
    place: e.place,
    time: e.time,
    mag: e.mag,
    magType: e.magType,
    alert: e.alert,
    status: e.status,
    depthKm: e.depthKm,
    mmi: e.mmi,
    felt: e.felt,
    url: e.url,
    epicentre: e.epicentre,
    revision: stored?.revision ?? null,
    corroboration: bundle.corroboration,
    untrusted: bundle.untrusted.map((t) => ({ id: t.id, source: t.source, origin: t.origin, text: t.text })),
    recipients: rt.registry.map((r) => ({ recipientId: r.recipientId, town: r.town, locale: r.locale, flags: r.flags, home: r.home })),
  };
}

export function plansList(): PlanSummary[] {
  const rows = firstlight()
    .db.prepare(
      `SELECT p.id, p.event_id, p.version, p.status, p.created_ms, p.raw_plan, p.llm_mode, v.overall, v.verdict_json, a.decision AS approval, b.status AS batch_status
       FROM plans p LEFT JOIN verdicts v ON v.plan_id = p.id LEFT JOIN approvals a ON a.plan_id = p.id
       LEFT JOIN payout_batches b ON b.verdict_digest = v.digest ORDER BY p.id DESC LIMIT 100`,
    )
    .all() as {
    id: number;
    event_id: string;
    version: number;
    status: string;
    created_ms: number;
    raw_plan: string | null;
    llm_mode: string;
    overall: string | null;
    verdict_json: string | null;
    approval: string | null;
    batch_status: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    eventId: r.event_id,
    version: r.version,
    status: r.status,
    overall: r.overall,
    totalCents: r.verdict_json ? (JSON.parse(r.verdict_json) as Verdict).totalCents : 0,
    createdMs: r.created_ms,
    decision: r.raw_plan ? ((JSON.parse(r.raw_plan) as { decision?: string }).decision ?? null) : null,
    approval: r.approval,
    batchStatus: r.batch_status,
    llmMode: r.llm_mode,
  }));
}

export function planView(planId: number) {
  const rt = firstlight();
  const row = rt.db.prepare('SELECT * FROM plans WHERE id = ?').get(planId) as
    | { id: number; event_id: string; version: number; status: string; raw_plan: string | null; agent_json: string; sentinel_json: string; corroboration_json: string; llm_mode: string; created_ms: number }
    | undefined;
  if (!row) return null;
  const verdict = rt.pipeline.verdict(planId);
  const approval = rt.db.prepare('SELECT decision, approver, reason, decided_ms FROM approvals WHERE plan_id = ?').get(planId) as
    | { decision: string; approver: string; reason: string; decided_ms: number }
    | undefined;
  const batch = verdict ? rt.pipeline.ledger.getBatchByDigest(verdict.digest) : undefined;
  const raw = row.raw_plan ? (JSON.parse(row.raw_plan) as Record<string, unknown>) : null;
  const agent = JSON.parse(row.agent_json) as { model: string; turns: number; steps: unknown[]; reason: string | null };
  return {
    id: row.id,
    eventId: row.event_id,
    version: row.version,
    status: row.status,
    createdMs: row.created_ms,
    llmMode: row.llm_mode,
    agent: { model: agent.model, turns: agent.turns, reason: agent.reason, steps: agent.steps },
    decision: (raw?.decision as string | undefined) ?? null,
    rationale: (raw?.rationale as string | undefined) ?? null,
    exceptionRequests: (raw?.exceptionRequests as unknown[] | undefined) ?? [],
    sentinel: JSON.parse(row.sentinel_json) as SentinelReport,
    corroboration: JSON.parse(row.corroboration_json) as CorroborationReport,
    verdict,
    approval: approval ? { decision: approval.decision, approver: approval.approver, reason: approval.reason, decidedMs: approval.decided_ms } : null,
    batch: batch
      ? {
          id: batch.id,
          paypalBatchId: batch.paypal_batch_id,
          status: batch.status,
          createdMs: batch.created_ms,
          items: rt.pipeline.ledger.batchItems(batch.id).map((i) => ({ recipientId: i.recipient_id, amountCents: i.amount_cents, status: i.status })),
        }
      : null,
    recipients: rt.registry.map((r) => ({ recipientId: r.recipientId, town: r.town, locale: r.locale, flags: r.flags, home: r.home })),
    trail: planTrail(planId, row.event_id),
  };
}

/** Audit entries that make up this plan's chain of custody, in order. */
function planTrail(planId: number, eventId: string) {
  const entries = firstlight().pipeline.audit.entries();
  const pick = (e: AuditEntry) => ({ seq: e.seq, type: e.type, hash: e.hash, tsMs: e.tsMs });
  const verdictIdx = entries.findIndex((e) => e.type === 'firewall.verdict' && (e.payload as { planId?: number }).planId === planId);
  if (verdictIdx < 0) return [];
  const before: AuditEntry[] = [];
  for (let i = verdictIdx - 1; i >= 0 && before.length < 4; i--) {
    const e = entries[i]!;
    if ((e.payload as { eventId?: string }).eventId !== eventId) continue;
    if (['signal.received', 'sentinel.pre', 'agent.result', 'sentinel.post'].includes(e.type)) before.unshift(e);
    if (e.type === 'signal.received') break;
  }
  const after = entries.slice(verdictIdx).filter((e) => (e.payload as { planId?: number }).planId === planId || isBatchOf(e, planId));
  return [...before, ...after].map(pick);
}

function isBatchOf(e: AuditEntry, planId: number): boolean {
  if (e.type !== 'paypal.payout.status') return false;
  const batchId = (e.payload as { batchId?: number }).batchId;
  const rt = firstlight();
  const verdict = rt.pipeline.verdict(planId);
  const batch = verdict ? rt.pipeline.ledger.getBatchByDigest(verdict.digest) : undefined;
  return batch?.id === batchId;
}

export function batchesView() {
  const rt = firstlight();
  const rows = rt.db.prepare('SELECT b.*, p.id AS plan_id FROM payout_batches b LEFT JOIN verdicts v ON v.digest = b.verdict_digest LEFT JOIN plans p ON p.id = v.plan_id ORDER BY b.id DESC').all() as {
    id: number;
    event_id: string;
    plan_version: number;
    paypal_batch_id: string | null;
    status: string;
    created_ms: number;
    plan_id: number | null;
  }[];
  const towns = new Map(rt.registry.map((r) => [r.recipientId, r.town]));
  const webhooks = verifiedWebhookCounts();
  return rows.map((b) => ({
    id: b.id,
    planId: b.plan_id,
    eventId: b.event_id,
    version: b.plan_version,
    paypalBatchId: b.paypal_batch_id,
    status: b.status,
    createdMs: b.created_ms,
    polling: rt.pollers.has(b.id),
    /** PayPal webhook deliveries for this batch that passed verify-webhook-signature. */
    verifiedWebhooks: b.paypal_batch_id ? (webhooks.get(b.paypal_batch_id) ?? 0) : 0,
    items: rt.pipeline.ledger.batchItems(b.id).map((i) => ({
      recipientId: i.recipient_id,
      town: towns.get(i.recipient_id) ?? '',
      amountCents: i.amount_cents,
      status: i.status,
      transactionId: i.transaction_id,
      errorName: i.error_name,
      /** PayPal accepts a cancel only for UNCLAIMED items, by payout_item_id. */
      canCancel: i.status === 'UNCLAIMED' && Boolean(i.paypal_item_id),
    })),
  }));
}

/** Verified webhook deliveries per PayPal batch id, from the audit log (rejected ones are logged separately). */
function verifiedWebhookCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of firstlight().pipeline.audit.entries()) {
    if (e.type !== 'paypal.webhook') continue;
    const id = (e.payload as { payoutBatchId?: unknown }).payoutBatchId;
    if (typeof id === 'string') counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

// ── reconciliation with PayPal ───────────────────────────────────────────────

export type ReconcileView =
  | { configured: false; batches: []; message: string }
  | { configured: true; batches: BatchReconciliation[] };

const RECONCILE_TTL_MS = 30_000;
const RECONCILE_MAX_BATCHES = 10;
const reconcileCache = new Map<string, { at: number; result: Promise<BatchReconciliation> }>();

/**
 * Compare the latest submitted batches with PayPal (read-only). Cached for 30 s per
 * batch state, because every live update on /payouts refetches this view.
 * Never throws: a PayPal failure is reported per batch.
 */
export async function reconcileView(now = Date.now()): Promise<ReconcileView> {
  const rt = firstlight();
  if (!paypalConfigured()) return { configured: false, batches: [], message: 'PayPal sandbox credentials are not set on this server, so nothing can be compared.' };
  let paypal: PayPalClient;
  try {
    paypal = rt.paypal();
  } catch {
    return { configured: false, batches: [], message: 'PayPal sandbox credentials are not usable on this server.' };
  }
  const rows = rt.db.prepare('SELECT * FROM payout_batches WHERE paypal_batch_id IS NOT NULL ORDER BY id DESC LIMIT ?').all(RECONCILE_MAX_BATCHES) as BatchRow[];
  for (const [k, v] of reconcileCache) if (now - v.at > RECONCILE_TTL_MS) reconcileCache.delete(k);
  const batches = await Promise.all(
    rows.map((b) => {
      const input: LedgerBatchInput = {
        batchId: b.id,
        eventId: b.event_id,
        paypalBatchId: b.paypal_batch_id,
        status: b.status,
        createdMs: b.created_ms,
        items: rt.pipeline.ledger.batchItems(b.id).map((i) => ({
          recipientId: i.recipient_id,
          amountCents: i.amount_cents,
          status: i.status,
          paypalItemId: i.paypal_item_id,
          transactionId: i.transaction_id,
        })),
      };
      // Same ledger state → same answer for 30 s. Include the database id so a reset never reuses a result.
      const key = JSON.stringify([instanceId(rt.db), input]);
      const hit = reconcileCache.get(key);
      if (hit) return hit.result;
      const result = reconcileBatch(input, paypal, paypal.reporting(), now);
      reconcileCache.set(key, { at: now, result });
      return result;
    }),
  );
  return { configured: true, batches };
}

export function auditView(limit = 300) {
  const entries = firstlight().pipeline.audit.entries();
  return {
    count: entries.length,
    head: entries.at(-1)?.hash ?? null,
    entries: entries
      .slice(-limit)
      .reverse()
      .map((e) => ({ seq: e.seq, tsMs: e.tsMs, type: e.type, hash: e.hash, prevHash: e.prevHash, payload: e.payload })),
  };
}

export type StateView = ReturnType<typeof stateView>;
export type EventView = ReturnType<typeof eventView>;
export type PlanView = NonNullable<ReturnType<typeof planView>>;
export type BatchView = ReturnType<typeof batchesView>[number];
export type AuditView = ReturnType<typeof auditView>;
