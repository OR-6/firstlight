import { floorPlan } from '../firewall/floor';
import { runAgent, type AgentResult } from '../agent/agent';
import { runSentinel, type SentinelReport } from '../agent/sentinel';
import { evaluatePlan, payableItems } from '../firewall/engine';
import type { FirewallConfig, FirewallContext, Verdict } from '../firewall/types';
import { canonicalJson, sha256Hex } from '../lib/canonical';
import { AuditLog, type AuditEntry } from '../ledger/audit';
import { instanceId, type Db } from '../ledger/db';
import { Ledger, type BatchRow, type ItemStatusUpdate } from '../ledger/ledger';
import type { LlmClient } from '../llm/client';
import { PayPalApiError, type PayPalClient } from '../paypal/client';
import { TERMINAL_BATCH_STATUSES, buildPayoutBatchBody, cancelPayoutItem, createPayoutBatch, getPayoutBatch } from '../paypal/payouts';
import { toCents, type PayPalReporting } from '../paypal/reporting';
import type { PayeeMap } from '../registry/payees';
import { toFirewallRegistry, type RegistryProfile } from '../registry/registry';
import type { CorroborationReport } from '../signals/corroboration';
import { EventStore } from '../signals/event-store';
import type { UntrustedText } from '../signals/untrusted';
import { toFirewallEvent, type SeismicEvent } from '../signals/usgs';

/**
 * The loop (SPEC §13 M2): signal → sentinel → agent → sentinel → firewall →
 * (human approval) → re-check → payout → status. Every step is appended to
 * the hash-chained audit log.
 *
 * Trust boundaries:
 *  - The agent sees AgentWorld only (no emails, ledger, PayPal, secrets).
 *  - Only `execute` sees payee emails and the PayPal client.
 *  - `execute` re-runs the firewall against the current ledger before paying,
 *    and refuses verdicts that were never written to the audit log (R11).
 */
export type PipelineDeps = {
  db: Db;
  llm: LlmClient;
  /** Second-pass sentinel classifier; null disables the LLM layer (regex still runs). */
  sentinelLlm: LlmClient | null;
  registry: readonly RegistryProfile[];
  config: FirewallConfig;
  clock?: () => number;
  agentModel?: string;
  sentinelModel?: string;
  /** Notified after every audit entry (live dashboard). */
  onAudit?: (entry: AuditEntry) => void;
  /** How PayPal idempotency keys are scoped; defaults to `idempotencyScopeFromEnv()`. */
  idempotency?: IdempotencyScope;
};

/**
 * How the payout batch's PayPal-Request-Id and sender_batch_id are derived (D114).
 *
 *  - `database` (the resettable demo): both mix in the database's random instance id
 *    (`meta.instance_id`). The hosted demo's database lives in /tmp and is reset on
 *    restart or by "Reset demo"; without the instance id, the same replayed quake would
 *    produce the same keys and PayPal would answer the new run with the old batch.
 *  - `verdict` (any deployment that is not a resettable demo): both come from the
 *    firewall's `paypalRequestId` alone, which hashes only the event, the recipients and
 *    the amounts. Losing or restoring the database then cannot produce fresh keys for
 *    the same money: PayPal answers a repeated PayPal-Request-Id with the original
 *    batch, and refuses a sender_batch_id used in the last 30 days, so a payout is not
 *    sent twice even if our own record of it is gone.
 *
 * Within one database both scopes give the same answer to the same question: the
 * ledger's UNIQUE constraints and the stored request id stop a second batch either way.
 */
export type IdempotencyScope = 'database' | 'verdict';

/**
 * `FIRSTLIGHT_RESETTABLE_DEMO=true|false` decides; unset, it is true when `DEMO_MODE`
 * is `replay` or unset (the hosted demo) and false otherwise.
 */
export function idempotencyScopeFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): IdempotencyScope {
  const flag = env.FIRSTLIGHT_RESETTABLE_DEMO?.trim().toLowerCase();
  const resettable =
    flag === 'true' || flag === '1' || flag === 'yes'
      ? true
      : flag === 'false' || flag === '0' || flag === 'no'
        ? false
        : !env.DEMO_MODE || env.DEMO_MODE === 'replay';
  return resettable ? 'database' : 'verdict';
}

export type AssessInput = { event: SeismicEvent; corroboration: CorroborationReport; untrusted: readonly UntrustedText[] };

export type Assessment = {
  planId: number;
  eventId: string;
  version: number;
  agent: AgentResult;
  sentinel: SentinelReport;
  verdict: Verdict | null;
};

export class PipelineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

type PlanRow = {
  id: number;
  event_id: string;
  version: number;
  status: string;
  raw_plan: string | null;
  sentinel_json: string;
  corroboration_json: string;
};

