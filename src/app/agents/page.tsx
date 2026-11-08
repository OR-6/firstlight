'use client';

import { useEffect, useId, useState } from 'react';
import { DonationFeed, refundFromConsole, type FeedItem } from '@/ui/DonationFeed';
import { Notice } from '@/ui/format';
import { ApiError, call, useApi } from '@/ui/live';

const LIVE_ORIGIN = 'https://firstlight.onrender.com';

type Allowance = {
  allowanceId: string;
  allowanceToken: string;
  label: string;
  status: string;
  capUsd: string;
  remainingUsd: string;
  expiresAt: string;
};

type AuditEntry = { seq: number; tsMs: number; type: string; payload: unknown; prevHash: string; hash: string };

/** The site's own origin once in the browser, so snippets work on a local copy too. */
function useOrigin(): string {
  const [origin, setOrigin] = useState(LIVE_ORIGIN);
  useEffect(() => setOrigin(window.location.origin), []);
  return origin;
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 2000);
  };
  return (
    <button type="button" className="btn h-8 shrink-0" onClick={copy} aria-live="polite">
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select and copy' : label}
    </button>
  );
}

function Snippet({ code, caption }: { code: string; caption?: string }) {
  return (
    <figure className="space-y-1.5">
      {caption ? <figcaption className="text-[0.875rem] text-ink-muted">{caption}</figcaption> : null}
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-[var(--radius-control)] border border-line-soft bg-raised p-3 text-[0.82rem] leading-relaxed">
          <code>{code}</code>
        </pre>
        <CopyButton text={code} />
      </div>
    </figure>
  );
}

// ── Audit chain check in the browser (same algorithm as the manifest's receiptFormat.auditChain) ──

