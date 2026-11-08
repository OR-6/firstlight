'use client';

import dynamic from 'next/dynamic';
import { useCallback, useState } from 'react';
import type { EventView, PlanView, StateView } from '@/server/views';
import { Notice, TONE_HEX } from '@/ui/format';
import { ApiError, call, useApi, useLive } from '@/ui/live';
import { MoneyPath, buildStops } from '@/ui/MoneyPath';
import { AgentPanel, ApprovalForm, EventPanel, PlanHeader, SendPayouts } from '@/ui/panels';
import { PlanGrid, planRows, type PlanRow } from '@/ui/PlanGrid';
import { RuleDrawer } from '@/ui/RuleDrawer';

const QuakeMap = dynamic(() => import('@/ui/QuakeMap'), {
  ssr: false,
  loading: () => <div className="h-full min-h-[360px] bg-raised" />,
});

export default function MissionControl() {
  const { bump } = useLive();
  const { data: state } = useApi<StateView>('/api/state');
  const eventId = state?.events[0]?.id ?? null;
  const { data: event, error: eventError } = useApi<EventView>(eventId ? `/api/events/${eventId}` : null);
  const { data: plan } = useApi<PlanView>(state?.latestPlanId ? `/api/plans/${state.latestPlanId}` : null);
  const [poison, setPoison] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [row, setRow] = useState<PlanRow | null>(null);
  const close = useCallback(() => setRow(null), []);

  const assess = async () => {
    if (!eventId) return;
    setRunning(true);
    setError(null);
    try {
      await call(`/api/events/${eventId}/assess`, { body: { redteam: poison } });
      bump();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setRunning(false);
    }
  };

  const openRecipient = (id: string) => {
    if (!plan) return;
    const r = planRows(plan).find((x) => x.recipientId === id);
    if (r) setRow(r);
  };

  const v = plan?.verdict;
  const needsDecision = v?.overall === 'REQUIRE_APPROVAL' && !plan?.approval;
  const canSend = plan && v && !plan.batch && (v.overall === 'ALLOW' || plan.approval?.decision === 'approve');

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-go" onClick={assess} disabled={running || !eventId}>
          {running ? 'Assessing…' : plan ? 'Run a new assessment' : 'Run assessment'}
        </button>
        <label className="flex items-center gap-2 text-[0.9rem] text-ink-muted">
          <input type="checkbox" checked={poison} onChange={(e) => setPoison(e.target.checked)} className="h-4 w-4 accent-[var(--color-allow)]" />
          Add four poisoned news items
        </label>
        <span className="text-[0.85rem] text-ink-dim">
          {state?.llmMode === 'replay' ? 'Replays the recorded Claude Opus 5.5 run for this real earthquake.' : 'Calls Claude live.'}
        </span>
        <ResetDemo />
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {eventError ? <Notice tone="error">{eventError.message}</Notice> : null}

      <MoneyPath stops={buildStops(event, plan)} />

      <div className="grid gap-5 lg:grid-cols-12">
        <div className="space-y-5 lg:col-span-5">
          {event ? <EventPanel event={event} /> : <div className="panel h-48" />}
          {plan ? (
            <AgentPanel plan={plan} />
          ) : (
            <section className="panel p-5 text-ink-muted">
              <h2 className="text-[1.05rem] font-bold text-ink">No assessment yet</h2>
              <p className="mt-1 max-w-[60ch] text-[0.94rem]">
                Run an assessment to have the agent read the USGS and EMSC records for this earthquake, choose recipients and tiers, and pass its plan to the firewall.
              </p>
            </section>
          )}
        </div>
        <div className="panel overflow-hidden lg:col-span-7">
          {event && state ? <QuakeMap event={event} plan={plan} recipients={plan?.recipients ?? event.recipients} onSelect={openRecipient} /> : null}
          <MapLegend />
        </div>
      </div>

      {plan && v ? (
        <section className="panel overflow-hidden" aria-labelledby="plan-title">
          <div className="space-y-4 border-b border-line-soft p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="plan-title" className="sr-only">
                Plan {plan.id}
              </h2>
              <PlanHeader plan={plan} />
              <p className="text-[0.85rem] text-ink-dim">Select a row to see every firewall check for that recipient.</p>
            </div>
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

function MapLegend() {
  const dot = (c: string) => <span className="inline-block h-3 w-3 rounded-full border-[1.5px] border-black" style={{ background: c }} />;
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line-soft px-4 py-2.5 text-[0.875rem] text-ink-muted">
      <span className="flex items-center gap-1.5">{dot(TONE_HEX.allow)} Allowed, approved or paid</span>
      <span className="flex items-center gap-1.5">{dot(TONE_HEX.hold)} Needs approval or sending</span>
      <span className="flex items-center gap-1.5">{dot(TONE_HEX.block)} Blocked</span>
      <span className="flex items-center gap-1.5">{dot(TONE_HEX.muted)} Not in plan</span>
      <span>Rings are the firewall&apos;s payout bands: A up to 50 km, B 150 km, C 300 km.</span>
    </div>
  );
}

function ResetDemo() {
  const { bump } = useLive();
  const [armed, setArmed] = useState(false);
  return (
    <div className="ml-auto flex items-center gap-2">
      {armed ? (
        <>
          <span className="text-[0.85rem] text-ink-muted">Clears plans, ledger and audit log.</span>
          <button
            className="btn btn-stop h-8"
            onClick={async () => {
              await call('/api/demo/reset', { body: {} });
              setArmed(false);
              bump();
            }}
          >
            Reset demo
          </button>
          <button className="btn h-8" onClick={() => setArmed(false)}>
            Keep data
          </button>
        </>
      ) : (
        <button className="btn h-8 text-ink-muted" onClick={() => setArmed(true)}>
          Reset demo
        </button>
      )}
    </div>
  );
}
