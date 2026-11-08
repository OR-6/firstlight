'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import type { EventView, PlanView } from '@/server/views';
import { DECISION_ID, goToDecision } from './decision';
import { ApiError, call } from './live';
import { MoneyPath, buildStops } from './MoneyPath';
import { AgentPanel, ApprovalForm, PlanHeader, SendPayouts } from './panels';
import { PlanGrid, planRows, type PlanRow } from './PlanGrid';
import { RuleDrawer, type DrawerStale } from './RuleDrawer';

/** One plan: its path, the agent's reasoning, the per-recipient table and, below it, the decision controls. */
export function PlanDetail({ plan, event, gone = false }: { plan: PlanView; event: EventView | null; gone?: boolean }) {
  const drawer = useRuleDrawer(gone ? null : plan);
  return (
    <div className="space-y-5">
      <MoneyPath stops={buildStops(event, plan)} onDecide={goToDecision} />
      <AgentPanel plan={plan} event={event} />
      <PlanSection plan={plan} event={event} onOpen={drawer.open} />
      <RuleDrawer row={drawer.row} stale={drawer.stale} onClose={drawer.close} />
    </div>
  );
}

/**
 * Which household's checks the rule drawer shows. The row is re-read from the
 * current plan on every update, so the drawer never shows stale data: if the
 * plan behind it was reset or replaced by a new run, `stale` says so.
 */
export function useRuleDrawer(plan: PlanView | null) {
  const [sel, setSel] = useState<{ planId: number; row: PlanRow } | null>(null);
  const rows = useMemo(() => (plan ? planRows(plan) : []), [plan]);
  const open = useCallback((row: PlanRow) => {
    if (plan) setSel({ planId: plan.id, row });
  }, [plan]);
  const close = useCallback(() => setSel(null), []);
  const current = sel && plan && plan.id === sel.planId ? (rows.find((r) => r.index === sel.row.index) ?? null) : null;
  const stale: DrawerStale = !sel || current ? null : plan && plan.id !== sel.planId ? 'replaced' : 'reset';
  return { row: sel ? (current ?? sel.row) : null, stale, open, rows, close };
}

/**
 * The plan's households first, then the decision. A reviewer sees who would
 * be paid, and why, before the Approve and Deny buttons.
 */
export function PlanSection({ plan, event, onOpen }: { plan: PlanView; event: EventView | null; onOpen: (row: PlanRow) => void }) {
  const v = plan.verdict;
  if (!v) return null;
  const needsDecision = v.overall === 'REQUIRE_APPROVAL' && !plan.approval;
  const canSend = !plan.batch && (v.overall === 'ALLOW' || plan.approval?.decision === 'approve');
  return (
    <section id="plan" className="panel scroll-mt-20 overflow-hidden" aria-labelledby="plan-title">
      <div className="space-y-3 border-b border-line-soft p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PlanHeader plan={plan} event={event} headingId="plan-title" />
          <p className="text-[0.85rem] text-ink-dim">Select a household to see every firewall check for it.</p>
        </div>
        {plan.approval ? (
          <p className="text-[0.9rem] text-ink-muted">
            {plan.approval.decision === 'approve' ? 'Approved' : 'Denied'} by <span className="text-ink">{plan.approval.approver}</span>
            {plan.approval.reason ? `: ${plan.approval.reason}` : ''}
          </p>
        ) : null}
      </div>
      <PlanGrid plan={plan} onOpen={onOpen} />
      {needsDecision || canSend ? (
        <div id={DECISION_ID} className="scroll-mt-20 border-t-2 border-line bg-raised p-5" role="region" aria-label="Decision">
          {needsDecision ? <ApprovalForm plan={plan} compact /> : <SendPayouts plan={plan} />}
        </div>
      ) : null}
      <FloorPlanOffer plan={plan} />
    </section>
  );
}

/** Codes that mean the agent's plan withholds or shrinks aid on a confirmed quake (D91). */
const AID_AT_RISK = new Set(['ELIGIBLE_OMITTED', 'TIER_BELOW_BAND', 'HOLD_ON_MET_TRIGGER', 'PLAN_EVENT_MISMATCH', 'PLAN_MALFORMED']);

/**
 * When the agent's plan would leave households with less (or nothing), offer the firewall's own
 * plan: everyone owed at their full tier, drafted by deterministic code, still decided by a person.
 */
function FloorPlanOffer({ plan }: { plan: PlanView }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const v = plan.verdict;
  if (!v || plan.batch || plan.llmMode === 'firewall') return null;
  const triggerMet = v.planRules.some((r) => r.id === 'R8' && r.status === 'pass');
  const atRisk = v.planRules.filter((r) => AID_AT_RISK.has(r.reasonCode) && r.status !== 'pass');
  if (!triggerMet || atRisk.length === 0) return null;
  const draft = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await call<PlanView>(`/api/plans/${plan.id}/floor`, { body: {} });
      router.push(`/plans/${next.id}`);
    } catch (e) {
      setError((e as ApiError).message);
      setBusy(false);
    }
  };
  return (
    <div className="border-t border-line-soft p-5">
      <h3 className="text-[0.98rem] font-bold">The agent&apos;s plan leaves households with less than they&apos;re owed</h3>
      <p className="mt-1 max-w-[70ch] text-[0.92rem] text-ink-muted">
        The firewall can draft its own plan from the registry: every enrolled household owed for this earthquake, at its full tier. No AI is involved, and a person still decides.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className="btn" onClick={draft} disabled={busy}>
          {busy ? 'Drafting…' : "Draft the firewall's plan"}
        </button>
        {error ? <span role="alert" className="text-[0.9rem] text-block-ink">{error}</span> : null}
      </div>
    </div>
  );
}
