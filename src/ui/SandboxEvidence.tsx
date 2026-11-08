'use client';

import type { RecordedCheck, RecordedDifference, RecordedView } from '@/paypal/recorded';
import { StatusChip, usd } from '@/ui/format';
import { useApi } from '@/ui/live';

/**
 * Real PayPal sandbox runs we made while building, so a judge sees evidence
 * before sending anything (the hosted database resets on restart). Each id is
 * a real sandbox object; docs/decisions.md records how each run went, and the
 * details below are copied from those notes, nothing more. Payout batches are
 * also read back from PayPal (GET /api/reconcile/recorded, read-only, cached
 * 10 minutes) and compared with what we recorded.
 */
type Run = {
  when: string;
  what: string;
  id: string;
  idLabel: string;
  result: string;
  /** What we recorded about the run, shown when the row is opened. */
  facts: { label: string; value: string }[];
};

const RUNS: Run[] = [
  {
    when: '8 Nov 2026',
    what: 'Hosted demo: $680 to 7 households',
    id: '9GE626X9SA3NE',
    idLabel: 'Payout batch',
    result: 'SUCCESS in about 25 s; 7 PAYMENT.PAYOUTS-ITEM.SUCCEEDED webhooks, each signature-verified',
    facts: [
      { label: 'Where', value: 'firstlight.onrender.com, replayed assessment, approved in the console' },
      { label: 'Items', value: '7 of 7 SUCCESS, $680.00 in total' },
      { label: 'Timing', value: 'Batch SUCCESS at about 25 s, seen by polling' },
      { label: 'Webhooks', value: '7 PAYMENT.PAYOUTS-ITEM.SUCCEEDED deliveries, each checked with verify-webhook-signature before use' },
      { label: 'Also', value: 'An unsigned probe delivery was refused and audited; audit chain intact (20 entries)' },
    ],
  },
  {
    when: '8 Nov 2026',
    what: 'Dashboard run: $680 to 7 households',
    id: 'DZCFDP9FFEUV8',
    idLabel: 'Payout batch',
    result: 'All 7 items SUCCESS, shown live without a reload',
    facts: [
      { label: 'Where', value: 'The dashboard after a demo reset: replayed AI agent assessment, approved in the UI' },
      { label: 'Items', value: '7 of 7 SUCCESS, $680.00 in total' },
      { label: 'Timing', value: 'Statuses arrived live on the page without a reload (no seconds recorded)' },
      { label: 'Audit', value: 'Chain verified, 15 entries' },
    ],
  },
  {
    when: '8 Nov 2026',
    what: 'First end-to-end payout from the CLI',
    id: '2BQ585TNCTVDA',
    idLabel: 'Payout batch',
    result: 'Items SUCCESS at about 26 s, batch at about 33 s',
    facts: [
      { label: 'Where', value: 'The CLI: a live AI agent assessment (2 turns, about 24 s), approved via the CLI' },
      { label: 'Items', value: '7 recipients, $680.00, all SUCCESS; pool $5,000 → $4,320' },
      { label: 'Timing', value: 'Assessment about 24 s; items SUCCESS at about 26 s and batch SUCCESS at about 33 s after sending' },
      { label: 'Audit', value: 'Chain intact, 12 entries' },
    ],
  },
  {
    when: '8 Nov 2026',
    what: 'Donor agent (Samaritan) $5 donation',
    id: '2M270176F8691393V',
    idLabel: 'Order capture',
    result: 'Approved by a person on PayPal, captured, pool $4,320 → $4,325',
    facts: [
      { label: 'Path', value: 'Manifest, MCP create_donation, Orders v2 via the PayPal Server SDK' },
      { label: 'Outcome', value: 'A person approved on PayPal; the return URL captured it; pool $4,320 → $4,325' },
      { label: 'Audit', value: 'Samaritan checked its receipt, audit entry 18, in an intact chain' },
    ],
  },
  {
    when: '8 Nov 2026',
    what: '$1 smoke test',
    id: 'DHSSBZRTMH9DW',
    idLabel: 'Payout batch',
    result: 'SUCCESS in about 22 s, transaction 7T759407LM597511H',
    facts: [
      { label: 'Path', value: 'npm run smoke:payout -- --send' },
      { label: 'Items', value: '1 of 1 SUCCESS, $1.00, transaction 7T759407LM597511H' },
      { label: 'Timing', value: 'PENDING → PROCESSING → SUCCESS in about 22 s' },
    ],
  },
];

