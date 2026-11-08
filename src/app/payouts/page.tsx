'use client';

import type { ProcessCellForExportParams, ProcessHeaderForExportParams } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import type { Difference, BatchReconciliation } from '@/paypal/reconcile';
import type { BatchView, ReconcileView } from '@/server/views';
import { auditHref, trailGroups } from '@/ui/audit-links';
import { Notice, StatusChip, itemStatus, usd, when, LoadError, Loading } from '@/ui/format';
import { ApiError, call, useApi, useLive } from '@/ui/live';
import { SandboxEvidence, clockTime, duration } from '@/ui/SandboxEvidence';
import { gridTheme } from '@/ui/PlanGrid';

type Item = BatchView['items'][number];

const FIELD: Record<Difference['field'], string> = {
  batch_status: 'Batch status',
  batch_total: 'Batch total',
  missing_at_paypal: 'Not in PayPal’s batch',
  missing_in_ledger: 'In PayPal’s batch but not our ledger',
  amount: 'Amount',
  currency: 'Currency',
  status: 'Status',
  transaction_id: 'Transaction id',
  search_status: 'Transaction Search status',
  search_amount: 'Transaction Search amount',
  search_missing: 'Not found in Transaction Search after 3 hours',
};

/** What reconciliation found for one batch, in plain words. */
function Reconciled({ r, state }: { r: BatchReconciliation | undefined; state: 'loading' | 'error' | 'done' }) {
  if (!r && state === 'error') return <p className="text-[0.88rem] text-ink-muted">Couldn&apos;t compare with PayPal just now.</p>;
  if (!r && state === 'loading') return <p className="text-[0.88rem] text-ink-muted">Comparing with PayPal…</p>;
  if (!r) return null;
  const search = r.transactionSearch;
  const searchNote =
    search.state === 'matches'
      ? `Transaction Search has all ${search.indexed} transactions.`
      : search.state === 'not_indexed_yet'
        ? `Transaction Search: ${search.waiting} not indexed yet (PayPal takes up to 3 hours), ${search.indexed} found.`
        : search.state === 'missing_scope'
          ? 'Transaction Search is not enabled for this sandbox app, so only the batch was compared.'
          : search.state === 'unavailable'
            ? 'Transaction Search could not be reached, so only the batch was compared.'
            : null;
  const fees = r.feesCents !== null && r.feesCents > 0 ? ` PayPal fees ${usd(r.feesCents)}.` : '';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {r.state === 'matches' ? <StatusChip label="Reconciled with PayPal" tone="allow" /> : null}
        {r.state === 'differences' ? <StatusChip label={`${r.differences.length} ${r.differences.length === 1 ? 'difference' : 'differences'} from PayPal`} tone="block" /> : null}
        {r.state === 'in_progress' ? <StatusChip label="PayPal still processing" tone="hold" /> : null}
        {r.state === 'unavailable' ? <StatusChip label="Not compared" tone="muted" /> : null}
        <span className="text-[0.88rem] text-ink-muted">
          {r.state === 'matches' ? `All ${r.items} items agree with PayPal's batch: amount, status and transaction id.${fees}` : null}
          {r.state === 'in_progress' ? `Compared at ${when(r.checkedMs)}; PayPal reports the batch as ${(r.paypalBatchStatus ?? '').toLowerCase()}.` : null}
          {r.state === 'unavailable' || r.state === 'not_submitted' ? r.detail : null}
          {searchNote ? ` ${searchNote}` : null}
        </span>
      </div>
      {r.differences.length > 0 && r.state !== 'in_progress' ? (
        <ul className="space-y-1 text-[0.88rem]">
          {r.differences.map((d, n) => (
            <li key={n} className="num">
              <span className="font-semibold">{d.recipientId ?? 'Batch'}</span>: {FIELD[d.field]}. Ours {d.ledger ?? 'none'}, PayPal {d.paypal ?? 'none'}.
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function day(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The batch's end-to-end clock, measured from the audit log's timestamps. */
function Clock({ c }: { c: BatchView['clock'] }) {
  if (c.sentMs === null && c.assessedMs === null) return null;
  const steps: { label: string; at: number | null; note?: string }[] = [
    ...(c.assessedMs !== null ? [{ label: 'assessed', at: c.assessedMs }] : []),
    c.approvedMs !== null ? { label: 'approved', at: c.approvedMs } : { label: 'no approval needed', at: null },
    { label: 'sent to PayPal', at: c.sentMs },
    c.finishedMs !== null
      ? { label: c.allPaid ? 'all paid' : 'PayPal finished', at: c.finishedMs, note: c.sentMs !== null ? duration(c.finishedMs - c.sentMs) : undefined }
      : { label: c.sentMs !== null ? 'waiting for PayPal' : 'not sent yet', at: null },
  ];
  return (
    <div className="border-b border-line-soft px-5 py-3 text-[0.9rem]">
      <ol className="num flex flex-wrap gap-x-2 gap-y-1 text-ink-muted" aria-label="End-to-end timing">
        {steps.map((s, n) => (
          <li key={s.label}>
            {n === 0 ? s.label[0]!.toUpperCase() + s.label.slice(1) : s.label}
            {s.at !== null ? (
              <>
                {' '}
                <span className="font-semibold text-ink">{clockTime(s.at)}</span>
              </>
            ) : null}
            {s.note ? <span className="font-semibold text-ink"> ({s.note} after sending)</span> : null}
            {n < steps.length - 1 ? <span aria-hidden>,</span> : null}
          </li>
        ))}
      </ol>
      <p className="mt-0.5 text-[0.85rem] text-ink-dim">
        Our clock, measured from the audit log&apos;s timestamps; PayPal keeps its own.
        {c.assessedMs !== null && c.finishedMs !== null ? ` Assessment to money final: ${duration(c.finishedMs - c.assessedMs)}, including the time a person took to approve.` : ''}
        {c.firstWebhookMs !== null ? ` First verified PayPal webhook at ${clockTime(c.firstWebhookMs)}.` : ''}
      </p>
    </div>
  );
}

/** This batch's steps in the audit log, each linking to the filtered log at that entry. */
function AuditTrail({ b }: { b: BatchView }) {
  if (b.audit.length === 0) return null;
  const batch = b.paypalBatchId ?? String(b.id);
  const groups = trailGroups(b.audit);
  return (
    <div className="border-b border-line-soft px-5 py-3 text-[0.9rem]">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-ink-muted">In the audit log:</span>
        {groups.map((g, n) => (
          <span key={g.type}>
            <Link
              href={g.count === 1 ? auditHref({ batch }, g.firstSeq) : auditHref({ batch, type: g.type }, g.firstSeq)}
              className="text-allow underline-offset-2 hover:underline"
            >
              <span className="num">#{g.firstSeq}</span> {g.label}
            </Link>
            {n < groups.length - 1 ? <span aria-hidden>,</span> : null}
          </span>
        ))}
      </p>
      <p className="mt-0.5 text-[0.85rem] text-ink-dim">
        See{' '}
        <Link href={auditHref({ batch })} className="text-allow underline-offset-2 hover:underline">
          all {b.audit.length} entries for this batch
        </Link>
        {b.planId ? (
          <>
            , or{' '}
            <Link href={auditHref({ plan: b.planId })} className="text-allow underline-offset-2 hover:underline">
              everything for plan {b.planId}
            </Link>{' '}
            from its firewall verdict on
          </>
        ) : null}
        .
      </p>
    </div>
  );
}

/** CSV columns for finance: plain values, amounts in dollars. */
const CSV_COLUMNS: Record<string, string> = {
  recipientId: 'recipient',
  town: 'town',
  amountCents: 'amount_usd',
  status: 'status',
  transactionId: 'paypal_transaction_id',
  errorName: 'failure_reason',
};

function csvCell(p: ProcessCellForExportParams<Item>): string {
  const v = p.value as unknown;
  if (p.column.getColId() === 'amountCents') return typeof v === 'number' ? (v / 100).toFixed(2) : '';
  return v === null || v === undefined ? '' : String(v);
}

/** Below 768 px: one card per payout item instead of the grid. */
function ItemCards({
  items,
  status,
  cancelling,
  onCancel,
}: {
  items: Item[];
  status: (i: Item) => { label: string; tone: Parameters<typeof StatusChip>[0]['tone'] };
  cancelling: string | null;
  onCancel: (i: Item) => void;
}) {
  return (
    <ul className="divide-y divide-line-soft md:hidden">
      {items.map((i) => {
        const st = status(i);
        return (
          <li key={i.recipientId} className="px-4 py-3">
            <span className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block font-semibold leading-snug">{i.town || i.recipientId}</span>
                <span className="num block text-[0.82rem] text-ink-dim">{i.recipientId}</span>
              </span>
              <span className="num shrink-0 text-[1.05rem] font-[800]">{usd(i.amountCents)}</span>
            </span>
            <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <StatusChip label={st.label} tone={st.tone} />
              {i.errorName ? (
                <span className="num text-[0.85rem] text-block-ink">{i.errorName.replaceAll('_', ' ').toLowerCase()}</span>
              ) : i.transactionId ? (
                <span className="num break-all text-[0.85rem] text-ink-muted">Transaction {i.transactionId}</span>
              ) : null}
            </span>
            {i.canCancel || i.autoReturnMs !== null ? (
              <span className="mt-2 flex flex-wrap items-center gap-2.5">
                {i.canCancel ? (
                  <button className="btn btn-stop h-8 px-2.5 text-[0.85rem]" onClick={() => onCancel(i)} disabled={cancelling !== null}>
                    {cancelling === i.recipientId ? 'Cancelling…' : 'Cancel payout'}
                  </button>
                ) : null}
                {i.autoReturnMs !== null ? (
                  <span className="num text-[0.85rem] text-ink-muted">
                    {i.canCancel ? 'or ' : ''}PayPal returns it {day(i.autoReturnMs)}
                  </span>
                ) : null}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function Batch({ b, reconciliation, reconcileState }: { b: BatchView; reconciliation: BatchReconciliation | undefined; reconcileState: 'loading' | 'error' | 'done' }) {
  const { bump } = useLive();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const grid = useRef<AgGridReact<Item>>(null);
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
  const cancel = async (i: Item) => {
    if (!window.confirm(`Cancel the unclaimed ${usd(i.amountCents)} payout to ${i.recipientId}? PayPal returns the money to the pool.`)) return;
    setCancelling(i.recipientId);
    setError(null);
    try {
      await call(`/api/batches/${b.id}/items/${encodeURIComponent(i.recipientId)}/cancel`, { body: {} });
      bump();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setCancelling(null);
    }
  };
  const downloadCsv = () =>
    grid.current?.api.exportDataAsCsv({
      fileName: `firstlight-batch-${b.paypalBatchId ?? `local-${b.id}`}.csv`,
      columnKeys: Object.keys(CSV_COLUMNS),
      processCellCallback: csvCell,
      processHeaderCallback: (p: ProcessHeaderForExportParams<Item>) => CSV_COLUMNS[p.column.getColId()] ?? p.column.getColId(),
    });
  const anyCancellable = b.items.some((i) => i.canCancel || i.autoReturnMs !== null);
  const unclaimed = b.items.filter((i) => i.status === 'UNCLAIMED' && i.autoReturnMs !== null);
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
        <p className="num text-[0.9rem] text-ink-muted">
          <span className="font-bold text-ink">{b.verifiedWebhooks}</span> {b.verifiedWebhooks === 1 ? 'webhook' : 'webhooks'} from PayPal, signature verified
        </p>
        {b.feesCents > 0 ? (
          <p className="num text-[0.9rem] text-ink-muted">
            PayPal fees <span className="font-bold text-ink">{usd(b.feesCents)}</span>, paid from the pool
          </p>
        ) : null}
        <div className="ml-auto flex items-center gap-3">
          {b.polling ? <span className="text-[0.85rem] text-hold">Checking PayPal every 2 s</span> : null}
          <button className="btn h-8" onClick={downloadCsv} disabled={b.items.length === 0}>
            Download CSV
          </button>
          <button className="btn h-8" onClick={refresh} disabled={busy || !b.paypalBatchId}>
            {busy ? 'Checking…' : 'Check status now'}
          </button>
        </div>
      </div>
      <Clock c={b.clock} />
      {b.paypalBatchId ? (
        <div className="border-b border-line-soft px-5 py-3">
          <Reconciled r={reconciliation} state={reconcileState} />
        </div>
      ) : null}
      {unclaimed.length > 0 ? (
        <div className="border-b border-line-soft px-5 py-3">
          <Notice>
            {unclaimed.length === 1 ? 'One payout is' : `${unclaimed.length} payouts are`} unclaimed: the household hasn&apos;t accepted the money at PayPal yet. Ask the field
            partner to contact the household so they can claim it. If nobody does, PayPal returns it to the pool on {day(unclaimed[0]!.autoReturnMs!)}, 30 days after the batch;
            you can also cancel it now.
          </Notice>
        </div>
      ) : null}
      {error ? (
        <div className="p-3">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}
      <AuditTrail b={b} />
      <ItemCards items={b.items} status={(i) => itemStatus(batchLike, i.recipientId, 'ALLOW')} cancelling={cancelling} onCancel={cancel} />
      <div className="hidden md:block">
      <AgGridReact<Item>
        ref={grid}
        theme={gridTheme}
        domLayout="autoHeight"
        rowData={b.items}
        getRowId={(p) => p.data.recipientId}
        context={{ cancelling }}
        columnDefs={[
          { field: 'recipientId', headerName: 'Recipient', width: 140, cellClass: 'font-semibold' },
          { field: 'town', headerName: 'Town', flex: 1, minWidth: 150 },
          { field: 'amountCents', headerName: 'Amount', width: 120, type: 'rightAligned', cellClass: 'num font-semibold', valueFormatter: (p) => usd(p.value) },
          // Export-only columns: the grid shows them combined below.
          { field: 'transactionId', hide: true },
          { field: 'errorName', hide: true },
          {
            field: 'status',
            headerName: 'PayPal status',
            width: 170,
            cellRenderer: (p: { data: Item }) => {
              const st = itemStatus(batchLike, p.data.recipientId, 'ALLOW');
              return <StatusChip label={st.label} tone={st.tone} />;
            },
          },
          {
            headerName: 'PayPal transaction or reason',
            flex: 1,
            minWidth: 200,
            cellClass: 'num',
            valueGetter: (p) => (p.data?.errorName ? p.data.errorName.replaceAll('_', ' ').toLowerCase() : (p.data?.transactionId ?? '')),
            cellClassRules: { 'text-block-ink': (p) => !!p.data?.errorName },
          },
          ...(anyCancellable
            ? [
                {
                  headerName: 'Return',
                  width: 330,
                  sortable: false,
                  cellRenderer: (p: { data: Item }) =>
                    p.data.autoReturnMs !== null || p.data.canCancel ? (
                      <span className="flex items-center gap-2.5">
                        {p.data.canCancel ? (
                          <button className="btn btn-stop h-7 px-2.5 text-[0.85rem]" onClick={() => cancel(p.data)} disabled={cancelling !== null}>
                            {cancelling === p.data.recipientId ? 'Cancelling…' : 'Cancel payout'}
                          </button>
                        ) : null}
                        {p.data.autoReturnMs !== null ? (
                          <span className="num text-[0.85rem] text-ink-muted">
                            {p.data.canCancel ? 'or ' : ''}PayPal returns it {day(p.data.autoReturnMs)}
                          </span>
                        ) : null}
                      </span>
                    ) : null,
                },
              ]
            : []),
        ]}
      />
      </div>
    </section>
  );
}

export default function PayoutsPage() {
  const { data, error, reload } = useApi<{ batches: BatchView[] }>('/api/batches');
  const batches = data?.batches ?? [];
  const submitted = batches.some((b) => b.paypalBatchId);
  const rec = useApi<ReconcileView>(submitted ? '/api/reconcile' : null);
  const byBatch = new Map((rec.data?.batches ?? []).map((r) => [r.batchId, r]));
  const reconcileState = rec.data ? 'done' : rec.error ? 'error' : 'loading';
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[1.4rem] font-[800]">Payouts</h1>
        <p className="mt-1 max-w-[72ch] text-ink-muted">
          Every batch sent to PayPal Payouts in the sandbox. Statuses update live from PayPal webhooks, and from polling every 2 s when no webhook can reach this server. Each batch is
          also compared with PayPal&apos;s own record of it.
        </p>
      </div>
      <LoadError error={error} onRetry={reload} />
      {!data && !error ? <Loading what="payouts" /> : null}
      {data && batches.length === 0 ? <p className="panel p-5 text-ink-muted">No payouts sent yet. Approve a plan and send it from its page.</p> : null}
      {rec.data && !rec.data.configured && submitted ? <Notice>{rec.data.message}</Notice> : null}
      {batches.map((b) => (
        <Batch key={b.id} b={b} reconciliation={byBatch.get(b.id)} reconcileState={reconcileState} />
      ))}
      <SandboxEvidence />
    </div>
  );
}
