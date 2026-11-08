'use client';

import { useState } from 'react';
import { StatusChip, type Tone } from './format';

export type FeedItem = {
  receiptId: string;
  source: 'human' | 'agent';
  donorRef: string;
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
};

/**
 * Recent donations. donorRef and message come from strangers (including other
 * AI agents): they are rendered as React text, never as HTML, so markup or
 * script in them shows up as plain characters.
 */
export function DonationFeed({ items, onVerify }: { items: FeedItem[]; onVerify?: (receiptId: string) => Promise<string> }) {
  if (items.length === 0) return <p className="p-5 text-ink-muted">No donations yet.</p>;
  return (
    <ul className="divide-y divide-line-soft">
      {items.map((d) => (
        <FeedRow key={d.receiptId} d={d} onVerify={onVerify} />
      ))}
    </ul>
  );
}

function FeedRow({ d, onVerify }: { d: FeedItem; onVerify?: (receiptId: string) => Promise<string> }) {
  const [result, setResult] = useState<string | null>(null);
  const st = STATUS[d.status] ?? { label: d.status, tone: 'muted' as Tone };
  return (
    <li className="grid gap-x-4 gap-y-1 px-5 py-3 sm:grid-cols-[1fr_auto]">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2">
          <span className="num text-[1.05rem] font-bold">${d.amountUsd}</span>
          <span className="min-w-0 break-words font-semibold">{d.donorRef}</span>
          <span className="rounded-[var(--radius-chip)] border border-line-soft px-1.5 text-[0.75rem] text-ink-muted">{d.source === 'agent' ? 'AI agent' : 'Person'}</span>
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
      {onVerify && d.status === 'CAPTURED' ? (
        <div className="flex items-start gap-3 sm:justify-end">
          {result ? <span className="text-[0.85rem] text-ink-muted">{result}</span> : null}
          <button className="btn h-8" onClick={async () => setResult(await onVerify(d.receiptId))}>
            Verify this donation
          </button>
        </div>
      ) : null}
    </li>
  );
}
