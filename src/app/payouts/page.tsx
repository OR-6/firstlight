'use client';

import { AgGridReact } from 'ag-grid-react';
import Link from 'next/link';
import { useState } from 'react';
import type { BatchView } from '@/server/views';
import { Notice, StatusChip, itemStatus, usd, when, LoadError, Loading } from '@/ui/format';
import { ApiError, call, useApi, useLive } from '@/ui/live';
import { gridTheme } from '@/ui/PlanGrid';

type Item = BatchView['items'][number];

function Batch({ b }: { b: BatchView }) {
  const { bump } = useLive();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const paid = b.items.filter((i) => i.status === 'SUCCESS');
  const batchLike = { verdict: { overall: 'ALLOW', items: [] }, approval: null, batch: { status: b.status, items: b.items } };
  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      await call(`/api/batches/${b.id}/refresh`, { body: {} });
      bump();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel overflow-hidden" aria-label={`PayPal batch ${b.paypalBatchId ?? b.id}`}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line-soft p-5">
        <div>
          <h2 className="text-[1.1rem] font-bold">
            PayPal batch <span className="num">{b.paypalBatchId ?? 'not yet accepted'}</span>
          </h2>
          <p className="num text-[0.88rem] text-ink-muted">
            {b.planId ? (
              <Link href={`/plans/${b.planId}`} className="text-allow hover:underline">
                Plan {b.planId}
              </Link>
            ) : (
              'Plan'
            )}{' '}
            for {b.eventId}, sent {when(b.createdMs)}
          </p>
        </div>
        <StatusChip label={`Batch ${b.status.toLowerCase()}`} tone={b.status === 'SUCCESS' ? 'allow' : ['FAILED', 'DENIED'].includes(b.status) ? 'block' : 'hold'} size="lg" />
        <p className="num text-[0.95rem]">
          <span className="font-bold">{paid.length}</span> of {b.items.length} paid,{' '}
          <span className="font-bold">{usd(paid.reduce((t, i) => t + i.amountCents, 0))}</span> of {usd(b.items.reduce((t, i) => t + i.amountCents, 0))}
        </p>
        <div className="ml-auto flex items-center gap-3">
          {b.polling ? <span className="text-[0.85rem] text-hold">Checking PayPal every 2 s</span> : null}
          <button className="btn h-8" onClick={refresh} disabled={busy || !b.paypalBatchId}>
            {busy ? 'Checking…' : 'Check status now'}
          </button>
        </div>
      </div>
      {error ? (
        <div className="p-3">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}
      <AgGridReact<Item>
        theme={gridTheme}
        domLayout="autoHeight"
        rowData={b.items}
        getRowId={(p) => p.data.recipientId}
        columnDefs={[
          { field: 'recipientId', headerName: 'Recipient', width: 140, cellClass: 'font-semibold' },
          { field: 'town', headerName: 'Town', flex: 1, minWidth: 150 },
          { field: 'amountCents', headerName: 'Amount', width: 120, type: 'rightAligned', cellClass: 'num font-semibold', valueFormatter: (p) => usd(p.value) },
          {
            field: 'status',
            headerName: 'PayPal status',
            width: 170,
            cellRenderer: (p: { data: Item }) => {
              const st = itemStatus(batchLike, p.data.recipientId, 'ALLOW');
              return <StatusChip label={st.label} tone={st.tone} />;
            },
          },
          { field: 'status', headerName: 'Raw status', width: 140, cellClass: 'text-ink-dim' },
        ]}
      />
    </section>
  );
}

export default function PayoutsPage() {
  const { data, error, reload } = useApi<{ batches: BatchView[] }>('/api/batches');
  const batches = data?.batches ?? [];
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[1.4rem] font-[800]">Payouts</h1>
        <p className="mt-1 max-w-[72ch] text-ink-muted">
          Every batch sent to PayPal Payouts in the sandbox. Statuses update live from PayPal webhooks, and from polling every 2 s when no webhook can reach this server.
        </p>
      </div>
      <LoadError error={error} onRetry={reload} />
      {!data && !error ? <Loading what="payouts" /> : null}
      {data && batches.length === 0 ? <p className="panel p-5 text-ink-muted">No payouts sent yet. Approve a plan and send it from its page.</p> : null}
      {batches.map((b) => (
        <Batch key={b.id} b={b} />
      ))}
    </div>
  );
}
