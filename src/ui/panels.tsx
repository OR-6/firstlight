'use client';

import { useId, useState } from 'react';
import type { EventView, PlanView } from '@/server/views';
import { ApiError, call, useLive } from './live';
import { Notice, PAGER, StatusChip, StatusMark, planStatus, usd, when } from './format';
import { defaultFirewallConfig } from '@/firewall/config';
import { agentSummary, exceptionItems, plainRule, planTitle, type ExceptionItem } from './plain';

/** The firewall's payout bands, for naming why a household was left out (pure config). */
const BANDS = defaultFirewallConfig();

export function EventPanel({ event }: { event: EventView }) {
  const corr = event.corroboration;
  const o = corr.observations[0];
  return (
    <section className="panel p-5" aria-labelledby="event-title">
      <div className="flex items-baseline gap-4">
        <p className="num text-[2.75rem] font-[800] leading-none tracking-[-0.02em]">
          {event.mag.toFixed(1)}
          <span className="ml-1 text-[1rem] font-semibold text-ink-muted">{event.magType}</span>
        </p>
        <div className="min-w-0">
          <h2 id="event-title" className="text-[1.15rem] font-bold leading-snug">
            {event.place}
          </h2>
          <p className="num text-[0.88rem] text-ink-muted">
            {new Date(event.time).toUTCString().replace(' GMT', ' UTC')}, {event.depthKm} km deep
          </p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-[6.75rem_1fr] gap-x-3 sm:grid-cols-[8.5rem_1fr] sm:gap-x-4 gap-y-2 border-t border-line-soft pt-3 text-[0.94rem]">
        <dt className="text-ink-muted">PAGER alert</dt>
        <dd className="flex items-center gap-2 font-semibold capitalize">
          <span
            className="inline-block h-3 w-3 rounded-full border-[1.5px] border-black"
            style={{ background: event.alert ? PAGER[event.alert] : 'transparent' }}
          />
          {event.alert ?? 'None issued'}
        </dd>
        <dt className="text-ink-muted">Review</dt>
        <dd className="font-semibold">{event.status === 'reviewed' ? 'Reviewed by USGS' : 'Automatic (not yet reviewed)'}</dd>
        <dt className="text-ink-muted">Second source</dt>
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

export function AgentPanel({ plan, event = null }: { plan: PlanView; event?: EventView | null }) {
  const [open, setOpen] = useState(false);
  const rationaleId = useId();
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
          {plan.llmMode === 'firewall' ? 'Firewall floor plan, no AI' : `AI agent, ${plan.agent.turns} turns`}{recorded ? ', recorded run replayed' : plan.llmMode === 'record' ? ', live run (recorded)' : plan.llmMode === 'scripted' ? ', scripted' : ', live'}
        </span>
      </div>
      <dl className="mt-3 grid max-w-[72ch] grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[0.94rem] leading-snug">
        {agentSummary(plan, event, BANDS).map((r) => (
          <div key={r.key} className="contents">
            <dt className="text-ink-muted">{r.label}</dt>
            <dd className={r.key === 'trigger' ? 'font-semibold' : ''}>{r.text}</dd>
          </div>
        ))}
      </dl>
      {plan.rationale ? (
        <div className="mt-2 max-w-[72ch]">
          <button
            type="button"
            className="text-[0.88rem] font-semibold text-allow underline-offset-2 hover:underline"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={rationaleId}
          >
            {open ? "Hide the agent's reasoning" : "Read the agent's reasoning"}
          </button>
          <p id={rationaleId} hidden={!open} className="mt-2 whitespace-pre-line border-l-2 border-line-soft pl-3 text-[0.94rem] leading-relaxed text-ink-muted">
            {plan.rationale}
          </p>
        </div>
      ) : plan.status === 'agent_failed' ? null : (
        <p className="mt-2 text-ink-muted">{plan.agent.reason}</p>
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
                  <span className="text-ink-dim">{f.layer === 'llm' ? 'Classifier model' : 'Pattern'}</span>
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

/** Every non-passing check on a plan, in plain words, labelled with the household it is about. */
function decisionReasons(plan: PlanView): { key: string; status: 'warn' | 'block'; who: string | null; text: string }[] {
  const v = plan.verdict;
  if (!v) return [];
  const towns = new Map(plan.recipients.map((r) => [r.recipientId, r.town]));
  const planHits = [...new Map(v.planRules.filter((r) => r.status !== 'pass').map((r) => [r.reasonCode, r])).values()];
  const itemHits = v.items.flatMap((i) => i.ruleTrace.filter((r) => r.scope === 'item' && r.status !== 'pass').map((r) => ({ r, item: i })));
  const others = planHits.length + itemHits.length > 1;
  return [
    ...planHits.map((r) => ({ key: r.reasonCode, status: r.status as 'warn' | 'block', who: null, text: plainRule(r, { omitWarningsSummary: others }) })),
    ...itemHits.map(({ r, item }) => ({
      key: `${item.index}-${r.reasonCode}`,
      status: r.status as 'warn' | 'block',
      who: towns.get(item.recipientId) ?? item.recipientId,
      text: plainRule(r),
    })),
  ].filter((x) => x.text);
}

/**
 * The agent's exception requests, one per household: who, the agent's reason
 * in its own words (untrusted, shown as text), and what the reviewer checks.
 */
function ExceptionList({ items }: { items: ExceptionItem[] }) {
  return (
    <ol className="mt-2 space-y-2">
      {items.map((x, i) => (
        <li key={`${x.recipientId}-${i}`} className="rounded-[var(--radius-control)] border border-line-soft bg-panel px-3 py-2">
          <p className="leading-snug">
            <span className="font-semibold">{x.town ?? 'Not enrolled'}</span> <span className="num text-[0.85rem] text-ink-dim">{x.recipientId}</span>
          </p>
          <dl className="mt-1 grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-[0.9rem] leading-snug">
            <dt className="text-ink-muted">Agent&apos;s reason</dt>
            <dd className="text-ink-muted">&ldquo;{x.reason}&rdquo;</dd>
            <dt className="text-ink-muted">Check</dt>
            <dd>{x.check}</dd>
          </dl>
        </li>
      ))}
    </ol>
  );
}

/** Approve or deny a plan. Same names on the buttons and in the result. */
export function ApprovalForm({ plan, event = null, compact = false }: { plan: PlanView; event?: EventView | null; compact?: boolean }) {
  const { bump } = useLive();
  const nameId = useId();
  const reasonId = useId();
  const [approver, setApprover] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reasons = decisionReasons(plan);
  const exceptions = exceptionItems(plan);

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
          <h2 className="text-[1.1rem] font-bold leading-snug">{planTitle(plan, event)}</h2>
          <p className="mt-1 text-[0.9rem] text-ink-muted">
            Plan {plan.id}, version {plan.version}. Created {when(plan.createdMs)}.
          </p>
        </>
      ) : null}
      <h3 className={`${compact ? '' : 'mt-4'} text-[0.95rem] font-semibold`}>Why a person has to decide</h3>
      <ul className="mt-1.5 space-y-1.5 text-[0.92rem]">
        {reasons.map((r) => (
          <li key={r.key} className="grid grid-cols-[1rem_1fr] gap-x-2">
            <span className="pt-[3px]">
              <StatusMark s={r.status} />
            </span>
            <div className="min-w-0 break-words">
              {r.who ? <span className="font-semibold">{r.who}: </span> : null}
              {r.text}
              {r.key === 'EXCEPTION_REQUESTED' && exceptions.length ? <ExceptionList items={exceptions} /> : null}
            </div>
          </li>
        ))}
      </ul>
      {exceptions.length && !reasons.some((r) => r.key === 'EXCEPTION_REQUESTED') ? <ExceptionList items={exceptions} /> : null}
      <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,14rem)_1fr]">
        <div className="grid gap-1">
          <label htmlFor={nameId} className="text-[0.875rem] text-ink-muted">
            Your name
          </label>
          <input id={nameId} className="field" value={approver} onChange={(e) => setApprover(e.target.value)} maxLength={100} autoComplete="name" />
        </div>
        <div className="grid gap-1">
          <label htmlFor={reasonId} className="text-[0.875rem] text-ink-muted">
            Reason (saved in the audit log)
          </label>
          <input id={reasonId} className="field" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder="What you checked" />
        </div>
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

/** The plan's title ("M7.7 Panama earthquake: 7 households, $680"), where it stands, and its id. */
export function PlanHeader({ plan, event = null, headingId }: { plan: PlanView; event?: EventView | null; headingId?: string }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 id={headingId} className="text-[1.15rem] font-bold leading-snug">
          {planTitle(plan, event)}
        </h2>
        <StatusChip {...planStatus(plan)} />
      </div>
      <p className="mt-0.5 text-[0.85rem] text-ink-dim">
        Plan {plan.id}, version {plan.version}
      </p>
    </div>
  );
}
