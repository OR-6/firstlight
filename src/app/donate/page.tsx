'use client';

import { Suspense, useEffect, useId, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { DonationFeed, type FeedItem } from '@/ui/DonationFeed';
import { LoadError, Notice, usd } from '@/ui/format';
import { ApiError, call, useApi, useLive } from '@/ui/live';

type Pool = { balanceUsd: string; totalDisbursedUsd: string; recipientsReached: number; donationsReceivedUsd: string; donationsCount: number };
type Receipt = {
  receiptId: string;
  status: string;
  amountUsd: string;
  donorRef: string;
  capturedAt: string | null;
  paypal: { orderId: string | null; captureId: string | null };
  audit: { created: { seq: number; hash: string } | null; captured: { seq: number; hash: string } | null; verifyUrl: string | null };
  poolSummary: { totalDisbursedUsd: string; recipientsCount: number };
};

const PRESETS = [5, 10, 25, 50];
const RECEIPT_ID = /^rcpt_[0-9a-f]{16}$/;

/** Fixed text for each error code the return route can send. Never show text from the URL itself. */
const RETURN_ERRORS: Record<string, string> = {
  UNKNOWN_RECEIPT: "That link doesn't match a donation.",
  NOT_FOUND: "That link doesn't match a donation.",
  NOT_CAPTURABLE: 'This donation was cancelled or already finished, so it was not charged again.',
  ORDER_MISMATCH: "PayPal sent back a different order than this receipt, so nothing was charged.",
  PAYPAL: "PayPal didn't complete the payment. Nothing was charged. Try donating again.",
  CAPTURE_FAILED: "PayPal didn't complete the payment. Nothing was charged. Try donating again.",
};

async function verifyReceipt(receiptId: string): Promise<string> {
  const r = await call<Receipt>(`/api/receipts/${receiptId}`);
  const entry = r.audit.captured ?? r.audit.created;
  if (!entry) return 'No audit entry yet.';
  const check = await call<{ ok: boolean; count: number }>(`/api/audit/verify?upTo=${entry.hash}`);
  return check.ok ? `Verified: audit entry ${entry.seq} is in an intact chain of ${check.count}.` : 'The audit chain does not verify.';
}

export default function DonatePage() {
  return (
    <Suspense>
      <Donate />
    </Suspense>
  );
}

function Donate() {
  const params = useSearchParams();
  const rawReceipt = params.get('receipt');
  const receiptId = rawReceipt && RECEIPT_ID.test(rawReceipt) ? rawReceipt : null;
  const errorCode = params.get('error');
  const { data: pool, error: poolError, reload: reloadPool } = useApi<Pool>('/api/pool');
  // Shown in place of a figure until the pool loads (or if it can't).
  const pending = poolError ? 'Not available' : 'Loading…';
  const { data: feed } = useApi<{ donations: FeedItem[] }>('/api/donations');
  const cents = (s: string | undefined) => Math.round(Number(s ?? 0) * 100);

  const totalIn = pool ? cents(pool.balanceUsd) + cents(pool.totalDisbursedUsd) : 0;
  const paidShare = pool && totalIn ? (cents(pool.totalDisbursedUsd) / totalIn) * 100 : 0;
  const agents = (feed?.donations ?? []).filter((d) => d.source === 'agent');
  const people = (feed?.donations ?? []).filter((d) => d.source === 'human');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[1.5rem] font-[800]">Fund the relief pool</h1>
        <p className="mt-1 max-w-[70ch] text-ink-muted">
          Donations go into the pool that Firstlight pays relief from. This runs in the PayPal sandbox: approve with a sandbox personal account, and no real money moves.
        </p>
      </div>

      {errorCode && !receiptId ? <Notice tone="error">{RETURN_ERRORS[errorCode] ?? RETURN_ERRORS.CAPTURE_FAILED}</Notice> : null}
      {rawReceipt && !receiptId ? <Notice tone="error">{RETURN_ERRORS.UNKNOWN_RECEIPT}</Notice> : null}
      {receiptId ? <ReceiptPanel receiptId={receiptId} canceled={params.get('canceled') === '1'} error={errorCode} /> : null}

      <div className="grid gap-5 lg:grid-cols-12">
        <section className="panel p-5 lg:col-span-5" aria-labelledby="pool-title">
          <h2 id="pool-title" className="text-[1.05rem] font-bold">
            Pool
          </h2>
          <p className="num mt-1 text-[2.25rem] font-[800] leading-tight" aria-busy={!pool && !poolError}>
            {pool ? usd(cents(pool.balanceUsd)) : <span className="text-[1.25rem] font-semibold text-ink-dim">{pending}</span>}
          </p>
          <p className="text-ink-muted">available for relief payouts</p>
          <div className="mt-4 h-3 overflow-hidden rounded-[var(--radius-chip)] border border-line bg-raised" role="img" aria-label={`${Math.round(paidShare)}% of the money in the pool has been paid out`}>
            <div className="h-full bg-allow" style={{ width: `${paidShare}%` }} />
          </div>
          <dl className="num mt-3 grid grid-cols-[1fr_auto] gap-y-1 text-[0.94rem]">
            <dt className="text-ink-muted">Paid to people affected</dt>
            <dd className="font-semibold">
              {pool ? `${usd(cents(pool.totalDisbursedUsd))} to ${pool.recipientsReached}` : <span className="font-normal text-ink-dim">{pending}</span>}
            </dd>
            <dt className="text-ink-muted">Donated</dt>
            <dd className="font-semibold">
              {pool ? `${usd(cents(pool.donationsReceivedUsd))} from ${pool.donationsCount}` : <span className="font-normal text-ink-dim">{pending}</span>}
            </dd>
          </dl>
          {poolError ? (
            <div className="mt-3">
              <LoadError error={poolError} onRetry={reloadPool} />
            </div>
          ) : null}
          <p className="mt-3 text-[0.85rem] text-ink-dim">The demo pool started with a $5,000 sandbox float.</p>
        </section>

        <DonateForm />
      </div>

      <section className="panel overflow-hidden" aria-labelledby="agents-title">
        <div className="border-b border-line-soft px-5 py-4">
          <h2 id="agents-title" className="text-[1.05rem] font-bold">
            Agent donors
          </h2>
          <p className="max-w-[72ch] text-[0.92rem] text-ink-muted">
            Other AI agents can find Firstlight through <a className="text-allow underline-offset-2 hover:underline" href="/.well-known/firstlight.json">its manifest</a> and donate over MCP. A person still approves every payment on PayPal. Their messages are shown as plain text and never reach the payout agent.
          </p>
        </div>
        <DonationFeed items={agents} onVerify={verifyReceipt} />
      </section>

      {people.length ? (
        <section className="panel overflow-hidden" aria-labelledby="people-title">
          <h2 id="people-title" className="border-b border-line-soft px-5 py-4 text-[1.05rem] font-bold">
            People
          </h2>
          <DonationFeed items={people} onVerify={verifyReceipt} />
        </section>
      ) : null}
    </div>
  );
}

