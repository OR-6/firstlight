'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useId, useState } from 'react';
import type { AuditView } from '@/server/views';
import { AUDIT_LABEL, auditHref } from '@/ui/audit-links';
import { defaultTamperSeq, tamperWithCopy, type ChainEntry, type TamperResult } from '@/ui/chain';
import { LoadError, Loading, Notice, shortHash, when } from '@/ui/format';
import { call, useApi } from '@/ui/live';

type Check = { ok: true; count: number; headHash: string } | { ok: false; count: number; brokenAtSeq: number; reason: string };

/** Type filter choices: every known type, plus whole families. */
const TYPE_CHOICES: { value: string; label: string }[] = [
  { value: 'paypal.*', label: 'Everything from or to PayPal' },
  { value: 'donation.*', label: 'Every donation step' },
  { value: 'allowance.*', label: 'Every allowance step' },
  ...Object.entries(AUDIT_LABEL).map(([value, label]) => ({ value, label })),
];

export default function AuditPage() {
  return (
    <Suspense>
      <Audit />
    </Suspense>
  );
}

function Audit() {
  const params = useSearchParams();
  const plan = params.get('plan');
  const batch = params.get('batch');
  const type = params.get('type');
  const filtered = Boolean(plan || batch || type);
  const query = new URLSearchParams({ limit: '500' });
  if (plan) query.set('plan', plan);
  if (batch) query.set('batch', batch);
  if (type) query.set('type', type);
  const { data, error, reload } = useApi<AuditView>(`/api/audit?${query}`);
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const id = window.location.hash.slice(1);
    const el = id && data ? document.getElementById(id) : null;
    if (!el) return;
    el.querySelector('details')?.setAttribute('open', '');
    el.scrollIntoView({ block: 'center' });
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

  const filterWords = [plan ? `plan ${plan}` : null, batch ? `batch ${batch}` : null, type ? (TYPE_CHOICES.find((t) => t.value === type)?.label.toLowerCase() ?? type) : null].filter(Boolean).join(', ');

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

      <TamperDemo />

      <FilterForm key={`${plan}|${batch}|${type}`} plan={plan} batch={batch} type={type} />
      {filtered && data ? (
        <p className="text-[0.92rem] text-ink-muted" role="status">
          Showing {data.matched} of {data.count} entries for {filterWords}.{' '}
          <Link href="/audit" className="text-allow underline-offset-2 hover:underline">
            Show all entries
          </Link>
        </p>
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
                  {AUDIT_LABEL[e.type] ?? e.type}
                </span>
                <span className="hash text-[0.82rem] max-sm:col-start-2">#{shortHash(e.hash, 12)}</span>
              </summary>
              <div className="space-y-2 px-4 pb-4 sm:pl-[4.5rem]">
                <p className="hash break-all text-[0.8rem]">
                  type {e.type}
                  <br />
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
      {data && data.entries.length === 0 ? (
        <p className="text-ink-muted">{filtered ? 'No entries match this filter.' : 'The log is empty. Run an assessment to start it.'}</p>
      ) : null}
    </div>
  );
}

/** Narrow the log by plan, batch or event type. The filter lives in the query string, so links from /payouts land here filtered. */
function FilterForm({ plan, batch, type }: { plan: string | null; batch: string | null; type: string | null }) {
  const router = useRouter();
  const [p, setP] = useState(plan ?? '');
  const [b, setB] = useState(batch ?? '');
  const [t, setT] = useState(type ?? '');
  const planId = useId();
  const batchId = useId();
  const typeId = useId();
  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    router.push(auditHref({ plan: /^[1-9][0-9]*$/.test(p.trim()) ? Number(p.trim()) : null, batch: b.trim() || null, type: t || null }));
  };
  const known = TYPE_CHOICES.some((c) => c.value === t);
  return (
    <form className="panel flex flex-wrap items-end gap-x-4 gap-y-3 p-4" onSubmit={apply} aria-label="Filter the audit log">
      <div className="grid gap-1">
        <label htmlFor={planId} className="text-[0.875rem] text-ink-muted">
          Plan id
        </label>
        <input id={planId} className="field num w-24" inputMode="numeric" pattern="[1-9][0-9]*" value={p} onChange={(e) => setP(e.target.value)} placeholder="e.g. 1" />
      </div>
      <div className="grid gap-1">
        <label htmlFor={batchId} className="text-[0.875rem] text-ink-muted">
          Batch id (ours or PayPal&apos;s)
        </label>
        <input id={batchId} className="field num w-52" pattern="[A-Za-z0-9_\-]{1,64}" value={b} onChange={(e) => setB(e.target.value)} placeholder="e.g. 9GE626X9SA3NE" />
      </div>
      <div className="grid gap-1">
        <label htmlFor={typeId} className="text-[0.875rem] text-ink-muted">
          Event type
        </label>
        <select id={typeId} className="field max-w-[20rem]" value={t} onChange={(e) => setT(e.target.value)}>
          <option value="">Any</option>
          {!known && t ? <option value={t}>{t}</option> : null}
          {TYPE_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <button className="btn h-10">Filter</button>
      {plan || batch || type ? (
        <Link href="/audit" className="self-center text-[0.92rem] text-allow underline-offset-2 hover:underline">
          Clear filter
        </Link>
      ) : null}
    </form>
  );
}

/**
 * Edit one entry in a copy of the log held in this browser and recompute the
 * chain, so you can watch the check catch it. Reads GET /api/audit only; the
 * real log is never written.
 */
function TamperDemo() {
  const [seq, setSeq] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ r: TamperResult; total: number; newestSeq: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const seqId = useId();

  const run = async () => {
    setBusy(true);
    setProblem(null);
    setResult(null);
    try {
      if (!globalThis.crypto?.subtle) throw new Error('This browser cannot compute SHA-256 here (WebCrypto needs https or localhost).');
      const { entries } = await call<{ entries: ChainEntry[] }>('/api/audit?limit=1000');
      if (entries.length < 2) throw new Error('The log needs at least two entries. Run an assessment first.');
      const wanted = /^[1-9][0-9]*$/.test(seq.trim()) ? Number(seq.trim()) : defaultTamperSeq(entries);
      const r = wanted === null ? null : await tamperWithCopy(entries, wanted);
      if (!r) throw new Error(`Entry ${seq} is not in the ${entries.length} newest entries.`);
      setResult({ r, total: entries.length, newestSeq: Math.max(...entries.map((e) => e.seq)) });
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel space-y-3 p-4" aria-labelledby="tamper-title">
      <div className="max-w-[72ch]">
        <h2 id="tamper-title" className="text-[1.05rem] font-bold">
          Tamper with a copy
        </h2>
        <p className="mt-1 text-[0.92rem] text-ink-muted">
          See the check catch an edit. This copies the log into your browser, changes one entry&apos;s payload the way an insider might (more money, a friendlier verdict), and recomputes every hash with the
          same formula the server and <span className="num">scripts/verify-chain.ts</span> use. Only the copy in this page changes; the real log is never written.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1">
          <label htmlFor={seqId} className="text-[0.875rem] text-ink-muted">
            Entry to edit (blank picks one)
          </label>
          <input id={seqId} className="field num w-28" inputMode="numeric" value={seq} onChange={(e) => setSeq(e.target.value)} placeholder="e.g. 7" />
        </div>
        <button className="btn btn-stop h-10" onClick={run} disabled={busy}>
          {busy ? 'Recomputing…' : 'Tamper with a copy'}
        </button>
      </div>
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      {result ? <TamperOutcome {...result} /> : null}
    </section>
  );
}

function TamperOutcome({ r, total, newestSeq }: { r: TamperResult; total: number; newestSeq: number }) {
  const first = r.payloadOnly;
  const second = r.rehashed;
  return (
    <div className="space-y-2" aria-live="polite">
      <p className="text-[0.92rem]">
        In the copy, entry <span className="num font-semibold">{r.editedSeq}</span>: <span className="num">{r.what}</span>.
      </p>
      {first.ok ? (
        <Notice tone="ok">The edited copy still verifies. That should never happen; please report it.</Notice>
      ) : (
        <Notice tone="error">
          Chain broken at entry {first.brokenAtSeq}: its hash no longer matches its contents. Recomputed {first.checked} {first.checked === 1 ? 'entry' : 'entries'} before it, all intact.
        </Notice>
      )}
      <p className="max-w-[72ch] text-[0.92rem] text-ink-muted">
        {second.ok
          ? `Re-hashing entry ${r.editedSeq} to cover the edit passes the recompute only because it is the newest entry. Its hash then differs from the head hash already handed out on donor receipts (poolSummary.auditHeadHash), so the edit still shows.`
          : `Re-hashing entry ${r.editedSeq} to cover the edit doesn't help: the chain then breaks at entry ${second.brokenAtSeq}, whose previous hash still points at the original. Hiding the edit means rewriting every entry after it${
              newestSeq > r.editedSeq ? `, up to entry ${newestSeq}` : ''
            }, and the head hash on every receipt already issued would stop matching.`}
      </p>
      <p className="text-[0.85rem] text-ink-dim">
        Checked {total} entries in this browser{r.fromGenesis ? ' from the first entry' : ', starting from the oldest one fetched'}. Nothing was sent back: press Verify chain to have the server check the real log.
      </p>
    </div>
  );
}