function canonical(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Recompute the chain in this browser up to the donation's audit entry; fall back to the server's check if WebCrypto is missing. */
async function verifyInBrowser(receiptId: string): Promise<string> {
  const r = await call<{ audit: { created: { seq: number; hash: string } | null; captured: { seq: number; hash: string } | null } }>(`/api/receipts/${receiptId}`);
  const target = r.audit.captured ?? r.audit.created;
  if (!target) return 'No audit entry yet.';
  if (!globalThis.crypto?.subtle) {
    const check = await call<{ ok: boolean; count: number }>(`/api/audit/verify?upTo=${target.hash}`);
    return check.ok ? `The server says entry ${target.seq} is in an intact chain of ${check.count}.` : 'The audit chain does not verify.';
  }
  const { entries } = await call<{ entries: AuditEntry[] }>('/api/audit?limit=1000');
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  const fromStart = sorted[0]?.seq === 1;
  let prev = fromStart ? '0'.repeat(64) : (sorted[0]?.prevHash ?? '');
  let checked = 0;
  for (const e of sorted) {
    if (e.prevHash !== prev) return `Entry ${e.seq} does not link to the one before it.`;
    const h = await sha256Hex(prev + canonical({ seq: e.seq, ts: e.tsMs, type: e.type, payload: e.payload }));
    if (h !== e.hash) return `Entry ${e.seq} does not match its hash.`;
    checked++;
    if (e.hash === target.hash) return `Recomputed ${checked} hashes in your browser: entry ${target.seq} is intact${fromStart ? ' back to the first entry' : ''}.`;
    prev = e.hash;
  }
  return 'This donation’s entry was not in the audit page fetched.';
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function AgentsPage() {
  const origin = useOrigin();
  const { data: feed, error: feedError } = useApi<{ donations: FeedItem[] }>('/api/donations');
  const agentDonations = (feed?.donations ?? []).filter((d) => d.source === 'agent');

  const initialize = `curl -s ${origin}/mcp \\
  -H 'Content-Type: application/json' \\
  -H 'Accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'`;
  const toolsList = `curl -s ${origin}/mcp \\
  -H 'Content-Type: application/json' \\
  -H 'Accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'`;
  const claudeAdd = `claude mcp add --transport http firstlight ${origin}/mcp`;

  return (
    <div className="space-y-8">
      <header className="max-w-[78ch]">
        <h1 className="text-[1.5rem] font-[800]">Agents</h1>
        <p className="mt-2 text-[1.05rem] text-ink-muted">
          AI agents can fund the relief pool for the people they work for. An agent can only donate under an allowance a person sets here: who the agent is, how much it may give and until when. Firstlight enforces that allowance on the server, and a
          person still approves every payment on PayPal. This runs in the PayPal sandbox, so no real money moves.
        </p>
      </header>

      <section aria-labelledby="discover" className="max-w-[78ch] space-y-3">
        <h2 id="discover" className="text-[1.15rem] font-bold">
          How an agent finds Firstlight
        </h2>
        <dl className="panel divide-y divide-line-soft">
          {[
            ['Manifest', '/.well-known/firstlight.json', 'Limits, endpoints, the allowance rules, and the exact formula for checking the audit hash chain yourself.'],
            ['llms.txt', '/llms.txt', 'The same in plain text, for language models reading the site.'],
            ['MCP server', '/mcp', 'Streamable HTTP, stateless. Five tools: get_pool_status, list_active_events, get_allowance, create_donation, get_receipt. Only create_donation changes anything, and it only creates a PayPal order.'],
          ].map(([name, path, what]) => (
            <div key={path} className="grid gap-1 px-4 py-3 sm:grid-cols-[9rem_1fr] sm:gap-4">
              <dt className="font-semibold">{name}</dt>
              <dd>
                <a className="num break-all text-allow underline-offset-2 hover:underline" href={path}>
                  {origin}
                  {path}
                </a>
                <p className="text-[0.92rem] text-ink-muted">{what}</p>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="terminal" className="max-w-[78ch] space-y-4">
        <h2 id="terminal" className="text-[1.15rem] font-bold">
          Try it from a terminal
        </h2>
        <p className="text-ink-muted">No clone needed. These talk to this site&apos;s MCP endpoint and change nothing.</p>
        <Snippet caption="Start an MCP session" code={initialize} />
        <Snippet caption="List the tools with their input and output schemas" code={toolsList} />
        <Snippet caption="Add Firstlight to Claude Code" code={claudeAdd} />
      </section>

      <AllowanceSection origin={origin} />

      <section aria-labelledby="samaritan" className="max-w-[78ch] space-y-3">
        <h2 id="samaritan" className="text-[1.15rem] font-bold">
          Samaritan, a scripted example agent
        </h2>
        <p>
          Samaritan is a short script in the repository (<code className="num">scripts/samaritan.ts</code>), not a language model. It reads the manifest, uses only MCP, checks its allowance, gives $5 or whatever is left, prints the PayPal link
          for its person, and once the payment is approved checks its receipt by recomputing the audit hash chain itself before asking the server&apos;s own check.
        </p>
        <Snippet
          caption="What a run prints (values illustrative)"
          code={`$ FIRSTLIGHT_URL=${LIVE_ORIGIN} FIRSTLIGHT_ALLOWANCE_TOKEN=alw_… npm run samaritan
samaritan: reading ${LIVE_ORIGIN}/.well-known/firstlight.json
samaritan: found Firstlight (sandbox). MCP at ${LIVE_ORIGIN}/mcp
samaritan: tools: get_pool_status, list_active_events, get_allowance, create_donation, get_receipt
samaritan: allowance "samaritan-agent": $20.00 left of $20.00, active, expires 2026-11-09T14:00:00.000Z
samaritan: pool holds $4320.00; 7 people paid so far
samaritan: active: M 7.7 - 10 km WSW of Pitaloza Arriba, Panama (2026-10-09) (paid)
samaritan: donating $5.00 under allowance "samaritan-agent"
samaritan: allowance left after this: $15.00

  A person must approve this payment on PayPal (sandbox):
  https://www.sandbox.paypal.com/checkoutnow?token=…

samaritan: waiting for approval of rcpt_…
samaritan: received: $5.00 is in the pool (audit entry #24)
samaritan: recomputed 24 audit hashes myself: entry #24 is intact back to the first entry
samaritan: the server's /api/audit/verify agrees: intact chain of 24 entries
samaritan: this shows my donation is recorded in the audit log; it does not show where each dollar goes, because the pool is shared
samaritan: so far Firstlight has paid $680.00 to 7 people from the pool`}
        />
        <p className="text-[0.92rem] text-ink-muted">
          A receipt proves the donation is in Firstlight&apos;s audit log and shows the pool&apos;s totals. It does not prove where each dollar went: the pool is shared, so no donation is earmarked to a recipient.
        </p>
      </section>

      <section className="panel overflow-hidden" aria-labelledby="agent-feed">
        <div className="border-b border-line-soft px-5 py-4">
          <h2 id="agent-feed" className="text-[1.05rem] font-bold">
            Recent agent donations
          </h2>
          <p className="max-w-[72ch] text-[0.92rem] text-ink-muted">
            Shown under each allowance&apos;s label. Messages are shown as plain text and never reach the payout agent. Verifying recomputes the audit hash chain in your browser.
          </p>
        </div>
        {feedError ? <p className="p-5 text-block-ink">{feedError.message}</p> : <DonationFeed items={agentDonations} onVerify={verifyInBrowser} onRefund={refundFromConsole} />}
      </section>
    </div>
  );
}

const CAPS = [5, 20, 50, 100];
const EXPIRY: { hours: number; label: string }[] = [
  { hours: 1, label: '1 hour' },
  { hours: 24, label: '24 hours' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
];

function AllowanceSection({ origin }: { origin: string }) {
  const [label, setLabel] = useState('');
  const [cap, setCap] = useState<number | ''>(20);
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Allowance | null>(null);
  const [revoked, setRevoked] = useState<string | null>(null);
  const labelId = useId();
  const capId = useId();
  const expiryId = useId();

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setRevoked(null);
    try {
      setCreated(await call<Allowance>('/api/allowances', { body: { label: label.trim(), cap_usd: cap === '' ? 0 : cap, expires_in_hours: hours } }));
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!created) return;
    setBusy(true);
    setError(null);
    try {
      await call(`/api/allowances/${created.allowanceId}/revoke`, { body: { allowance_token: created.allowanceToken } });
      setRevoked(created.allowanceId);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="allowance" className="space-y-4">
      <div className="max-w-[78ch]">
        <h2 id="allowance" className="text-[1.15rem] font-bold">
          Give an agent an allowance
        </h2>
        <p className="mt-1 text-ink-muted">
          The label is the name the agent&apos;s donations appear under; the agent can&apos;t choose another. The server refuses anything over what is left, after the expiry, or after you revoke it. In this demo anyone can create one; a real
          deployment would have the person sign in first so the allowance belongs to a verified account.
        </p>
      </div>

      <form className="panel max-w-[78ch] space-y-4 p-5" onSubmit={create} aria-labelledby="allowance">
        <div className="grid gap-1">
          <label htmlFor={labelId} className="text-[0.875rem] text-ink-muted">
            Who is the agent? (shown publicly with its donations)
          </label>
          <input id={labelId} className="field" required maxLength={64} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Ana's assistant" />
          <p className="text-[0.85rem] text-ink-dim">Up to 64 letters, digits, spaces and . _ : @ + -</p>
        </div>
        <fieldset>
          <legend className="mb-2 text-[0.875rem] text-ink-muted">Cap (USD)</legend>
          <div className="flex flex-wrap gap-2">
            {CAPS.map((c) => (
              <button type="button" key={c} aria-pressed={cap === c} onClick={() => setCap(c)} className={`btn num ${cap === c ? 'border-black bg-black text-white hover:border-black' : ''}`}>
                ${c}
              </button>
            ))}
            <label htmlFor={capId} className="sr-only">
              Other cap
            </label>
            <input
              id={capId}
              className="field num w-28"
              type="number"
              min={1}
              max={100}
              step="0.01"
              inputMode="decimal"
              placeholder="Other"
              value={cap === '' || CAPS.includes(cap) ? '' : cap}
              onChange={(e) => setCap(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </div>
          <p className="mt-1.5 text-[0.85rem] text-ink-dim">$1 to $100 in total, across all of the agent&apos;s donations.</p>
        </fieldset>
        <div className="grid gap-1 sm:max-w-xs">
          <label htmlFor={expiryId} className="text-[0.875rem] text-ink-muted">
            Expires after
          </label>
          <select id={expiryId} className="field" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {EXPIRY.map((x) => (
              <option key={x.hours} value={x.hours}>
                {x.label}
              </option>
            ))}
          </select>
        </div>
        <button className="btn btn-go h-10 px-5" disabled={busy || cap === '' || !label.trim()}>
          {busy && !created ? 'Creating…' : 'Create allowance'}
        </button>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </form>

      {created ? <CreatedAllowance a={created} origin={origin} revoked={revoked === created.allowanceId} onRevoke={revoke} busy={busy} /> : null}
    </section>
  );
}

function CreatedAllowance({ a, origin, revoked, onRevoke, busy }: { a: Allowance; origin: string; revoked: boolean; onRevoke: () => void; busy: boolean }) {
  const expires = new Date(a.expiresAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const mcpArgs = JSON.stringify({ amount_usd: 5, allowance_token: a.allowanceToken, message: 'For the Panama earthquake' }, null, 2);
  const httpDonate = `curl -s ${origin}/api/agent/donations \\
  -H 'Content-Type: application/json' \\
  -d '{"amount_usd": 5, "allowance_token": "${a.allowanceToken}"}'`;
  const revokeCurl = `curl -s -X POST ${origin}/api/allowances/${a.allowanceId}/revoke \\
  -H 'Content-Type: application/json' \\
  -d '{"allowance_token": "${a.allowanceToken}"}'`;

  return (
    <div className="panel max-w-[78ch] space-y-4 p-5" aria-live="polite">
      {revoked ? (
        <Notice>This allowance is revoked. The agent can&apos;t donate with it any more, and donations still waiting for approval under it were cancelled.</Notice>
      ) : (
        <Notice tone="ok">Allowance created. Copy the token now: it is shown once, and Firstlight keeps only a hash of it.</Notice>
      )}
      <dl className="num grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[0.92rem] [&_dd]:break-all">
        <dt className="text-ink-muted">Label</dt>
        <dd>{a.label}</dd>
        <dt className="text-ink-muted">Cap</dt>
        <dd>${a.capUsd}</dd>
        <dt className="text-ink-muted">Expires</dt>
        <dd>{expires}</dd>
        <dt className="text-ink-muted">Allowance id</dt>
        <dd>{a.allowanceId}</dd>
      </dl>
      <Snippet caption="Token for your agent. Treat it like a password and never put it in a URL." code={a.allowanceToken} />
      <Snippet caption="Tell an MCP agent to call create_donation with" code={mcpArgs} />
      <Snippet caption="Or run Samaritan from a clone of the repository" code={`FIRSTLIGHT_URL=${origin} FIRSTLIGHT_ALLOWANCE_TOKEN=${a.allowanceToken} npm run samaritan`} />
      <Snippet caption="Or over plain HTTP" code={httpDonate} />
      <div className="flex flex-wrap items-center gap-3 border-t border-line-soft pt-4">
        <button type="button" className="btn btn-stop" onClick={onRevoke} disabled={busy || revoked}>
          {revoked ? 'Revoked' : 'Revoke this allowance'}
        </button>
        <p className="text-[0.85rem] text-ink-dim">Revoking needs both the id and the token, so nobody who only sees the public audit log can revoke it.</p>
      </div>
      <Snippet caption="Revoke later from a terminal" code={revokeCurl} />
    </div>
  );
}
