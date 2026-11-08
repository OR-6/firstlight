'use client';

import Link from 'next/link';
import { use } from 'react';
import type { EventView, PlanView } from '@/server/views';
import { Notice } from '@/ui/format';
import { useApi } from '@/ui/live';
import { PlanDetail } from '@/ui/PlanDetail';

export default function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: plan, error } = useApi<PlanView>(`/api/plans/${id}`);
  const { data: event } = useApi<EventView>(plan ? `/api/events/${plan.eventId}` : null);
  return (
    <div className="space-y-4">
      <p className="text-[0.9rem]">
        <Link href="/plans" className="text-ink-muted hover:text-ink">
          All plans
        </Link>
      </p>
      <h1 className="text-[1.4rem] font-[800]">Plan {id}</h1>
      {error ? <Notice tone="error">{error.message}</Notice> : null}
      {plan ? <PlanDetail plan={plan} event={event} /> : null}
    </div>
  );
}