const FIELD: Record<RecordedDifference['field'], string> = {
  batch_status: 'Batch status',
  batch_total: 'Batch total',
  item_count: 'Number of items',
  missing_at_paypal: 'Not in PayPal’s batch',
  missing_in_ledger: 'In PayPal’s batch but not recorded',
  amount: 'Amount',
  currency: 'Currency',
  status: 'Item status',
  transaction_id: 'Transaction id',
  search_status: 'Transaction Search status',
  search_amount: 'Transaction Search amount',
  search_missing: 'Not found in Transaction Search',
};

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 ? ` ${s % 60} s` : ''}`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function statusList(c: Extract<RecordedCheck, { itemStatuses: unknown }>): string {
  const entries = Object.entries(c.itemStatuses);
  const noun = `${c.itemCount} ${c.itemCount === 1 ? 'item' : 'items'}`;
  if (entries.length === 1 && entries[0]![1] === c.itemCount) return `${noun}, ${c.itemCount === 1 ? '' : 'all '}${entries[0]![0].toLowerCase()}`;
  return `${noun}${entries.length ? `: ${entries.map(([s, n]) => `${n} ${s.toLowerCase()}`).join(', ')}` : ''}`;
}

/** One line: what PayPal says about this batch right now. */
function LiveLine({ c, loading }: { c: RecordedCheck | undefined; loading: boolean }) {
  if (!c) return <span className="text-ink-dim">{loading ? 'Asking PayPal for this batch now…' : "Couldn't reach PayPal just now."}</span>;
  if (c.state === 'unavailable') return <span className="text-ink-dim">Couldn&apos;t reach PayPal: {c.detail}</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {c.state === 'matches' ? <StatusChip label="PayPal agrees with our record" tone="allow" /> : null}
      {c.state === 'differences' ? <StatusChip label={`${c.differences.length} ${c.differences.length === 1 ? 'difference' : 'differences'} from our record`} tone="block" /> : null}
      {c.state === 'in_progress' ? <StatusChip label="PayPal still processing" tone="hold" /> : null}
      <span className="num text-ink-muted">
        PayPal now: batch {c.batchStatus.toLowerCase()}, {statusList(c)}
        {c.totalCents !== null ? `, ${usd(c.totalCents)}` : ''}
        {c.feesCents !== null ? `, PayPal fees ${usd(c.feesCents)}` : ''}. Checked {clockTime(c.checkedMs)}.
      </span>
    </span>
  );
}

function LiveFacts({ c }: { c: RecordedCheck | undefined }) {
  if (!c || c.state === 'unavailable') return null;
  return (
    <>
      <dt className="text-ink-dim">PayPal now</dt>
      <dd className="num text-ink-muted">
        Batch {c.batchStatus.toLowerCase()}; {statusList(c)}; total {c.totalCents !== null ? usd(c.totalCents) : 'not given'}; PayPal fees{' '}
        {c.feesCents !== null ? usd(c.feesCents) : 'not given'}. Read from PayPal at {clockTime(c.checkedMs)}.
      </dd>
      {c.createdMs !== null ? (
        <>
          <dt className="text-ink-dim">PayPal&apos;s clock</dt>
          <dd className="num text-ink-muted">
            Created {clockTime(c.createdMs)}
            {c.completedMs !== null ? `, completed ${clockTime(c.completedMs)} (${duration(c.completedMs - c.createdMs)})` : ', not completed yet'}
          </dd>
        </>
      ) : null}
      {c.differences.length > 0 ? (
        <>
          <dt className="text-ink-dim">Differences</dt>
          <dd>
            <ul className="space-y-0.5 text-ink-muted">
              {c.differences.map((d, n) => (
                <li key={n} className="num">
                  {d.recipientId ?? 'Batch'}: {FIELD[d.field]}. Recorded {d.ledger ?? 'none'}, PayPal {d.paypal ?? 'none'}.
                </li>
              ))}
            </ul>
          </dd>
        </>
      ) : null}
    </>
  );
}

export function SandboxEvidence() {
  const { data, loading } = useApi<RecordedView>('/api/reconcile/recorded');
  const live = new Map((data?.batches ?? []).map((b) => [b.paypalBatchId, b]));
  return (
    <section className="panel overflow-hidden" aria-labelledby="evidence-title">
      <div className="border-b border-line-soft px-5 py-4">
        <h2 id="evidence-title" className="text-[1.05rem] font-bold">
          Runs already made in the PayPal sandbox
        </h2>
        <p className="max-w-[72ch] text-[0.92rem] text-ink-muted">
          The demo database starts empty after every restart, so here are the real sandbox runs we made while building it. The ids are PayPal&apos;s own. Each payout batch is read
          back from PayPal now (read-only, at most every 10 minutes) and compared with what we recorded. Open a run to see the details.
        </p>
      </div>
      <ul>
        {RUNS.map((r) => {
          const isBatch = r.idLabel === 'Payout batch';
          return (
            <li key={r.id} className="border-b border-line-soft last:border-0">
              <details className="group">
                <summary className="grid cursor-pointer list-none gap-x-5 gap-y-1 px-5 py-2.5 text-[0.92rem] hover:bg-raised sm:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,1.5fr)]">
                  <span>
                    <span aria-hidden className="mr-1.5 inline-block w-3 text-ink-dim transition-transform group-open:rotate-90">
                      ›
                    </span>
                    <span className="font-semibold">{r.what}</span>
                    <span className="block pl-[1.125rem] text-[0.85rem] text-ink-dim">{r.when}</span>
                  </span>
                  <span className="pl-[1.125rem] sm:pl-0">
                    <span className="block text-[0.82rem] text-ink-dim">{r.idLabel}</span>
                    <span className="num break-all">{r.id}</span>
                  </span>
                  <span className="pl-[1.125rem] text-ink-muted sm:pl-0">{r.result}</span>
                  {isBatch ? (
                    <span className="pl-[1.125rem] text-[0.88rem] sm:col-span-3">
                      <LiveLine c={live.get(r.id)} loading={loading && !data} />
                    </span>
                  ) : null}
                </summary>
                <dl className="grid gap-x-5 gap-y-1.5 bg-raised px-5 py-3 pl-[2.375rem] text-[0.88rem] sm:grid-cols-[9rem_minmax(0,1fr)]">
                  <dt className="text-ink-dim">{r.idLabel}</dt>
                  <dd className="num break-all">{r.id}</dd>
                  {r.facts.map((f) => (
                    <div key={f.label} className="contents">
                      <dt className="text-ink-dim">{f.label === 'Timing' ? 'Recorded timing' : f.label}</dt>
                      <dd className="text-ink-muted">{f.value}</dd>
                    </div>
                  ))}
                  {isBatch ? <LiveFacts c={live.get(r.id)} /> : null}
                </dl>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
