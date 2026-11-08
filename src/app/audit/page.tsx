'use client';

import { useEffect, useState } from 'react';
import type { AuditView } from '@/server/views';
import { LoadError, Loading, Notice, shortHash, when } from '@/ui/format';
import { call, useApi } from '@/ui/live';

const LABEL: Record<string, string> = {
  'signal.received': 'Earthquake signal received',
  'sentinel.pre': 'Sentinel scanned untrusted text',
  'agent.result': 'Agent submitted a plan',
  'sentinel.post': "Sentinel scanned the agent's output",
  'firewall.verdict': 'Firewall verdict recorded',
  'approval.decided': 'Human decision',
  'payout.reserved': 'Pool money reserved',
  'paypal.payout.created': 'PayPal accepted the batch',
  'paypal.payout.error': 'PayPal request failed',
  'paypal.payout.status': 'PayPal status update',
  'paypal.webhook': 'PayPal webhook (verified)',
  'paypal.webhook.rejected': 'PayPal webhook rejected',
  'execute.refused': 'Payout refused at execution',
  'donation.created': 'Donation started (waiting for PayPal approval)',
  'donation.captured': 'Donation received into the pool',
  'donation.rejected': 'Donation refused by the donation rules',
  'donation.failed': 'Donation failed at PayPal',
  'donation.canceled': 'Donation cancelled by the donor',
  'donation.capture_pending': 'Donation approved, capture pending',
  'donation.refunded': 'Donation refunded to the donor (taken out of the pool)',
  'donation.reversed': 'Donation reversed by PayPal (taken out of the pool)',
  'donation.denied': 'Donation capture denied by PayPal',
  'allowance.created': 'Agent allowance created by a person',
  'allowance.revoked': 'Agent allowance revoked',
};

type Check = { ok: true; count: number; headHash: string } | { ok: false; count: number; brokenAtSeq: number; reason: string };

export default function AuditPage() {
  const { data, error, reload } = useApi<AuditView>('/api/audit?limit=500');
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id && data) document.getElementById(id)?.scrollIntoView({ block: 'center' });
  }, [data]);

  const verify = async () => {
    setBusy(true);
    try {
      setCheck(await call<Check>('/api/audit/verify', { body: {} }));
    } catch (e) {
      setCheck({ ok: false, count: 0, brokenAtSeq: 0, reason: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[1.4rem] font-[800]">Audit log</h1>
          <p className="mt-1 max-w-[72ch] text-ink-muted">
            Every step is appended here and chained: each entry&apos;s hash covers its contents and the previous hash, so editing or deleting any entry breaks every hash after it.
          </p>
        </div>
        <button className="btn btn-go" onClick={verify} disabled={busy}>
          {busy ? 'Checking…' : 'Verify chain'}
        </button>
      </div>
      {check ? (
        check.ok ? (
          <Notice tone="ok">
            Chain intact: all {check.count} entries recomputed and match. Head <span className="num">{shortHash(check.headHash, 16)}</span>.
          </Notice>
        ) : (
          <Notice tone="error">
            {check.brokenAtSeq ? `Chain broken at entry ${check.brokenAtSeq}: ${check.reason}.` : `Couldn't check the chain: ${check.reason}`}
          </Notice>
        )
      ) : null}
      <LoadError error={error} onRetry={reload} />
      {!data && !error ? <Loading what="the audit log" /> : null}
      <ol className={`panel divide-y divide-line-soft ${data?.entries.length ? '' : 'hidden'}`}>
        {(data?.entries ?? []).map((e) => (
          <li key={e.seq} id={`seq-${e.seq}`} className="target:bg-hold-wash">
            <details>
              <summary className="grid cursor-pointer grid-cols-[3.5rem_1fr] gap-x-3 px-4 py-2.5 sm:grid-cols-[3.5rem_11rem_1fr_auto]">
                <span className="num text-ink-dim">{e.seq}</span>
                <span className="num text-[0.88rem] text-ink-muted max-sm:hidden">{when(e.tsMs)}</span>
                <span className={`font-semibold ${e.type.endsWith('rejected') || e.type.endsWith('error') || e.type.endsWith('failed') || e.type === 'execute.refused' ? 'text-block' : ''}`}>
                  {LABEL[e.type] ?? e.type}
                </span>
                <span className="hash text-[0.82rem] max-sm:col-start-2">#{shortHash(e.hash, 12)}</span>
              </summary>
              <div className="space-y-2 px-4 pb-4 sm:pl-[4.5rem]">
                <p className="hash break-all text-[0.8rem]">
                  hash {e.hash}
                  <br />
                  previous {e.prevHash}
                </p>
                <pre className="max-h-80 overflow-auto rounded-[var(--radius-control)] bg-ground p-3 text-[0.8rem] leading-relaxed text-ink-muted">
                  {JSON.stringify(e.payload, null, 2)}
                </pre>
              </div>
            </details>
          </li>
        ))}
      </ol>
      {data && data.entries.length === 0 ? <p className="text-ink-muted">The log is empty. Run an assessment to start it.</p> : null}
    </div>
  );
}
