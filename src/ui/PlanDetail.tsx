'use client';

import { useCallback, useState } from 'react';
import type { EventView, PlanView } from '@/server/views';
import { MoneyPath, buildStops } from './MoneyPath';
import { AgentPanel, ApprovalForm, PlanHeader, SendPayouts } from './panels';
import { PlanGrid, type PlanRow } from './PlanGrid';
import { RuleDrawer } from './RuleDrawer';

/** One plan: its path, the agent's reasoning, the decision controls and the per-recipient table. */
export function PlanDetail({ plan, event }: { plan: PlanView; event: EventView | null }) {
  const [row, setRow] = useState<PlanRow | null>(null);
  const close = useCallback(() => setRow(null), []);
  const v = plan.verdict;
  const needsDecision = v?.overall === 'REQUIRE_APPROVAL' && !plan.approval;
  const canSend = v && !plan.batch && (v.overall === 'ALLOW' || plan.approval?.decision === 'approve');
  return (
    <div className="space-y-5">
      <MoneyPath stops={buildStops(event, plan)} />
      <AgentPanel plan={plan} event={event} />
      {v ? (
        <section className="panel overflow-hidden" aria-labelledby="plan-title">
          <div className="space-y-4 border-b border-line-soft p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <PlanHeader plan={plan} event={event} headingId="plan-title" />
              <p className="text-[0.85rem] text-ink-dim">Select a row to see every firewall check for that recipient.</p>
            </div>
            {plan.approval ? (
              <p className="text-[0.9rem] text-ink-muted">
                {plan.approval.decision === 'approve' ? 'Approved' : 'Denied'} by <span className="text-ink">{plan.approval.approver}</span>: {plan.approval.reason}
              </p>
            ) : null}
            {needsDecision ? <ApprovalForm plan={plan} compact /> : null}
            {canSend ? <SendPayouts plan={plan} /> : null}
          </div>
          <PlanGrid plan={plan} onOpen={setRow} />
        </section>
      ) : null}
      <RuleDrawer row={row} onClose={close} />
    </div>
  );
}
