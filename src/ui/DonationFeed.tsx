'use client';

import { useState } from 'react';
import { StatusChip, type Tone } from './format';
import { ApiError, call } from './live';

export type FeedItem = {
  receiptId: string;
  source: 'human' | 'agent';
  donorRef: string;
  /** Agent donations: short allowance handle (alid_ + 6 hex), so two agents, or an agent and a person, never look alike. */
  agentHandle?: string | null;
  message: string | null;
  amountUsd: string;
  status: string;
  createdAt: string;
};

const STATUS: Record<string, { label: string; tone: Tone }> = {
  CAPTURED: { label: 'Received', tone: 'allow' },
  AWAITING_APPROVAL: { label: 'Waiting for approval', tone: 'hold' },
  CREATING: { label: 'Creating', tone: 'hold' },
  CANCELED: { label: 'Cancelled', tone: 'muted' },
  FAILED: { label: 'Failed', tone: 'block' },
  PENDING: { label: 'Pending at PayPal', tone: 'hold' },
  REFUNDED: { label: 'Refunded', tone: 'muted' },
  PARTIALLY_REFUNDED: { label: 'Partly refunded', tone: 'hold' },
  REVERSED: { label: 'Reversed', tone: 'block' },
  DENIED: { label: 'Denied by PayPal', tone: 'block' },
  PAYER_MISMATCH: { label: 'Held: different PayPal account', tone: 'block' },
};

const REFUNDABLE = ['CAPTURED', 'PARTIALLY_REFUNDED'];

/** Staff refund from the console: POST /api/donations/{receiptId}/refund for everything not yet returned. */
export async function refundFromConsole(receiptId: string): Promise<string> {
  try {
    const r = await call<{ status: string; refundedUsd: string; refundStatus: string }>(`/api/donations/${receiptId}/refund`, { method: 'POST', body: {} });
    return r.refundStatus === 'COMPLETED' ? `Refunded $${r.refundedUsd} through PayPal.` : 'PayPal is still processing the refund.';
  } catch (e) {
    return e instanceof ApiError ? e.message : 'The refund did not go through.';
  }
}

type Handlers = { onVerify?: (receiptId: string) => Promise<string>; onRefund?: (receiptId: string) => Promise<string> };

/**
 * Recent donations. donorRef and message come from strangers (including other
 * AI agents): they are rendered as React text, never as HTML, so markup or
 * script in them shows up as plain characters.
 */
export function DonationFeed({ items, onVerify, onRefund }: { items: FeedItem[] } & Handlers) {
  if (items.length === 0) return <p className="p-5 text-ink-muted">No donations yet.</p>;
  return (
    <ul className="divide-y divide-line-soft">
      {items.map((d) => (
        <FeedRow key={d.receiptId} d={d} onVerify={onVerify} onRefund={onRefund} />
      ))}
    </ul>
  );
}

function FeedRow({ d, onVerify, onRefund }: { d: FeedItem } & Handlers) {
  const [result, setResult] = useState<string | null>(null);
  const [refundBusy, setRefundBusy] = useState(false);
  const showVerify = onVerify && d.status === 'CAPTURED';
  const showRefund = onRefund && REFUNDABLE.includes(d.status);
  const st = STATUS[d.status] ?? { label: d.status, tone: 'muted' as Tone };
  return (
    <li className="grid gap-x-4 gap-y-1 px-5 py-3 sm:grid-cols-[1fr_auto]">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2">
          <span className="num text-[1.05rem] font-bold">${d.amountUsd}</span>
          <span className="min-w-0 break-words font-semibold">{d.donorRef}</span>
          <span className="rounded-[var(--radius-chip)] border border-line-soft px-1.5 text-[0.75rem] text-ink-muted">
            {d.source === 'agent' ? (d.agentHandle ? <>AI agent <span className="num">{d.agentHandle}</span></> : 'AI agent') : 'Person'}
          </span>
          <StatusChip label={st.label} tone={st.tone} />
        </p>
        {d.message ? <p className="mt-0.5 max-w-[70ch] break-words text-[0.92rem] text-ink-muted">“{d.message}”</p> : null}
        <p className="num mt-0.5 text-[0.8rem] text-ink-dim">
          <a href={`/api/receipts/${d.receiptId}`} className="hover:text-black hover:underline">
            {d.receiptId}
          </a>{' '}
          {new Date(d.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
        </p>
      </div>
      {showVerify || showRefund || result ? (
        <div className="flex flex-wrap items-start gap-3 sm:justify-end">
          {result ? <span className="text-[0.85rem] text-ink-muted">{result}</span> : null}
          {showVerify ? (
            <button className="btn h-8" onClick={async () => setResult(await onVerify(d.receiptId))}>
              Verify this donation
            </button>
          ) : null}
          {showRefund ? (
            <button
              className="btn h-8"
              disabled={refundBusy}
              onClick={async () => {
                if (!window.confirm(`Refund what is left of this $${d.amountUsd} donation to the donor through PayPal? It comes out of the pool.`)) return;
                setRefundBusy(true);
                try {
                  setResult(await onRefund(d.receiptId));
                } finally {
                  setRefundBusy(false);
                }
              }}
            >
              {refundBusy ? 'Refunding…' : 'Refund'}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