function DonateForm() {
  const [amount, setAmount] = useState<number | ''>(10);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amountId = useId();
  const nameId = useId();
  const messageId = useId();

  const donate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const d = await call<{ approvalUrl: string }>('/api/donations', {
        body: { amount_usd: amount === '' ? 0 : amount, donor_ref: name.trim() || 'Anonymous', ...(message.trim() ? { message: message.trim() } : {}) },
      });
      window.location.assign(d.approvalUrl);
    } catch (err) {
      setError((err as ApiError).message);
      setBusy(false);
    }
  };

  return (
    <form className="panel space-y-4 p-5 lg:col-span-7" onSubmit={donate} aria-labelledby="donate-title">
      <h2 id="donate-title" className="text-[1.05rem] font-bold">
        Donate
      </h2>
      <fieldset>
        <legend className="mb-2 text-[0.875rem] text-ink-muted">Amount (USD)</legend>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              type="button"
              key={p}
              aria-pressed={amount === p}
              onClick={() => setAmount(p)}
              className={`btn num ${amount === p ? 'border-black bg-black text-white hover:border-black' : ''}`}
            >
              ${p}
            </button>
          ))}
          <label htmlFor={amountId} className="sr-only">
            Other amount
          </label>
          <input
            id={amountId}
            className="field num w-28"
            type="number"
            min={1}
            max={100}
            step="0.01"
            inputMode="decimal"
            placeholder="Other"
            value={amount === '' || PRESETS.includes(amount) ? '' : amount}
            onChange={(e) => setAmount(e.target.value === '' ? '' : Number(e.target.value))}
          />
        </div>
        <p className="mt-1.5 text-[0.85rem] text-ink-dim">$1 to $100 per donation.</p>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1">
          <label htmlFor={nameId} className="text-[0.875rem] text-ink-muted">
            Name shown with your donation (optional)
          </label>
          <input id={nameId} className="field" maxLength={64} value={name} onChange={(e) => setName(e.target.value)} placeholder="Anonymous" />
        </div>
        <div className="grid gap-1">
          <label htmlFor={messageId} className="text-[0.875rem] text-ink-muted">
            Message (optional)
          </label>
          <input id={messageId} className="field" maxLength={280} value={message} onChange={(e) => setMessage(e.target.value)} />
        </div>
      </div>
      <button className="btn btn-go h-10 px-5" disabled={busy || amount === ''}>
        {busy ? 'Opening PayPal…' : `Donate ${amount === '' ? '' : usd(Math.round(Number(amount) * 100))} with PayPal`}
      </button>
      <p className="text-[0.85rem] text-ink-dim">You approve the payment on PayPal&apos;s sandbox page, then come back here for your receipt.</p>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </form>
  );
}

