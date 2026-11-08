'use client';

import Link from 'next/link';
import type { PlanSummary } from '@/server/views';
import { LoadError, Loading, StatusChip, planStatus, usd, when } from '@/ui/format';
import { useApi } from '@/ui/live';

export default function PlansPage() {
  const { data, error, reload } = useApi<{ plans: PlanSummary[] }>('/api/plans');
  const plans = data?.plans ?? [];
  return (
    <div className="space-y-4">
      <h1 className="text-[1.4rem] font-[800]">Plans</h1>
      <p className="max-w-[70ch] text-ink-muted">Every assessment the agent has made, newest first. Each one is a new version for its earthquake; a revision never pays anyone twice.</p>
      <LoadError error={error} onRetry={reload} />
      {!data && !error ? <Loading what="plans" /> : null}
      {data && plans.length === 0 ? <p className="panel p-5 text-ink-muted">No plans yet. Run an assessment from Mission control.</p> : null}
      <div className={`panel overflow-x-auto ${plans.length ? '' : 'hidden'}`}>
        <table className="w-full min-w-[720px] text-left text-[0.93rem]">
          <thead className="text-[0.85rem] text-ink-muted">
            <tr className="border-b border-line-soft">
              <th className="px-4 py-2.5 font-semibold">Plan</th>
              <th className="px-4 py-2.5 font-semibold">Earthquake</th>
              <th className="px-4 py-2.5 font-semibold">Agent</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
              <th className="px-4 py-2.5 text-right font-semibold">Total</th>
              <th className="px-4 py-2.5 font-semibold">Created</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => {
              const st = planStatus({
                verdict: p.overall ? { overall: p.overall, items: [] } : null,
                approval: p.approval ? { decision: p.approval } : null,
                batch: p.batchStatus ? { status: p.batchStatus, items: [] } : null,
              });
              return (
                <tr key={p.id} className="border-b border-line-soft last:border-0 hover:bg-raised">
                  <td className="px-4 py-2.5">
                    <Link href={`/plans/${p.id}`} className="font-semibold text-allow hover:underline">
                      Plan {p.id}
                    </Link>
                    <span className="ml-2 text-ink-dim">v{p.version}</span>
                  </td>
                  <td className="px-4 py-2.5">{p.eventId}</td>
                  <td className="px-4 py-2.5 text-ink-muted">
                    {p.status === 'agent_failed' ? 'No plan' : p.decision}
                    <span className="ml-2 text-[0.8rem] text-ink-dim">{p.llmMode === 'replay' ? 'replayed' : p.llmMode === 'record' ? 'live, recorded' : p.llmMode}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusChip {...st} />
                  </td>
                  <td className="num px-4 py-2.5 text-right font-semibold">{usd(p.totalCents)}</td>
                  <td className="num px-4 py-2.5 text-ink-muted">{when(p.createdMs)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {data && plans.length === 0 ? (
          <p className="p-5 text-ink-muted">
            No plans yet. Go to <Link href="/" className="text-allow hover:underline">Mission control</Link> and run an assessment.
          </p>
        ) : null}
      </div>
    </div>
  );
}
