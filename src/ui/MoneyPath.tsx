'use client';

import Link from 'next/link';
import type { EventView, PlanView } from '@/server/views';
import { shortHash, usd } from './format';
import { Mark, type State } from './SignMark';

/**
 * The path a relief payment takes, left to right (top to bottom on phones).
 * Each stop shows its real state and the audit-log hash that proves it
 * happened. This is a genuine sequence, so it is drawn as one.
 */
type Stop = { name: string; state: State; headline: string; detail: string; hash?: string; seq?: number };

export function buildStops(event: EventView | null, plan: PlanView | null): Stop[] {
  const t = (type: string) => plan?.trail.find((e) => e.type === type);
  const v = plan?.verdict ?? null;
  const payable = v ? v.items.filter((i) => i.verdict !== 'BLOCK').length : 0;
  const paid = plan?.batch?.items.filter((i) => i.status === 'SUCCESS').length ?? 0;
  const corr = plan?.corroboration ?? event?.corroboration;

  const signal: Stop = event
    ? {
        name: 'Signal',
        state: plan ? 'done' : 'wait',
        headline: `M${event.mag} ${event.alert ? `PAGER ${event.alert}` : 'no PAGER alert'}`,
        detail: corr?.mode === 'emsc' ? 'USGS and EMSC agree' : corr?.mode === 'fallback' ? 'USGS only (not independent)' : 'No second source',
        hash: t('signal.received')?.hash,
        seq: t('signal.received')?.seq,
      }
    : { name: 'Signal', state: 'idle', headline: 'No event loaded', detail: '' };

  if (!plan) {
    return [
      signal,
      { name: 'Sentinel', state: 'idle', headline: 'Not run', detail: '' },
      { name: 'Agent', state: 'idle', headline: 'Not run', detail: '' },
      { name: 'Firewall', state: 'idle', headline: 'Not run', detail: '' },
      { name: 'Approval', state: 'idle', headline: 'Not reached', detail: '' },
      { name: 'PayPal', state: 'idle', headline: 'Not reached', detail: '' },
      { name: 'Recipients', state: 'idle', headline: 'Not reached', detail: '' },
    ];
  }

  const s = plan.sentinel;
  const sentinel: Stop = {
    name: 'Sentinel',
    state: s.injectionSuspected ? 'wait' : 'done',
    headline: s.injectionSuspected ? `${s.findings.length} suspicious` : 'Nothing suspicious',
    detail: s.injectionSuspected ? 'A human must approve' : 'Untrusted text scanned',
    hash: (t('sentinel.post') ?? t('sentinel.pre'))?.hash,
    seq: (t('sentinel.post') ?? t('sentinel.pre'))?.seq,
  };
  const agent: Stop =
    plan.status === 'agent_failed'
      ? { name: 'Agent', state: 'stop', headline: 'No plan', detail: plan.agent.reason ?? '', hash: t('agent.result')?.hash, seq: t('agent.result')?.seq }
      : {
          name: 'Agent',
          state: plan.decision === 'trigger' ? 'done' : plan.decision === 'escalate' ? 'wait' : 'stop',
          headline: plan.decision === 'trigger' ? 'Trigger' : plan.decision === 'escalate' ? 'Escalate' : 'Hold',
          detail: `${v?.items.length ?? 0} recipients proposed`,
          hash: t('agent.result')?.hash,
          seq: t('agent.result')?.seq,
        };
  const firewall: Stop = v
    ? {
        name: 'Firewall',
        state: v.overall === 'ALLOW' ? 'done' : v.overall === 'REQUIRE_APPROVAL' ? 'wait' : 'stop',
        headline: v.overall === 'ALLOW' ? 'Allowed' : v.overall === 'REQUIRE_APPROVAL' ? 'Needs approval' : 'Blocked',
        detail: v.overall === 'BLOCK' ? 'Nothing can be paid' : `${usd(v.totalCents)} to ${payable}`,
        hash: t('firewall.verdict')?.hash,
        seq: t('firewall.verdict')?.seq,
      }
    : { name: 'Firewall', state: 'idle', headline: 'Not run', detail: '' };

  let approval: Stop;
  if (!v || v.overall === 'BLOCK') approval = { name: 'Approval', state: 'idle', headline: 'Not reached', detail: '' };
  else if (v.overall === 'ALLOW') approval = { name: 'Approval', state: 'done', headline: 'Not needed', detail: 'Within auto-approve limit' };
  else if (!plan.approval) approval = { name: 'Approval', state: 'wait', headline: 'Waiting', detail: 'A person must decide' };
  else
    approval = {
      name: 'Approval',
      state: plan.approval.decision === 'approve' ? 'done' : 'stop',
      headline: plan.approval.decision === 'approve' ? 'Approved' : 'Denied',
      detail: `by ${plan.approval.approver}`,
      hash: t('approval.decided')?.hash,
      seq: t('approval.decided')?.seq,
    };

  const b = plan.batch;
  const paypal: Stop = !b
    ? { name: 'PayPal', state: 'idle', headline: 'Not sent', detail: '' }
    : {
        name: 'PayPal',
        state: b.status === 'SUCCESS' ? 'done' : b.status === 'FAILED' || b.status === 'DENIED' ? 'stop' : 'wait',
        headline: `Batch ${b.status.toLowerCase()}`,
        detail: b.paypalBatchId ?? 'Submitting',
        hash: (t('paypal.payout.created') ?? t('payout.reserved'))?.hash,
        seq: (t('paypal.payout.created') ?? t('payout.reserved'))?.seq,
      };
  const lastStatus = [...plan.trail].reverse().find((e) => e.type === 'paypal.payout.status');
  const recipients: Stop = !b
    ? { name: 'Recipients', state: 'idle', headline: 'Not reached', detail: '' }
    : {
        name: 'Recipients',
        state: paid === b.items.length ? 'done' : b.items.some((i) => ['FAILED', 'RETURNED', 'BLOCKED'].includes(i.status)) ? 'stop' : 'wait',
        headline: `${paid} of ${b.items.length} paid`,
        detail: usd(b.items.filter((i) => i.status === 'SUCCESS').reduce((t2, i) => t2 + i.amountCents, 0)),
        hash: lastStatus?.hash,
        seq: lastStatus?.seq,
      };
  return [signal, sentinel, agent, firewall, approval, paypal, recipients];
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** "Stage 4 of 7: Firewall, needs approval": the first stage that is not done yet. */
export function currentStage(stops: Stop[]): string {
  const i = stops.findIndex((s) => s.state !== 'done');
  if (i < 0) return `All ${stops.length} stages done`;
  const s = stops[i]!;
  return `Stage ${i + 1} of ${stops.length}: ${s.name}, ${lowerFirst(s.headline)}`;
}

/** Drawn as a green guide sign: white lettering, white inset border, sign-shaped marks. */
export function MoneyPath({ stops }: { stops: Stop[] }) {
  return (
    <section aria-label="Path of this payment" className="rounded-[var(--radius-panel)] bg-allow p-[3px] text-white">
      <div className="rounded-[4px] border-2 border-white/90">
        <PhonePath stops={stops} />
        <ol className="hidden auto-cols-[minmax(7.5rem,1fr)] grid-flow-col md:grid">
          {stops.map((s, i) => {
            const next = stops[i + 1];
            const reached = s.state !== 'idle';
            return (
              <li key={s.name} className="relative min-w-0 px-3 pb-4 pt-4 lg:px-4">
                <div className="mb-2.5 flex h-5 items-center" aria-hidden>
                  <Mark state={s.state} />
                  {next ? (
                    <span
                      className="ml-1.5 flex-1"
                      style={
                        s.state === 'done'
                          ? { height: 3, background: '#fff' }
                          : { borderTop: `2px dashed rgb(255 255 255 / ${reached ? 0.8 : 0.4})` }
                      }
                    />
                  ) : null}
                </div>
                <p className="text-[0.85rem] text-white/80">{s.name}</p>
                <p className={`mt-0.5 text-[1.05rem] font-bold leading-snug ${reached ? 'text-white' : 'text-white/55'}`}>{s.headline}</p>
                {s.detail ? (
                  <p className="num mt-0.5 truncate text-[0.875rem] text-white/85" title={s.detail}>
                    {s.detail}
                  </p>
                ) : null}
                {s.hash ? (
                  <Link
                    href={`/audit#seq-${s.seq}`}
                    className="num mt-1.5 inline-block text-[0.8rem] text-white/75 underline-offset-2 hover:text-white hover:underline focus-visible:outline-white"
                    title={`Audit entry ${s.seq}: ${s.hash}`}
                  >
                    #{shortHash(s.hash)}
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

/**
 * Below 768 px: a summary plate naming the current stage, then every stage as
 * a vertical list (mark and connector on the left), so nothing scrolls sideways.
 */
function PhonePath({ stops }: { stops: Stop[] }) {
  return (
    <div className="md:hidden">
      <p className="border-b-2 border-white/90 px-4 py-2.5 text-[1rem] font-bold">{currentStage(stops)}</p>
      <ol className="px-4 py-3">
        {stops.map((s, i) => {
          const last = i === stops.length - 1;
          const reached = s.state !== 'idle';
          return (
            <li key={s.name} className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-3">
              <div className="flex flex-col items-center" aria-hidden>
                <span className="pt-0.5">
                  <Mark state={s.state} />
                </span>
                {!last ? (
                  <span
                    className="my-1 w-0 flex-1"
                    style={s.state === 'done' ? { borderLeft: '3px solid #fff' } : { borderLeft: `2px dashed rgb(255 255 255 / ${reached ? 0.8 : 0.4})` }}
                  />
                ) : null}
              </div>
              <div className={`min-w-0 ${last ? '' : 'pb-3'}`}>
                <p className="leading-snug">
                  <span className="text-[0.85rem] text-white/80">{s.name}</span>{' '}
                  <span className={`text-[1rem] font-bold ${reached ? 'text-white' : 'text-white/55'}`}>{s.headline}</span>
                </p>
                {s.detail || s.hash ? (
                  <p className="num mt-0.5 break-words text-[0.85rem] text-white/85">
                    {s.detail}
                    {s.hash ? (
                      <Link
                        href={`/audit#seq-${s.seq}`}
                        className={`${s.detail ? 'ml-2' : ''} text-white/75 underline-offset-2 hover:text-white hover:underline focus-visible:outline-white`}
                        title={`Audit entry ${s.seq}: ${s.hash}`}
                      >
                        #{shortHash(s.hash)}
                      </Link>
                    ) : null}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
