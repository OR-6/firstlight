import { floorPlan } from '../firewall/floor';
import { runAgent, type AgentResult } from '../agent/agent';
import { runSentinel, type SentinelReport } from '../agent/sentinel';
import { evaluatePlan, payableItems } from '../firewall/engine';
import type { FirewallConfig, FirewallContext, Verdict } from '../firewall/types';
import { canonicalJson, sha256Hex } from '../lib/canonical';
import { AuditLog, type AuditEntry } from '../ledger/audit';
import { instanceId, type Db } from '../ledger/db';
import { Ledger, type BatchRow } from '../ledger/ledger';
import type { LlmClient } from '../llm/client';
import { PayPalApiError, type PayPalClient } from '../paypal/client';
import { TERMINAL_BATCH_STATUSES, buildPayoutBatchBody, createPayoutBatch, getPayoutBatch } from '../paypal/payouts';
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
};

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

  constructor(private readonly deps: PipelineDeps) {
    this.clock = deps.clock ?? Date.now;
    this.ledger = new Ledger(deps.db, this.clock);
    this.audit = new AuditLog(deps.db, this.clock, deps.onAudit);
    this.events = new EventStore(deps.db);
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

  async execute(planId: number, paypal: PayPalClient, payees: PayeeMap): Promise<BatchRow> {
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

    const existing = this.ledger.getBatchByDigest(verdict.digest);
    // RESERVED means we never heard back (crash or throw before PayPal answered); resend
    // with the stored PayPal-Request-Id, which PayPal de-duplicates.
    const resend = existing?.status === 'SUBMIT_UNKNOWN' || existing?.status === 'RESERVED';
    if (existing && !resend) return existing;

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
      const items = payableItems(verdict);
      const missing = items.filter((i) => !payees.has(i.recipientId)).map((i) => i.recipientId);
      if (missing.length > 0) throw new PipelineError('NO_PAYEE', `no sandbox payee for ${missing.join(', ')}`);
      const { batchId } = this.ledger.reservePayoutBatch({
        eventId: plan.event_id,
        planVersion: plan.version,
        // Same money → same key within this database; a fresh database (demo reset) gets fresh keys.
        paypalRequestId: sha256Hex(canonicalJson({ instance: instanceId(this.deps.db), firewall: verdict.paypalRequestId })),
        verdictDigest: verdict.digest,
        items: items.map((i) => ({ recipientId: i.recipientId, amountCents: i.amountCents })),
      });
      this.audit.append('payout.reserved', { planId, batchId, digest: verdict.digest, totalCents: verdict.totalCents, items: items.length });
      batch = this.ledger.getBatch(batchId)!;
    }

    const items = payableItems(verdict);
    const body = buildPayoutBatchBody({
      senderBatchId: `firstlight-${plan.event_id}-v${plan.version}-${instanceId(this.deps.db).slice(0, 8)}`,
      emailSubject: 'Emergency relief payment (SANDBOX)',
      emailMessage: 'This is an automatic relief payment from the Firstlight sandbox demo. No real money moves.',
      items: items.map((i) => ({
        receiverEmail: payees.get(i.recipientId)!,
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
      const definitive = !resend && err instanceof PayPalApiError && err.status >= 400 && err.status < 500 && err.status !== 409 && err.status !== 429;
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
    const current = new Map(this.ledger.batchItems(batchId).map((r) => [r.recipient_id, r.status]));
    for (const it of body.items ?? []) {
      const sid = it.payout_item.sender_item_id ?? '';
      const [eventId, recipientId] = sid.split(':');
      if (eventId !== batch.event_id || !recipientId || !current.has(recipientId)) continue;
      const norm = this.ledger.setItemStatus(eventId, recipientId, it.transaction_status);
      this.ledger.setItemDetails(eventId, recipientId, { paypalItemId: it.payout_item_id, transactionId: it.transaction_id, errorName: it.errors?.name ?? null });
      if (current.get(recipientId) !== norm.status) changes.push({ recipientId, from: current.get(recipientId)!, to: norm.status, unknown: norm.unknown });
    }
    const status = body.batch_header.batch_status;
    // Re-read after the await: the poller and webhooks can poll the same batch concurrently.
    const before = this.ledger.getBatch(batchId)!.status;
    if (status !== before) this.ledger.setBatchStatus(batchId, status);
    if (changes.length > 0 || status !== before) {
      this.audit.append('paypal.payout.status', { batchId, paypalBatchId: batch.paypal_batch_id, batchStatus: status, changes });
    }
    const items = this.ledger.batchItems(batchId).map((r) => ({ recipientId: r.recipient_id, status: r.status }));
    const terminal = (TERMINAL_BATCH_STATUSES as readonly string[]).includes(status) && items.every((i) => i.status !== 'PENDING' && i.status !== 'RESERVED');
    return { batch: this.ledger.getBatch(batchId)!, terminal, items };
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
}

/** Audit entries show which payee got paid without exposing full addresses. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 4)}…${local.slice(-3)}@${domain}`;
}

function maskReceivers(body: ReturnType<typeof buildPayoutBatchBody>) {
  return { ...body, items: body.items.map((i) => ({ ...i, receiver: maskEmail(i.receiver) })) };
}
