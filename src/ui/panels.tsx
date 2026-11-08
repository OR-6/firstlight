'use client';

import { useState } from 'react';
import type { EventView, PlanView } from '@/server/views';
import { ApiError, call, useLive } from './live';
import { Notice, PAGER, StatusChip, planStatus, usd, when } from './format';

export function EventPanel({ event }: { event: EventView }) {
  const corr = event.corroboration;
  const o = corr.observations[0];
  return (
    <section className="panel p-5" aria-labelledby="event-title">
      <div className="flex items-baseline gap-4">
        <p className="num text-[2.6rem] font-[800] leading-none tracking-[-0.02em]">
          {event.mag.toFixed(1)}
          <span className="ml-1 text-[1rem] font-semibold text-ink-muted">{event.magType}</span>
        </p>
        <div className="min-w-0">
          <h1 id="event-title" className="text-[1.15rem] font-bold leading-snug">
            {event.place}
          </h1>
          <p className="num text-[0.88rem] text-ink-muted">
            {new Date(event.time).toUTCString().replace(' GMT', ' UTC')}, {event.depthKm} km deep
          </p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-[0.9rem]">
        <div>
          <dt className="text-ink-dim">PAGER alert</dt>
          <dd className="flex items-center gap-2 font-semibold capitalize">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: event.alert ? PAGER[event.alert] : 'var(--color-line)' }} />
            {event.alert ?? 'None issued'}
          </dd>
        </div>
        <div>
          <dt className="text-ink-dim">Review</dt>
          <dd className="font-semibold">{event.status === 'reviewed' ? 'Reviewed by USGS' : 'Automatic (not yet reviewed)'}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-ink-dim">Second source</dt>
          <dd className="num">
            {corr.mode === 'emsc' && o ? (
              <>
                <span className="font-semibold">EMSC agrees.</span> M{o.mag}, {distance(event, o.epicentre).toFixed(1)} km from the USGS epicentre,{' '}
                {Math.abs((o.time - event.time) / 1000).toFixed(1)} s apart.
              </>
            ) : corr.mode === 'fallback' ? (
              <span className="text-hold">EMSC unavailable. Using USGS review status, which is not independent.</span>
            ) : (
              <span className="text-block">No second source.</span>
            )}
          </dd>
        </div>
      </dl>
      {event.url ? (
        <a href={event.url} target="_blank" rel="noreferrer" className="mt-4 inline-block text-[0.88rem] text-allow underline-offset-2 hover:underline">
          Open the USGS event page
        </a>
      ) : null}
    </section>
  );
}

