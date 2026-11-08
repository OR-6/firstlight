'use client';

import Link from 'next/link';
import type { EventView, PlanSummary, PlanView } from '@/server/views';
import { usd, when } from '@/ui/format';
import { LoadError, Loading } from '@/ui/format';
import { useApi } from '@/ui/live';
import { ApprovalForm } from '@/ui/panels';

function Pending({ id }: { id: number }) {
  const { data } = useApi<PlanView>(`/api/plans/${id}`);
  const { data: event } = useApi<EventView>(data ? `/api/events/${data.eventId}` : null);
  if (!data) return <div className="panel h-40" aria-busy="true" />;
  return (
    <div className="space-y-2">
      <ApprovalForm plan={data} event={event} />
      <Link href={`/plans/${id}`} className="ml-1 text-[0.88rem] text-allow hover:underline">
        Review every recipient in plan {id}
      </Link>
    </div>
  );
}

export default function ApprovalsPage() {
  const { data, error, reload } = useApi<{ plans: PlanSummary[] }>('/api/plans');
  const plans = data?.plans ?? [];
  const pending = plans.filter((p) => p.overall === 'REQUIRE_APPROVAL' && !p.approval);
  const decided = plans.filter((p) => p.approval);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[1.4rem] font-[800]">Approvals</h1>
        <p className="mt-1 max-w-[70ch] text-ink-muted">
          The firewall sends plans here when they add up to more than can be sent without review, or when something looked wrong. Your name and reason are written to the audit log. Approving can never add a recipient or raise an amount; blocked items stay blocked.
        </p>
      </div>
      <LoadError error={error} onRetry={reload} />
      {!data && !error ? <Loading what="approvals" /> : null}
      {data && pending.length === 0 ? <p className="panel p-5 text-ink-muted">Nothing is waiting for a decision.</p> : null}
      <div className="space-y-6">
        {pending.map((p) => (
          <Pending key={p.id} id={p.id} />
        ))}
      </div>
      {decided.length ? (
        <section>
          <h2 className="mb-2 text-[1.05rem] font-bold">Decided</h2>
          <ul className="panel divide-y divide-line-soft">
            {decided.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-[0.92rem]">
                <Link href={`/plans/${p.id}`} className="font-semibold text-allow hover:underline">
                  Plan {p.id}
                </Link>
                <span className={p.approval === 'approve' ? 'text-allow' : 'text-block'}>{p.approval === 'approve' ? 'Approved' : 'Denied'}</span>
                <span className="num">{usd(p.totalCents)}</span>
                <span className="num text-ink-muted">{when(p.createdMs)}</span>
                {p.approval === 'approve' && !p.batchStatus ? (
                  <Link href={`/plans/${p.id}`} className="btn btn-go ml-auto h-8">
                    Send payouts
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