const STATUS_TEXT: Record<string, string> = {
  AWAITING_APPROVAL: 'is waiting for approval on PayPal. Nothing has been charged yet.',
  CREATING: 'is being set up with PayPal.',
  CANCELED: 'was cancelled. Nothing was charged.',
  FAILED: "didn't go through. Nothing was charged.",
  PENDING: 'was approved and PayPal is still processing it. It reaches the pool when PayPal completes it.',
  DENIED: 'was declined by PayPal. Nothing reached the pool.',
  REFUNDED: 'was refunded to you, so it is no longer in the pool.',
  PARTIALLY_REFUNDED: 'was partly refunded to you; the rest is in the pool.',
  REVERSED: 'was reversed by PayPal, so it is no longer in the pool.',
};

function ReceiptPanel({ receiptId, canceled, error }: { receiptId: string; canceled: boolean; error: string | null }) {
  const [r, setR] = useState<Receipt | null>(null);
  const [missing, setMissing] = useState(false);
  const [check, setCheck] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const { version } = useLive();
  useEffect(() => {
    // Refetch on live updates too, so a pending receipt turns into a thank-you when the capture lands.
    call<Receipt>(`/api/receipts/${encodeURIComponent(receiptId)}`).then(
      (x) => {
        setR(typeof x?.status === 'string' ? x : null);
        setMissing(false);
      },
      (e: ApiError) => setMissing(e.status === 404),
    );
  }, [receiptId, version]);

  const verify = async () => {
    setChecking(true);
    try {
      setCheck(await verifyReceipt(receiptId));
    } catch (e) {
      setCheck((e as ApiError).message);
    } finally {
      setChecking(false);
    }
  };

  if (error) return <Notice tone="error">{RETURN_ERRORS[error] ?? RETURN_ERRORS.CAPTURE_FAILED}</Notice>;
  if (missing) return <Notice tone="error">{RETURN_ERRORS.UNKNOWN_RECEIPT}</Notice>;
  if (canceled) return <Notice>You cancelled on PayPal. Nothing was charged.</Notice>;
  if (!r) return null;
  if (r.status !== 'CAPTURED') return <Notice>Your donation of ${r.amountUsd} {STATUS_TEXT[r.status] ?? 'is being processed.'}</Notice>;
  return (
    <section className="rounded-[var(--radius-panel)] border-2 border-allow bg-allow-wash p-5" aria-live="polite">
      <h2 className="text-[1.15rem] font-[800] text-allow-dark">Thank you. ${r.amountUsd} reached the relief pool.</h2>
      <dl className="num mt-2 grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[0.92rem] [&_dd]:break-all">
        <dt className="text-ink-muted">Receipt</dt>
        <dd>{r.receiptId}</dd>
        <dt className="text-ink-muted">PayPal capture</dt>
        <dd>{r.paypal.captureId}</dd>
        <dt className="text-ink-muted">Audit entry</dt>
        <dd>{r.audit.captured ? `#${r.audit.captured.seq} ${r.audit.captured.hash.slice(0, 16)}…` : 'pending'}</dd>
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button className="btn" onClick={verify} disabled={checking}>
          {checking ? 'Checking…' : 'Verify my donation'}
        </button>
        {check ? <span className="text-[0.9rem]">{check}</span> : null}
      </div>
    </section>
  );
}
