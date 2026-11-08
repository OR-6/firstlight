'use client';

import Link from 'next/link';
import type { EventView, PlanView } from '@/server/views';
import { shortHash, usd } from './format';

/**
 * The path a relief payment takes, left to right. Each stop shows its real
 * state and the audit-log hash that proves it happened. This is a genuine
 * sequence, so it is drawn as one.
 */
type State = 'done' | 'wait' | 'stop' | 'idle';
type Stop = { name: string; state: State; headline: string; detail: string; hash?: string; seq?: number };

const COLOR: Record<State, string> = {
  done: 'var(--color-allow)',
  wait: 'var(--color-hold)',
  stop: 'var(--color-block)',
  idle: 'var(--color-line)',
};

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

export function MoneyPath({ stops }: { stops: Stop[] }) {
  return (
    <section aria-label="Path of this payment" className="panel overflow-hidden">
      <ol className="grid snap-x auto-cols-[minmax(9.5rem,1fr)] grid-flow-col overflow-x-auto">
        {stops.map((s, i) => {
          const next = stops[i + 1];
          return (
            <li key={s.name} className="relative snap-start px-4 pb-4 pt-5">
              {/* track: this stop's colour up to the next stop */}
              <div className="mb-3 flex items-center" aria-hidden>
                <Node state={s.state} />
                {next ? (
                  <span
                    className="ml-1 h-[3px] flex-1"
                    style={{
                      background: s.state === 'done' ? COLOR.done : 'transparent',
                      borderTop: s.state === 'done' ? undefined : `2px dashed ${COLOR[s.state === 'idle' ? 'idle' : s.state]}`,
                      opacity: s.state === 'idle' ? 0.6 : 1,
                    }}
                  />
                ) : null}
              </div>
              <p className="text-[0.82rem] text-ink-dim">{s.name}</p>
              <p className="mt-0.5 text-[1.02rem] font-bold leading-snug" style={{ color: s.state === 'idle' ? 'var(--color-ink-dim)' : undefined }}>
                {s.headline}
              </p>
              {s.detail ? <p className="num mt-0.5 truncate text-[0.85rem] text-ink-muted" title={s.detail}>{s.detail}</p> : null}
              {s.hash ? (
                <Link href={`/audit#seq-${s.seq}`} className="hash mt-1.5 inline-block text-[0.78rem] hover:text-ink" title={`Audit entry ${s.seq}: ${s.hash}`}>
                  #{shortHash(s.hash)}
                </Link>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Node({ state }: { state: State }) {
  const c = COLOR[state];
  if (state === 'done') return <span className="block h-3.5 w-3.5 shrink-0 rounded-full" style={{ background: c }} />;
  if (state === 'stop')
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" className="shrink-0">
        <path d="M3 3l8 8M11 3l-8 8" stroke={c} strokeWidth="2.6" strokeLinecap="round" />
      </svg>
    );
  return <span className="block h-3.5 w-3.5 shrink-0 rounded-full border-2" style={{ borderColor: c }} />;
}