function distance(e: EventView, p: { lat: number; lon: number }) {
  const r = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(r(p.lat - e.epicentre.lat) / 2) ** 2 + Math.cos(r(e.epicentre.lat)) * Math.cos(r(p.lat)) * Math.sin(r(p.lon - e.epicentre.lon) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
}

export function AgentPanel({ plan }: { plan: PlanView }) {
  const [open, setOpen] = useState(false);
  const findings = plan.sentinel.findings;
  const recorded = plan.llmMode === 'replay';
  return (
    <section className="panel p-5" aria-labelledby="agent-title">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="agent-title" className="text-[1.05rem] font-bold">
          Agent decision:{' '}
          <span className={plan.decision === 'trigger' ? 'text-allow' : plan.decision === 'escalate' ? 'text-hold' : 'text-block'}>
            {plan.status === 'agent_failed' ? 'no plan' : plan.decision}
          </span>
        </h2>
        <span className="text-[0.82rem] text-ink-dim">
          {plan.agent.model}, {plan.agent.turns} turns{recorded ? ', recorded run replayed' : plan.llmMode === 'record' ? ', live run (recorded)' : plan.llmMode === 'scripted' ? ', scripted' : ', live'}
        </span>
      </div>
      {plan.rationale ? (
        <div className="mt-3 max-w-[72ch]">
          <p className={`whitespace-pre-line text-[0.94rem] leading-relaxed text-ink ${open ? '' : 'line-clamp-6'}`}>{plan.rationale}</p>
          <button className="mt-1 text-[0.85rem] text-allow hover:underline" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'Show less' : 'Read the full rationale'}
          </button>
        </div>
      ) : (
        <p className="mt-3 text-ink-muted">{plan.agent.reason}</p>
      )}
      <div className="mt-4 border-t border-line-soft pt-3">
        {findings.length === 0 ? (
          <p className="text-[0.9rem] text-ink-muted">Sentinel found nothing suspicious in the untrusted text or the agent&apos;s output.</p>
        ) : (
          <details>
            <summary className="cursor-pointer text-[0.9rem] font-semibold text-hold">
              Sentinel flagged {findings.length} {findings.length === 1 ? 'item' : 'items'}, so a human must approve
            </summary>
            <ul className="mt-2 space-y-1.5 text-[0.84rem]">
              {findings.slice(0, 30).map((f, i) => (
                <li key={i} className="grid grid-cols-[auto_1fr] gap-x-2">
                  <span className="text-ink-dim">{f.layer === 'llm' ? 'Claude Haiku' : 'Pattern'}</span>
                  <span className="min-w-0 break-words text-ink-muted">
                    <span className="text-ink">{f.target.replace('untrusted:', '')}</span>: {f.excerpt}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}

/** Approve or deny a plan. Same names on the buttons and in the result. */
export function ApprovalForm({ plan, compact = false }: { plan: PlanView; compact?: boolean }) {
  const { bump } = useLive();
  const [approver, setApprover] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const warns = [...(plan.verdict?.planRules ?? []), ...(plan.verdict?.items.flatMap((i) => i.ruleTrace.filter((r) => r.scope === 'item')) ?? [])].filter(
    (r) => r.status !== 'pass',
  );
  const reasons = [...new Map(warns.map((r) => [`${r.reasonCode}`, r])).values()];

  const decide = async (d: 'approve' | 'deny') => {
    setBusy(d);
    setError(null);
    try {
      await call(`/api/plans/${plan.id}/${d}`, { body: { approver, reason } });
      bump();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={compact ? '' : 'panel p-5'}>
      {!compact ? (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[1.1rem] font-bold">
              Plan {plan.id} for {plan.eventId}
            </h2>
            <span className="num text-[1.2rem] font-[800]">{usd(plan.verdict?.totalCents ?? 0)}</span>
          </div>
          <p className="mt-1 text-[0.9rem] text-ink-muted">
            {plan.verdict?.items.filter((i) => i.verdict !== 'BLOCK').length ?? 0} payable recipients. Created {when(plan.createdMs)}.
          </p>
        </>
      ) : null}
      <h3 className={`${compact ? '' : 'mt-4'} text-[0.95rem] font-semibold`}>Why a person has to decide</h3>
      <ul className="mt-1.5 space-y-1 text-[0.88rem]">
        {reasons.map((r) => (
          <li key={r.reasonCode} className="flex gap-2">
            <span className={r.status === 'block' ? 'text-block' : 'text-hold'}>{r.status === 'block' ? 'Blocked:' : 'Check:'}</span>
            <span className="min-w-0 break-words text-ink-muted">{r.detail}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,14rem)_1fr]">
        <label className="grid gap-1 text-[0.85rem] text-ink-muted">
          Your name
          <input className="field" value={approver} onChange={(e) => setApprover(e.target.value)} maxLength={100} autoComplete="name" />
        </label>
        <label className="grid gap-1 text-[0.85rem] text-ink-muted">
          Reason (saved in the audit log)
          <input className="field" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder="What you checked" />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn btn-go" disabled={busy !== null} onClick={() => decide('approve')}>
          {busy === 'approve' ? 'Approving…' : 'Approve payout'}
        </button>
        <button className="btn btn-stop" disabled={busy !== null} onClick={() => decide('deny')}>
          {busy === 'deny' ? 'Denying…' : 'Deny'}
        </button>
      </div>
      {error ? (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}
    </div>
  );
}

export function SendPayouts({ plan }: { plan: PlanView }) {
  const { bump } = useLive();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await call(`/api/plans/${plan.id}/execute`, { body: {} });
      bump();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button className="btn btn-go" onClick={send} disabled={busy}>
        {busy ? 'Sending to PayPal sandbox…' : `Send ${usd(plan.verdict?.totalCents ?? 0)} in payouts`}
      </button>
      <span className="text-[0.85rem] text-ink-muted">One PayPal sandbox Payouts batch. The firewall checks the ledger again first.</span>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}

export function PlanHeader({ plan }: { plan: PlanView }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <StatusChip {...planStatus(plan)} size="lg" />
      <span className="num text-[1.3rem] font-[800]">{usd(plan.verdict?.totalCents ?? 0)}</span>
      <span className="text-ink-muted">
        Plan {plan.id}, version {plan.version}
      </span>
    </div>
  );
}
