import 'server-only';
import type { SentinelReport } from '../agent/sentinel';
import { paypalConfigured, type PayPalClient } from '../paypal/client';
import { reconcileBatch, type BatchReconciliation, type LedgerBatchInput } from '../paypal/reconcile';
import { RecordedBatchChecker, type RecordedView } from '../paypal/recorded';
import { UNCLAIMED_RETURN_MS, batchClock } from '../paypal/timings';
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

/** The batch table as the audit filters need it: local id, plan, PayPal's id. */
function batchRefs(): BatchRef[] {
  const rows = firstlight()
    .db.prepare('SELECT b.id, b.paypal_batch_id, p.id AS plan_id FROM payout_batches b LEFT JOIN verdicts v ON v.digest = b.verdict_digest LEFT JOIN plans p ON p.id = v.plan_id')
    .all() as { id: number; paypal_batch_id: string | null; plan_id: number | null }[];
  return rows.map((r) => ({ id: r.id, planId: r.plan_id, paypalBatchId: r.paypal_batch_id }));
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
  const entries = rt.pipeline.audit.entries();
  const refs: BatchRef[] = rows.map((b) => ({ id: b.id, planId: b.plan_id, paypalBatchId: b.paypal_batch_id }));
  return rows.map((b) => {
    const items = rt.pipeline.ledger.batchItems(b.id);
    const clock = batchClock(entries, { planId: b.plan_id, batchId: b.id, paypalBatchId: b.paypal_batch_id, recipientIds: items.map((i) => i.recipient_id) });
    // PayPal returns an unclaimed payout 30 days after the batch; counted from when PayPal accepted it.
    const returnsMs = (clock.sentMs ?? b.created_ms) + UNCLAIMED_RETURN_MS;
    return {
      id: b.id,
      planId: b.plan_id,
      eventId: b.event_id,
      version: b.plan_version,
      paypalBatchId: b.paypal_batch_id,
      status: b.status,
      createdMs: b.created_ms,
      polling: rt.pollers.has(b.id),
      /** PayPal webhook deliveries for this batch that passed verify-webhook-signature (rejected ones are logged separately). */
      verifiedWebhooks: clock.webhooks,
      /** PayPal's fee for this batch as booked in the pool ledger (0 until PayPal reports one). */
      feesCents: b.paypal_batch_id ? rt.pipeline.ledger.payoutFeeCents(b.paypal_batch_id) : 0,
      /** Measured from audit timestamps: assessed → approved → sent to PayPal → all items final. */
      clock,
      /** This batch's own audit entries, oldest first: money reserved, sent to PayPal, webhooks, status updates, fees. */
      audit: filterAudit(entries, refs, { batch: String(b.id) }).map((e) => ({ seq: e.seq, type: e.type, tsMs: e.tsMs })),
      items: items.map((i) => ({
        recipientId: i.recipient_id,
        town: towns.get(i.recipient_id) ?? '',
        amountCents: i.amount_cents,
        status: i.status,
        transactionId: i.transaction_id,
        errorName: i.error_name,
        /** PayPal accepts a cancel only for UNCLAIMED items, by payout_item_id. */
        canCancel: i.status === 'UNCLAIMED' && Boolean(i.paypal_item_id),
        /** When PayPal sends an UNCLAIMED payout back on its own. */
        autoReturnMs: i.status === 'UNCLAIMED' ? returnsMs : null,
      })),
    };
  });
}

// ── recorded sandbox runs, read back from PayPal ─────────────────────────────

const g = globalThis as unknown as { __firstlightRecorded?: RecordedBatchChecker };

/**
 * The batches listed under "Runs already made in the PayPal sandbox", as PayPal
 * reports them now: read-only GETs, cached 10 minutes, at most 8 a minute, one
 * refresh at a time. Independent of the demo database, so a reset keeps the cache.
 * Never throws; a PayPal problem is reported per batch.
 */
export function recordedBatchesView(): Promise<RecordedView> {
  g.__firstlightRecorded ??= new RecordedBatchChecker(() => (paypalConfigured() ? firstlight().paypal() : null));
  return g.__firstlightRecorded.view();
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

// ── audit log, optionally filtered ──────────────────────────────────────────

export type BatchRef = { id: number; planId: number | null; paypalBatchId: string | null };

/** Narrow the audit log to one plan, one batch (our id or PayPal's) or some event types. Every part given must match. */
export type AuditFilter = { plan?: number; batch?: string; types?: readonly string[] };

/**
 * Pure: the plan and batch an audit entry belongs to. Read from its payload
 * (planId, batchId, paypalBatchId, or payoutBatchId on a webhook) and filled
 * in from the batch table, so a status update or webhook that names only the
 * batch still counts for its plan.
 */
export function auditRefs(e: Pick<AuditEntry, 'payload'>, batches: readonly BatchRef[]): { planId: number | null; batchId: number | null; paypalBatchId: string | null } {
  const p = (e.payload && typeof e.payload === 'object' ? e.payload : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : null);
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const ownBatchId = num(p.batchId);
  const ownPayPal = str(p.paypalBatchId) ?? str(p.payoutBatchId);
  const batch = (ownBatchId !== null ? batches.find((b) => b.id === ownBatchId) : undefined) ?? (ownPayPal ? batches.find((b) => b.paypalBatchId === ownPayPal) : undefined);
  return {
    planId: num(p.planId) ?? batch?.planId ?? null,
    batchId: batch?.id ?? ownBatchId,
    paypalBatchId: ownPayPal ?? batch?.paypalBatchId ?? null,
  };
}

/** A type filter part: an exact type, or a prefix written as `paypal.*`. */
function typeMatches(type: string, wanted: readonly string[]): boolean {
  return wanted.some((w) => (w.endsWith('.*') ? type.startsWith(w.slice(0, -1)) : type === w));
}

/** Pure: the entries that match every part of the filter, in the order given. */
export function filterAudit<E extends Pick<AuditEntry, 'type' | 'payload'>>(entries: readonly E[], batches: readonly BatchRef[], f: AuditFilter): E[] {
  const batchNum = f.batch !== undefined && /^[0-9]+$/.test(f.batch) ? Number(f.batch) : null;
  return entries.filter((e) => {
    if (f.types?.length && !typeMatches(e.type, f.types)) return false;
    if (f.plan === undefined && f.batch === undefined) return true;
    const r = auditRefs(e, batches);
    if (f.plan !== undefined && r.planId !== f.plan) return false;
    if (f.batch !== undefined && r.paypalBatchId !== f.batch && (batchNum === null || r.batchId !== batchNum)) return false;
    return true;
  });
}

/** Newest first. With a filter, `count` is still the whole log and `matched` the entries that match. Read-only. */
export function auditView(limit = 300, filter: AuditFilter = {}) {
  const entries = firstlight().pipeline.audit.entries();
  const filtered = filter.plan !== undefined || filter.batch !== undefined || Boolean(filter.types?.length);
  const picked = filtered ? filterAudit(entries, batchRefs(), filter) : entries;
  return {
    count: entries.length,
    head: entries.at(-1)?.hash ?? null,
    filter: filtered ? { plan: filter.plan ?? null, batch: filter.batch ?? null, types: [...(filter.types ?? [])] } : null,
    matched: picked.length,
    entries: picked
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