export class Pipeline {
  readonly ledger: Ledger;
  readonly audit: AuditLog;
  readonly events: EventStore;
  private readonly clock: () => number;
  private readonly cancelling = new Set<string>();
  /** execute() calls in flight, by verdict digest: a second caller joins the first. */
  private readonly executing = new Map<string, Promise<BatchRow>>();
  /** Status regressions already audited (batch:recipient:from>to), so polling doesn't repeat them. */
  private readonly regressionsSeen = new Set<string>();
  private readonly idempotency: IdempotencyScope;

  constructor(private readonly deps: PipelineDeps) {
    this.clock = deps.clock ?? Date.now;
    this.ledger = new Ledger(deps.db, this.clock);
    this.audit = new AuditLog(deps.db, this.clock, deps.onAudit);
    this.events = new EventStore(deps.db);
    this.idempotency = deps.idempotency ?? idempotencyScopeFromEnv();
  }

  // ── assess ────────────────────────────────────────────────────────────────

  async assess(input: AssessInput, opts: { llm?: LlmClient } = {}): Promise<Assessment> {
    const llm = opts.llm ?? this.deps.llm;
    const stored = this.events.upsert(input.event);
    const event = this.events.get(stored.id) ?? input.event;
    this.audit.append('signal.received', {
      eventId: event.id,
      revision: stored.revision,
      upsert: stored.action,
      mag: event.mag,
      alert: event.alert,
      status: event.status,
      corroboration: { mode: input.corroboration.mode, refs: input.corroboration.observations.map((o) => `${o.source}:${o.ref}`) },
      untrustedTexts: input.untrusted.map((t) => ({ id: t.id, origin: t.origin, chars: t.text.length })),
    });

    const pre = await runSentinel({ untrusted: input.untrusted, llm: this.deps.sentinelLlm, model: this.deps.sentinelModel });
    this.audit.append('sentinel.pre', { eventId: event.id, ...pre });

    const agent = await runAgent(
      { event, corroboration: input.corroboration, untrusted: input.untrusted, registry: this.deps.registry, config: this.deps.config },
      llm,
      { model: this.deps.agentModel },
    );
    this.audit.append('agent.result', {
      eventId: event.id,
      llmMode: llm.mode,
      ok: agent.ok,
      model: agent.model,
      servedBy: agent.ok ? agent.servedBy : null,
      turns: agent.turns,
      reason: agent.ok ? null : agent.reason,
      toolCalls: agent.steps.filter((s) => s.kind === 'tool').map((s) => (s.kind === 'tool' ? `${s.name}${s.isError ? ' (error)' : ''}` : '')),
      rawPlan: agent.ok ? agent.rawPlan : null,
    });

    const post = agent.ok
      ? await runSentinel({ untrusted: [], rawPlan: agent.rawPlan, llm: this.deps.sentinelLlm, model: this.deps.sentinelModel })
      : { injectionSuspected: false, findings: [] };
    if (agent.ok) this.audit.append('sentinel.post', { eventId: event.id, ...post });
    const sentinel: SentinelReport = {
      injectionSuspected: pre.injectionSuspected || post.injectionSuspected,
      findings: [...pre.findings, ...post.findings],
    };

    const version =
      ((this.deps.db.prepare('SELECT MAX(version) AS v FROM plans WHERE event_id = ?').get(event.id) as { v: number | null }).v ?? 0) + 1;
    const now = this.clock();
    const planId = Number(
      this.deps.db
        .prepare(
          `INSERT INTO plans (event_id, version, status, raw_plan, agent_json, sentinel_json, corroboration_json, llm_mode, created_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          version,
          agent.ok ? 'assessed' : 'agent_failed',
          agent.ok ? JSON.stringify(agent.rawPlan) : null,
          JSON.stringify({ model: agent.model, turns: agent.turns, steps: agent.steps, reason: agent.ok ? null : agent.reason }),
          JSON.stringify(sentinel),
          JSON.stringify(input.corroboration),
          llm.mode,
          now,
        ).lastInsertRowid,
    );

    if (!agent.ok) return { planId, eventId: event.id, version, agent, sentinel, verdict: null };

    const verdict = evaluatePlan(agent.rawPlan, this.context(event, input.corroboration, sentinel, now));
    this.deps.db
      .prepare('INSERT INTO verdicts (plan_id, digest, overall, verdict_json, created_ms) VALUES (?, ?, ?, ?, ?)')
      .run(planId, verdict.digest, verdict.overall, JSON.stringify(verdict), now);
    // R11: the verdict is logged before anything can act on it.
    this.audit.append('firewall.verdict', {
      planId,
      eventId: event.id,
      version,
      digest: verdict.digest,
      overall: verdict.overall,
      totalCents: verdict.totalCents,
      paypalRequestId: verdict.paypalRequestId,
      planRules: verdict.planRules,
      items: verdict.items.map((i) => ({ recipientId: i.recipientId, verdict: i.verdict, amountCents: i.amountCents, rules: i.ruleTrace.filter((r) => r.scope === 'item') })),
    });
    return { planId, eventId: event.id, version, agent, sentinel, verdict };
  }

  // ── approvals ─────────────────────────────────────────────────────────────

  decide(planId: number, decision: 'approve' | 'deny', approver: string, reason: string): void {
    const verdict = this.verdict(planId);
    if (!verdict) throw new PipelineError('NO_VERDICT', `plan ${planId} has no verdict`);
    if (verdict.overall !== 'REQUIRE_APPROVAL') throw new PipelineError('NOT_PENDING', `plan ${planId} is ${verdict.overall}, nothing to approve`);
    if (!approver.trim() || !reason.trim()) throw new PipelineError('APPROVAL_INCOMPLETE', 'approver and reason are required');
    try {
      this.deps.db
        .prepare('INSERT INTO approvals (plan_id, decision, approver, reason, decided_ms) VALUES (?, ?, ?, ?, ?)')
        .run(planId, decision, approver.trim().slice(0, 100), reason.trim().slice(0, 1000), this.clock());
    } catch {
      throw new PipelineError('ALREADY_DECIDED', `plan ${planId} already has a decision`);
    }
    this.audit.append('approval.decided', { planId, digest: verdict.digest, decision, approver: approver.trim(), reason: reason.trim() });
  }

  // ── execute ───────────────────────────────────────────────────────────────

  /**
   * `opts.reporting` defaults to `paypal.reporting()` (Transaction Search via the
   * Server SDK). Pass `null` to skip the PayPal balance check entirely.
   */
  async execute(planId: number, paypal: PayPalClient, payees: PayeeMap, opts: { reporting?: PayPalReporting | null } = {}): Promise<BatchRow> {
    const plan = this.planRow(planId);
    const verdict = this.verdict(planId);
    if (!plan || !verdict || plan.raw_plan === null) throw new PipelineError('NO_VERDICT', `plan ${planId} has no verdict`);
    if (verdict.overall === 'BLOCK') throw new PipelineError('BLOCKED', 'firewall blocked this plan');
    if (verdict.overall === 'REQUIRE_APPROVAL') {
      const a = this.approval(planId);
      if (!a) throw new PipelineError('NEEDS_APPROVAL', 'plan requires human approval');
      if (a.decision !== 'approve') throw new PipelineError('DENIED', `plan was denied by ${a.approver}`);
    }
    if (!this.audit.hasVerdict(verdict.digest)) throw new PipelineError('NOT_AUDITED', 'verdict missing from audit log (R11)');

    // Two clicks, a retry and the poller can ask for the same money at once. In this
    // process the second caller waits for the first and gets the same batch; across
    // processes the ledger's UNIQUE constraints and the shared PayPal-Request-Id hold.
    const inflight = this.executing.get(verdict.digest);
    if (inflight) return inflight;
    const run = this.submit(planId, plan, verdict, paypal, payees, opts);
    this.executing.set(verdict.digest, run);
    try {
      return await run;
    } finally {
      this.executing.delete(verdict.digest);
    }
  }

  private async submit(planId: number, plan: PlanRow, verdict: Verdict, paypal: PayPalClient, payees: PayeeMap, opts: { reporting?: PayPalReporting | null }): Promise<BatchRow> {
    if (plan.raw_plan === null) throw new PipelineError('NO_VERDICT', `plan ${planId} has no verdict`);
    const existing = this.ledger.getBatchByDigest(verdict.digest);
    // RESERVED means we never heard back (crash or throw before PayPal answered); resend
    // with the stored PayPal-Request-Id, which PayPal de-duplicates.
    const resend = existing?.status === 'SUBMIT_UNKNOWN' || existing?.status === 'RESERVED';
    if (existing && !resend) return existing;

    // Every payee must be known, for a resend too: the body below is built from this map.
    const payable = payableItems(verdict);
    const missing = payable.filter((i) => !payees.has(i.recipientId)).map((i) => i.recipientId);
    // Nothing is written: the batch keeps its state and can be resent once the payee map is fixed.
    if (missing.length > 0) throw new PipelineError('NO_PAYEE', `no sandbox payee for ${missing.join(', ')}`);

    let batch = existing;
    if (!batch) {
      // Re-check against the ledger as it is NOW: approval may have been hours ago.
      const event = this.events.get(plan.event_id);
      if (!event) throw new PipelineError('NO_EVENT', `event ${plan.event_id} not stored`);
      const fresh = evaluatePlan(
        JSON.parse(plan.raw_plan) as unknown,
        this.context(event, JSON.parse(plan.corroboration_json) as CorroborationReport, JSON.parse(plan.sentinel_json) as SentinelReport, this.clock()),
      );
      const key = (v: Verdict) => payableItems(v).map((i) => `${i.recipientId}:${i.amountCents}`).sort().join(',');
      const nowNeedsApproval = fresh.overall === 'REQUIRE_APPROVAL' && verdict.overall === 'ALLOW';
      if (fresh.overall === 'BLOCK' || nowNeedsApproval || key(fresh) !== key(verdict) || fresh.paypalRequestId !== verdict.paypalRequestId) {
        this.audit.append('execute.refused', { planId, digest: verdict.digest, reason: 'STATE_CHANGED', freshOverall: fresh.overall, freshDigest: fresh.digest });
        throw new PipelineError('STATE_CHANGED', 'ledger changed since this verdict; reassess the event');
      }
      const items = payable;
      const totalCents = items.reduce((t, i) => t + i.amountCents, 0);
      // The pool ledger is the policy source of truth; PayPal's own balance is a second
      // check that the money is really there. Unknown (no scope, network) never blocks.
      const balance = await checkPayPalBalance(opts.reporting === undefined ? paypal.reporting() : opts.reporting);
      if (balance.checked && balance.availableCents < totalCents) {
        this.audit.append('execute.refused', { planId, digest: verdict.digest, reason: 'PAYPAL_BALANCE_LOW', neededCents: totalCents, paypalBalance: balance });
        throw new PipelineError('PAYPAL_BALANCE_LOW', `PayPal sandbox balance ${balance.availableCents} cents is below the batch total ${totalCents} cents`);
      }
      let batchId: number;
      try {
        ({ batchId } = this.ledger.reservePayoutBatch({
          eventId: plan.event_id,
          planVersion: plan.version,
          paypalRequestId: this.payoutRequestId(verdict),
          verdictDigest: verdict.digest,
          items: items.map((i) => ({ recipientId: i.recipientId, amountCents: i.amountCents })),
        }));
      } catch (err) {
        // Another version of this event's plan reserved the same households (or the same batch) while we
        // awaited PayPal's balance: the database's UNIQUE constraints refused it. Nothing was written.
        const e = err as { code?: unknown; message?: unknown };
        const dup =
          e.code === 'SQLITE_CONSTRAINT_UNIQUE' && typeof e.message === 'string' && /payout_items\.event_id|payout_items\.recipient_id|payout_batches\.paypal_request_id/.test(e.message);
        if (!dup) throw err;
        this.audit.append('execute.refused', { planId, digest: verdict.digest, reason: 'ALREADY_PAID' });
        throw new PipelineError('ALREADY_PAID', `households in plan ${planId} were already reserved or paid for event ${plan.event_id} by another plan version`);
      }
      this.audit.append('payout.reserved', { planId, batchId, digest: verdict.digest, totalCents: verdict.totalCents, items: items.length, paypalBalance: balance });
      batch = this.ledger.getBatch(batchId)!;
    }

    const items = payable;
    const body = buildPayoutBatchBody({
      senderBatchId: this.senderBatchId(batch),
      emailSubject: 'Emergency relief payment (SANDBOX)',
      emailMessage: 'This is an automatic relief payment from the Firstlight sandbox demo. No real money moves.',
      items: items.map((i) => ({
        receiverEmail: payees.get(i.recipientId) as string, // checked above
        amountCents: i.amountCents,
        note: i.note,
        senderItemId: `${plan.event_id}:${i.recipientId}`,
      })),
    });
    try {
      const res = await createPayoutBatch(paypal, body, batch.paypal_request_id);
      this.ledger.setBatchStatus(batch.id, res.body.batch_header.batch_status, res.body.batch_header.payout_batch_id);
      this.audit.append('paypal.payout.created', {
        planId,
        batchId: batch.id,
        paypalBatchId: res.body.batch_header.payout_batch_id,
        batchStatus: res.body.batch_header.batch_status,
        debugId: res.debugId,
        request: maskReceivers(body),
      });
    } catch (err) {
      // On a resend, the first attempt's outcome is still unknown, so no error is definitive.
      // Nor is PayPal saying it already has this batch (a sender_batch_id or request id used
      // before, e.g. after the database was lost): that money may have left, so it stays reserved.
      const duplicate = err instanceof PayPalApiError && /DUPLICATE|ALREADY_USED/i.test(err.paypalName ?? '');
      const definitive = !resend && !duplicate && err instanceof PayPalApiError && err.status >= 400 && err.status < 500 && err.status !== 409 && err.status !== 429;
      if (definitive) {
        for (const i of items) this.ledger.setItemStatus(plan.event_id, i.recipientId, 'FAILED');
        this.ledger.setBatchStatus(batch.id, 'FAILED');
      } else {
        // Unknown outcome: safe to retry later with the same PayPal-Request-Id.
        this.ledger.setBatchStatus(batch.id, 'SUBMIT_UNKNOWN');
      }
      this.audit.append('paypal.payout.error', {
        planId,
        batchId: batch.id,
        definitive,
        ...(duplicate ? { duplicateAtPayPal: true } : {}),
        message: (err as Error).message,
        debugId: err instanceof PayPalApiError ? err.debugId : null,
      });
      throw err;
    }
    return this.ledger.getBatch(batch.id)!;
  }

  // ── status ────────────────────────────────────────────────────────────────

  async poll(batchId: number, paypal: PayPalClient): Promise<{ batch: BatchRow; terminal: boolean; items: { recipientId: string; status: string }[] }> {
    const batch = this.ledger.getBatch(batchId);
    if (!batch?.paypal_batch_id) throw new PipelineError('NOT_SUBMITTED', `batch ${batchId} has no PayPal batch id`);
    const { body } = await getPayoutBatch(paypal, batch.paypal_batch_id);
    const changes: { recipientId: string; from: string; to: string; unknown: boolean }[] = [];
    const regressions: { recipientId: string; stored: string; reported: string; raw: string; unknown: boolean }[] = [];
    const current = new Map(this.ledger.batchItems(batchId).map((r) => [r.recipient_id, r.status]));
    for (const it of body.items ?? []) {
      const sid = it.payout_item.sender_item_id ?? '';
      const [eventId, recipientId] = sid.split(':');
      if (eventId !== batch.event_id || !recipientId || !current.has(recipientId)) continue;
      const norm = this.ledger.setItemStatus(eventId, recipientId, it.transaction_status);
      if (!norm.applied) {
        // A stale or out-of-order answer: keep what we have, and say so once per process.
        const key = `${batchId}:${recipientId}:${norm.from}>${norm.reported}`;
        if (!this.regressionsSeen.has(key)) {
          this.regressionsSeen.add(key);
          regressions.push({ recipientId, stored: norm.from, reported: norm.reported, raw: String(it.transaction_status ?? '').slice(0, 40), unknown: norm.unknown });
        }
        continue; // PayPal's ids and error name in a stale answer are stale too
      }
      this.ledger.setItemDetails(eventId, recipientId, { paypalItemId: it.payout_item_id, transactionId: it.transaction_id, errorName: it.errors?.name ?? null });
      if (current.get(recipientId) !== norm.status) changes.push({ recipientId, from: current.get(recipientId)!, to: norm.status, unknown: norm.unknown });
      if (norm.bookedCents < 0) this.auditRedebit(batchId, recipientId, norm);
    }
    const reportedBatch = body.batch_header.batch_status;
    // Re-read after the await: the poller and webhooks can poll the same batch concurrently.
    const before = this.ledger.getBatch(batchId)!.status;
    // A finished batch doesn't go back to PENDING or PROCESSING either.
    const isTerminal = (s: string) => (TERMINAL_BATCH_STATUSES as readonly string[]).includes(s);
    const staleBatch = isTerminal(before) && !isTerminal(reportedBatch);
    const status = staleBatch ? before : reportedBatch;
    const batchKey = `${batchId}:batch:${before}>${reportedBatch}`;
    const auditBatch = staleBatch && !this.regressionsSeen.has(batchKey);
    if (auditBatch) this.regressionsSeen.add(batchKey);
    if (regressions.length > 0 || auditBatch) {
      this.audit.append('paypal.payout.status_regression_ignored', {
        batchId,
        paypalBatchId: batch.paypal_batch_id,
        ...(auditBatch ? { batch: { stored: before, reported: String(reportedBatch).slice(0, 40) } } : {}),
        items: regressions,
      });
    }
    if (status !== before) this.ledger.setBatchStatus(batchId, status);
    if (changes.length > 0 || status !== before) {
      this.audit.append('paypal.payout.status', { batchId, paypalBatchId: batch.paypal_batch_id, batchStatus: status, changes });
    }
    // PayPal's fee for the batch comes out of the same PayPal balance as the payouts, so
    // the pool pays it too (once per batch; a changed total books only the difference).
    // Batches are USD only; a fee in another currency would show up in reconciliation.
    const fees = body.batch_header.fees;
    const feeCents = fees && fees.currency === 'USD' ? toCents(fees.value) : null;
    if (feeCents !== null && feeCents >= 0) {
      const fee = this.ledger.bookPayoutFee(batch.paypal_batch_id, feeCents);
      if (fee.bookedCents !== 0) {
        this.audit.append('payout.fee_booked', {
          batchId,
          paypalBatchId: batch.paypal_batch_id,
          feeCents: fee.totalFeeCents,
          bookedCents: fee.bookedCents,
          poolBalanceCents: fee.balanceAfterCents,
          ...(fee.balanceAfterCents < 0 ? { flag: 'POOL_NEGATIVE' } : {}),
        });
      }
    }
    const items = this.ledger.batchItems(batchId).map((r) => ({ recipientId: r.recipient_id, status: r.status }));
    const terminal = isTerminal(status) && items.every((i) => i.status !== 'PENDING' && i.status !== 'RESERVED');
    return { batch: this.ledger.getBatch(batchId)!, terminal, items };
  }

  // ── return path ───────────────────────────────────────────────────────────

  /**
   * Operator action: cancel one UNCLAIMED payout item at PayPal. PayPal sends the
   * money back to the sender and answers with the item's new status (RETURNED);
   * the ledger books that through the usual status path, which re-credits the
   * pool exactly once. Refused unless the ledger has the item as UNCLAIMED with
   * PayPal's payout_item_id.
   */
  async cancelItem(batchId: number, recipientId: string, paypal: PayPalClient, by = 'console'): Promise<{ recipientId: string; status: string; paypalItemId: string }> {
    const batch = this.ledger.getBatch(batchId);
    const item = batch ? this.ledger.batchItems(batchId).find((i) => i.recipient_id === recipientId) : undefined;
    if (!batch || !item) throw new PipelineError('NO_ITEM', `batch ${batchId} has no item for ${recipientId}`);
    if (item.status !== 'UNCLAIMED') throw new PipelineError('NOT_UNCLAIMED', `item is ${item.status}; only UNCLAIMED items can be cancelled`);
    if (!item.paypal_item_id) throw new PipelineError('NO_PAYPAL_ITEM', 'PayPal has not reported a payout_item_id for this item yet');
    const key = `${batchId}:${recipientId}`;
    if (this.cancelling.has(key)) throw new PipelineError('IN_PROGRESS', 'this item is already being cancelled');
    this.cancelling.add(key);
    try {
      let res: Awaited<ReturnType<typeof cancelPayoutItem>>;
      try {
        res = await cancelPayoutItem(paypal, item.paypal_item_id);
      } catch (err) {
        this.audit.append('paypal.payout.item.cancel_failed', {
          batchId,
          recipientId,
          paypalItemId: item.paypal_item_id,
          by,
          message: (err as Error).message.slice(0, 300),
          debugId: err instanceof PayPalApiError ? err.debugId : null,
        });
        // PayPal may have refused because the item moved on (claimed, already returned): re-read it.
        if (batch.paypal_batch_id) await this.poll(batchId, paypal).catch(() => undefined);
        throw err;
      }
      const from = item.status;
      // Book exactly what PayPal answered; no status in the answer leaves the item as it was.
      const norm = this.ledger.setItemStatus(item.event_id, recipientId, res.body.transaction_status ?? item.status);
      this.ledger.setItemDetails(item.event_id, recipientId, {
        paypalItemId: res.body.payout_item_id,
        transactionId: res.body.transaction_id,
        errorName: res.body.errors?.name ?? null,
      });
      if (norm.bookedCents < 0) this.auditRedebit(batchId, recipientId, norm);
      this.audit.append('paypal.payout.item.canceled', {
        batchId,
        paypalBatchId: batch.paypal_batch_id,
        recipientId,
        paypalItemId: item.paypal_item_id,
        by,
        from,
        to: norm.status,
        transactionStatus: res.body.transaction_status ?? null,
        unknownStatus: norm.unknown,
        // PayPal answered with a status the item can't move to from UNCLAIMED: nothing was booked.
        ...(norm.applied ? {} : { regressionIgnored: true, reported: norm.reported }),
        debugId: res.debugId,
      });
      return { recipientId, status: norm.status, paypalItemId: item.paypal_item_id };
    } finally {
      this.cancelling.delete(key);
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** Exactly what the agent submitted for a plan (untrusted JSON), or null. */
  planRaw(planId: number): string | null {
    return this.planRow(planId)?.raw_plan ?? null;
  }

  verdict(planId: number): Verdict | null {
    const row = this.deps.db.prepare('SELECT verdict_json FROM verdicts WHERE plan_id = ?').get(planId) as { verdict_json: string } | undefined;
    return row ? (JSON.parse(row.verdict_json) as Verdict) : null;
  }

  approval(planId: number): { decision: string; approver: string; reason: string } | null {
    return (this.deps.db.prepare('SELECT decision, approver, reason FROM approvals WHERE plan_id = ?').get(planId) as
      | { decision: string; approver: string; reason: string }
      | undefined) ?? null;
  }

  /**
   * Draft the firewall's own plan for the same event as `fromPlanId` (D91): everyone owed,
   * at their band, decided by deterministic code. Closes the denial-of-aid gap where a
   * poisoned feed makes the agent hold, forge an event id or leave households out. The
   * new plan always needs a person (decision `escalate`) and carries the source plan's
   * sentinel findings so the reviewer sees why it exists.
   */
  draftFloorPlan(fromPlanId: number): { planId: number; verdict: Verdict } {
    const source = this.planRow(fromPlanId);
    if (!source) throw new PipelineError('NO_VERDICT', `plan ${fromPlanId} not found`);
    const event = this.events.get(source.event_id);
    if (!event) throw new PipelineError('NO_EVENT', `event ${source.event_id} not stored`);
    const corroboration = JSON.parse(source.corroboration_json) as CorroborationReport;
    const sentinel = JSON.parse(source.sentinel_json) as SentinelReport;
    const now = this.clock();
    const ctx = this.context(event, corroboration, sentinel, now);
    const prior = this.verdict(fromPlanId);
    const why = prior
      ? prior.planRules.filter((r) => r.status !== 'pass').map((r) => r.reasonCode).join(', ') || 'requested by a reviewer'
      : 'the agent produced no valid plan';
    const raw = floorPlan(ctx, `plan ${fromPlanId} was ${prior?.overall ?? 'not assessable'} (${why}).`);
    if (raw.items.length === 0) throw new PipelineError('NOTHING_OWED', 'no enrolled household is owed a payout for this event');
    const version =
      ((this.deps.db.prepare('SELECT MAX(version) AS v FROM plans WHERE event_id = ?').get(event.id) as { v: number | null }).v ?? 0) + 1;
    const planId = Number(
      this.deps.db
        .prepare(
          `INSERT INTO plans (event_id, version, status, raw_plan, agent_json, sentinel_json, corroboration_json, llm_mode, created_ms)
           VALUES (?, ?, 'assessed', ?, ?, ?, ?, 'firewall', ?)`,
        )
        .run(
          event.id,
          version,
          JSON.stringify(raw),
          JSON.stringify({ model: 'firewall floor plan (deterministic, no LLM)', turns: 0, steps: [], reason: null, fromPlanId }),
          JSON.stringify(sentinel),
          JSON.stringify(corroboration),
          now,
        ).lastInsertRowid,
    );
    this.audit.append('plan.floor_drafted', { planId, fromPlanId, eventId: event.id, version, households: raw.items.length, reason: why });
    const verdict = evaluatePlan(raw, ctx);
    this.deps.db
      .prepare('INSERT INTO verdicts (plan_id, digest, overall, verdict_json, created_ms) VALUES (?, ?, ?, ?, ?)')
      .run(planId, verdict.digest, verdict.overall, JSON.stringify(verdict), now);
    this.audit.append('firewall.verdict', {
      planId,
      eventId: event.id,
      version,
      digest: verdict.digest,
      overall: verdict.overall,
      totalCents: verdict.totalCents,
      paypalRequestId: verdict.paypalRequestId,
      planRules: verdict.planRules,
      items: verdict.items.map((i) => ({ recipientId: i.recipientId, verdict: i.verdict, amountCents: i.amountCents, rules: i.ruleTrace.filter((r) => r.scope === 'item') })),
    });
    return { planId, verdict };
  }

  /** An item's money left the pool again after it had been credited back (see Ledger.setItemStatus). */
  private auditRedebit(batchId: number, recipientId: string, u: ItemStatusUpdate): void {
    this.audit.append('payout.item_redebited', {
      batchId,
      recipientId,
      from: u.from,
      to: u.status,
      cents: -u.bookedCents,
      poolBalanceCents: u.balanceAfterCents,
      ...(u.balanceAfterCents < 0 ? { flag: 'POOL_NEGATIVE' } : {}),
    });
  }

  /** PayPal-Request-Id for a new batch: same money → same key (scope: see IdempotencyScope). */
  private payoutRequestId(verdict: Verdict): string {
    if (this.idempotency === 'verdict') {
      if (!verdict.paypalRequestId) throw new PipelineError('NO_VERDICT', 'verdict has nothing payable');
      return verdict.paypalRequestId;
    }
    return sha256Hex(canonicalJson({ instance: instanceId(this.deps.db), firewall: verdict.paypalRequestId }));
  }

  /**
   * sender_batch_id, which PayPal refuses to reuse for 30 days. Built from the stored
   * batch (not the plan being executed) so a resend through another plan version with
   * the same verdict sends the same id as the first attempt.
   */
  private senderBatchId(batch: BatchRow): string {
    // In verdict scope the stored request id is the firewall's paypalRequestId itself.
    if (this.idempotency === 'verdict') return `firstlight-${batch.event_id}-${batch.paypal_request_id.slice(0, 32)}`;
    return `firstlight-${batch.event_id}-v${batch.plan_version}-${instanceId(this.deps.db).slice(0, 8)}`;
  }

  private planRow(planId: number): PlanRow | undefined {
    return this.deps.db.prepare('SELECT * FROM plans WHERE id = ?').get(planId) as PlanRow | undefined;
  }

  private context(event: SeismicEvent, corroboration: CorroborationReport, sentinel: SentinelReport, now: number): FirewallContext {
    return {
      event: toFirewallEvent(event),
      corroboration: corroboration.observations.map(({ source, independent, mag, epicentre, time }) => ({ source, independent, mag, epicentre, time })),
      registry: toFirewallRegistry(this.deps.registry),
      ledger: this.ledger.snapshot(),
      sentinel: {
        injectionSuspected: sentinel.injectionSuspected,
        findings: sentinel.findings.map((f) => `${f.target}: ${f.rule}`),
      },
      now,
      config: this.deps.config,
    };
  }

  // ── dry run (MCP check_payout_plan) ───────────────────────────────────────

  /**
   * Run the firewall on any payout plan, against the live registry, the ledger
   * as it is now and the stored event, the same way `assess` does. Stores
   * nothing, writes no audit entry, calls no LLM and no PayPal. Corroboration
   * and the feed's sentinel findings come from the event's latest assessment;
   * the plan's own text goes through the regex sentinel.
   */
  async dryRun(rawPlan: unknown): Promise<{ verdict: Verdict; ctx: FirewallContext; basis: { assessedPlanId: number | null } }> {
    const eventId = rawPlan && typeof rawPlan === 'object' ? (rawPlan as { eventId?: unknown }).eventId : undefined;
    if (typeof eventId !== 'string' || !eventId) throw new PipelineError('NO_EVENT', 'the plan has no eventId');
    const event = this.events.get(eventId);
    if (!event) throw new PipelineError('NO_EVENT', `event ${eventId} not stored`);
    const latest = this.deps.db.prepare('SELECT id, sentinel_json, corroboration_json FROM plans WHERE event_id = ? ORDER BY id DESC LIMIT 1').get(event.id) as
      | { id: number; sentinel_json: string; corroboration_json: string }
      | undefined;
    const corroboration: CorroborationReport = latest
      ? (JSON.parse(latest.corroboration_json) as CorroborationReport)
      : { mode: 'none', observations: [], note: 'not assessed yet' };
    const feed = latest ? (JSON.parse(latest.sentinel_json) as SentinelReport).findings.filter((f) => f.target.startsWith('untrusted:')) : [];
    const own = await runSentinel({ untrusted: [], rawPlan, llm: null });
    const findings = [...feed, ...own.findings];
    const ctx = this.context(event, corroboration, { injectionSuspected: findings.length > 0, findings }, this.clock());
    return { verdict: evaluatePlan(rawPlan, ctx), ctx, basis: { assessedPlanId: latest?.id ?? null } };
  }
}

/** Audit entries show which payee got paid without exposing full addresses. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 4)}…${local.slice(-3)}@${domain}`;
}

function maskReceivers(body: ReturnType<typeof buildPayoutBatchBody>) {
  return { ...body, items: body.items.map((i) => ({ ...i, receiver: maskEmail(i.receiver) })) };
}

/** What the executor learned about the PayPal account balance (recorded in the audit log). */
export type PayPalBalanceCheck =
  | { checked: true; availableCents: number; totalCents: number; asOf: string | null }
  | { checked: false; reason: 'SKIPPED' | 'MISSING_SCOPE' | 'UNAVAILABLE'; detail: string };

/** Ask PayPal for the USD balance. Never throws: anything but a clear answer is "not checked". */
export async function checkPayPalBalance(reporting: PayPalReporting | null): Promise<PayPalBalanceCheck> {
  if (!reporting) return { checked: false, reason: 'SKIPPED', detail: 'No reporting client given.' };
  try {
    const b = await reporting.usdBalance();
    if (!b.available) return { checked: false, reason: b.reason, detail: b.detail };
    return { checked: true, availableCents: b.availableCents, totalCents: b.totalCents, asOf: b.asOf };
  } catch (err) {
    return { checked: false, reason: 'UNAVAILABLE', detail: String((err as Error)?.message ?? err).slice(0, 160) };
  }
}
