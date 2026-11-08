'use client';

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import type { EventView, PlanView, StateView } from '@/server/views';
import { goToDecision } from '@/ui/decision';
import { Notice, StatusMark, TONE_HEX } from '@/ui/format';
import { ApiError, call, useApi, useLive } from '@/ui/live';
import { MoneyPath, buildStops } from '@/ui/MoneyPath';
import { AgentPanel, EventPanel } from '@/ui/panels';
import { PlanSection, useRuleDrawer } from '@/ui/PlanDetail';
import { RuleDrawer } from '@/ui/RuleDrawer';

const QuakeMap = dynamic(() => import('@/ui/QuakeMap'), {
  ssr: false,
  loading: () => <div className="h-full min-h-[360px] bg-raised" />,
});

/** Bring the plan into view after a run: the decision panel if there is one, else the plan itself. */
function showOutcome() {
  if (goToDecision()) return;
  const el = document.getElementById('plan');
  if (!el) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

function llmLine(mode: string | undefined): string | null {
  if (mode === undefined) return null;
  if (mode === 'replay') return 'Replays the recorded AI agent run for this real earthquake.';
  if (mode === 'scripted') return 'Uses a scripted test agent, not the AI model.';
  return 'Calls the AI model live.';
}

export default function MissionControl() {
  const { bump } = useLive();
  const { data: state } = useApi<StateView>('/api/state');
  const eventId = state?.events[0]?.id ?? null;
  const { data: event, error: eventError } = useApi<EventView>(eventId ? `/api/events/${eventId}` : null);
  const { data: plan } = useApi<PlanView>(state?.latestPlanId ? `/api/plans/${state.latestPlanId}` : null);
  const [poison, setPoison] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drawer = useRuleDrawer(plan);
  // The plan a finished run produced; once it has loaded, scroll to its decision.
  const scrollFor = useRef<number | null>(null);

  useEffect(() => {
    if (!plan || scrollFor.current !== plan.id) return;
    scrollFor.current = null;
    const raf = requestAnimationFrame(showOutcome);
    return () => cancelAnimationFrame(raf);
  }, [plan]);

  const assess = async () => {
    if (!eventId) return;
    setRunning(true);
    setError(null);
    try {
      const p = await call<PlanView>(`/api/events/${eventId}/assess`, { body: { redteam: poison } });
      scrollFor.current = p.id;
      bump();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setRunning(false);
    }
  };

  const openRecipient = (id: string) => {
    const r = drawer.rows.find((x) => x.recipientId === id);
    if (r) drawer.open(r);
  };

  const mode = llmLine(state?.llmMode);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[1.5rem] font-[800]">Mission control</h1>
        <p className="mt-0.5 max-w-[78ch] text-[0.94rem] text-ink-dim">
          Earthquake relief cash in minutes, no application needed. For aid organisations that enrol households before a disaster. PayPal sandbox: no real money moves.
        </p>
        <p className="mt-2 max-w-[78ch] text-ink-muted">
          A real M7.7 earthquake hit Panama on 9 October 2026. Run the assessment to watch the agent draft relief payouts for the households enrolled near it, and the firewall decide what can be paid.{' '}
          <Link href="/how-it-works" className="font-semibold text-allow underline-offset-2 hover:underline">
            How it works
          </Link>
        </p>
      </div>
      <TryIt plan={plan} />
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-go" onClick={assess} disabled={running || !eventId}>
          {running ? 'Assessing…' : plan ? 'Run a new assessment' : 'Run assessment'}
        </button>
        <label className="flex items-center gap-2 text-[0.9rem] text-ink-muted">
          <input type="checkbox" checked={poison} onChange={(e) => setPoison(e.target.checked)} className="h-4 w-4 accent-[var(--color-allow)]" />
          Also feed it four fake news items that try to redirect the money (red-team test)
        </label>
        {mode ? <span className="text-[0.85rem] text-ink-dim">{mode}</span> : null}
        <ResetDemo />
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {eventError ? <Notice tone="error">{eventError.message}</Notice> : null}

      <MoneyPath stops={buildStops(event, plan)} onDecide={goToDecision} />

      <div className="grid gap-5 lg:grid-cols-12">
        <div className="space-y-5 lg:col-span-5">
          {event ? <EventPanel event={event} /> : <div className="panel h-48" aria-busy="true" />}
          {plan ? (
            <AgentPanel plan={plan} event={event} />
          ) : (
            <section className="panel p-5 text-ink-muted">
              <h2 className="text-[1.05rem] font-bold text-ink">No assessment yet</h2>
              <p className="mt-1 max-w-[60ch] text-[0.94rem]">
                Run an assessment to have the agent read the USGS and EMSC records for this earthquake, choose recipients and tiers, and pass its plan to the firewall.
              </p>
            </section>
          )}
        </div>
        {/* isolate: Leaflet's controls use z-index 1000, the same as the sticky header; keep them inside the map's own stacking context. */}
        <div className="panel relative isolate z-0 overflow-hidden lg:col-span-7">
          {event && state ? <QuakeMap event={event} plan={plan} recipients={plan?.recipients ?? event.recipients} onSelect={openRecipient} /> : null}
          <MapLegend />
        </div>
      </div>

      {plan ? <PlanSection plan={plan} event={event} onOpen={drawer.open} /> : null}
      <RuleDrawer row={drawer.row} stale={drawer.stale} onClose={drawer.close} />
    </div>
  );
}

const TRY_IT_KEY = 'firstlight.tryit.hidden';

const stepLink = 'font-semibold text-allow underline-offset-2 hover:underline';

/**
 * A quiet four-step guide for a first visit. Each step ticks off as the demo
 * reaches it; a step waiting on the reader links to where they act. Hiding it
 * is remembered in this browser only.
 */
function TryIt({ plan }: { plan: PlanView | null }) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    try {
      setHidden(window.localStorage.getItem(TRY_IT_KEY) === '1');
    } catch {
      /* storage blocked: keep showing it */
    }
  }, []);
  if (hidden) return null;
  const v = plan?.verdict;
  const needsDecision = v?.overall === 'REQUIRE_APPROVAL' && !plan?.approval;
  const canSend = Boolean(plan && v && !plan.batch && (v.overall === 'ALLOW' || plan.approval?.decision === 'approve'));
  const jump = (label: string) => (
    <a
      href="#decision"
      className={stepLink}
      onClick={(e) => {
        e.preventDefault();
        goToDecision();
      }}
    >
      {label}
    </a>
  );
  const steps: { label: React.ReactNode; done: boolean }[] = [
    { label: 'Run the assessment', done: Boolean(plan) },
    {
      label: needsDecision ? jump('Approve the plan') : 'Approve the plan',
      done: Boolean(plan?.approval?.decision === 'approve' || v?.overall === 'ALLOW'),
    },
    { label: canSend ? jump('Send the payouts') : 'Send the payouts', done: Boolean(plan?.batch) },
    {
      label: (
        <Link href="/redteam" className={stepLink}>
          See the red team try to break it
        </Link>
      ),
      done: false,
    },
  ];
  return (
    <section aria-labelledby="try-it" className="flex flex-wrap items-start gap-x-5 gap-y-2 border-y border-line-soft py-2.5 text-[0.9rem]">
      <h2 id="try-it" className="font-semibold">
        Try it
      </h2>
      <ol className="flex flex-1 flex-wrap gap-x-5 gap-y-1.5">
        {steps.map((s, i) => (
          <li key={i} className="flex items-center gap-1.5 text-ink-muted">
            {s.done ? (
              <span aria-hidden>
                <StatusMark s="pass" />
              </span>
            ) : (
              <span className="num inline-flex h-4 w-4 items-center justify-center rounded-full border border-ink-dim text-[0.7rem] font-bold leading-none text-ink" aria-hidden>
                {i + 1}
              </span>
            )}
            <span className={s.done ? 'text-ink-dim' : 'text-ink'}>{s.label}</span>
            {s.done ? <span className="sr-only">(done)</span> : null}
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="text-[0.85rem] text-ink-dim underline-offset-2 hover:text-ink hover:underline"
        onClick={() => {
          setHidden(true);
          try {
            window.localStorage.setItem(TRY_IT_KEY, '1');
          } catch {
            /* ignore */
          }
        }}
      >
        Hide guide
      </button>
    </section>
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="ml-auto flex flex-wrap items-center gap-2">
      {err ? (
        <span role="alert" className="text-[0.85rem] text-block-ink">
          {err}
        </span>
      ) : null}
      {armed ? (
        <>
          <span className="text-[0.85rem] text-ink-muted">Clears plans, ledger and audit log for everyone using the demo.</span>
          <button
            className="btn btn-stop h-8"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await call('/api/demo/reset', { body: {} });
                setArmed(false);
                bump();
              } catch (e) {
                setErr((e as ApiError).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Resetting…' : 'Reset demo'}
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
