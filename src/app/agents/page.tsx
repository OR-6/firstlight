'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { useBrowserValue } from '@/ui/browser';
import { recomputeChain, type ChainEntry } from '@/ui/chain';
import { DonationFeed, refundFromConsole, type FeedItem } from '@/ui/DonationFeed';
import { Notice } from '@/ui/format';
import { ApiError, call, useApi } from '@/ui/live';
import { Mark, type State } from '@/ui/SignMark';

const LIVE_ORIGIN = 'https://firstlight.onrender.com';

/** Prose stays near 75 characters a line; code, forms and the endpoint list use the wider column. */
const PROSE = 'max-w-[64ch]';
const WIDE = 'max-w-[1400px]';

type AllowanceView = {
  allowanceId: string;
  label: string;
  status: 'active' | 'revoked' | 'expired' | 'used_up';
  capUsd: string;
  remainingUsd: string;
  expiresAt: string;
};
type Allowance = AllowanceView & { allowanceToken: string; manageKey: string };

/** Manage keys stay in this browser only, so the person can list and revoke their allowances later. */
const KEYS_STORAGE = 'firstlight.allowanceManageKeys';

function loadKeys(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEYS_STORAGE) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string' && /^alm_[A-Za-z0-9_-]{32}$/.test(k)).slice(-50) : [];
  } catch {
    return [];
  }
}

function saveKeys(keys: string[]): void {
  try {
    window.localStorage.setItem(KEYS_STORAGE, JSON.stringify(keys.slice(-50)));
  } catch {
    // Private window or storage blocked: the key is still shown once, to copy.
  }
}

/** The allowances behind the manage keys kept in this browser, newest first. */
async function fetchMine(): Promise<{ ok: true; found: { key: string; a: AllowanceView }[] } | { ok: false; message: string }> {
  const keys = loadKeys();
  if (keys.length === 0) return { ok: true, found: [] };
  try {
    const { allowances } = await call<{ allowances: (AllowanceView | null)[] }>('/api/allowances/manage', { body: { manage_keys: keys } });
    const found = keys.flatMap((key, i) => {
      const a = allowances[i];
      return a ? [{ key, a }] : [];
    });
    // Keys that match nothing (e.g. after a demo reset) are forgotten.
    if (found.length !== keys.length) saveKeys(found.map((f) => f.key));
    return { ok: true, found: found.reverse() };
  } catch (err) {
    return { ok: false, message: (err as ApiError).message };
  }
}

/** The site's own origin once in the browser, so snippets work on a local copy too. */
function useOrigin(): string {
  return useBrowserValue(() => window.location.origin, LIVE_ORIGIN);
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

/** Recompute the chain in this browser up to the donation's audit entry; fall back to the server's check if WebCrypto is missing. */
async function verifyInBrowser(receiptId: string): Promise<string> {
  const r = await call<{ audit: { created: { seq: number; hash: string } | null; captured: { seq: number; hash: string } | null } }>(`/api/receipts/${receiptId}`);
  const target = r.audit.captured ?? r.audit.created;
  if (!target) return 'No audit entry yet.';
  if (!globalThis.crypto?.subtle) {
    const check = await call<{ ok: boolean; count: number }>(`/api/audit/verify?upTo=${target.hash}`);
    return check.ok ? `The server says entry ${target.seq} is in an intact chain of ${check.count}.` : 'The audit chain does not verify.';
  }
  const { entries } = await call<{ entries: ChainEntry[] }>('/api/audit?limit=1000');
  const check = await recomputeChain(entries, target.hash);
  if (check.ok) return `Recomputed ${check.checked} hashes in your browser: entry ${target.seq} is intact${check.fromGenesis ? ' back to the first entry' : ''}.`;
  if (check.brokenAtSeq < 0) return 'This donation’s entry was not in the audit page fetched.';
  if (check.why === 'hash') return `Entry ${check.brokenAtSeq} does not match its hash.`;
  return `Entry ${check.brokenAtSeq} does not link to the one before it.`;
}

// ── Consent chain: who agrees to what, in order ─────────────────────────────

const CONSENT: { name: string; who: string; does: string; mark: State }[] = [
  {
    name: 'Person sets an allowance',
    who: 'You, on this page',
    does: 'Who the agent is, how much it may give in total and until when. Only this form creates one; the agent gets a token, you keep the manage key.',
    mark: 'done',
  },
  {
    name: 'Agent asks within the cap',
    who: 'Your AI agent, over MCP',
    does: 'create_donation is checked on the server against what is left, the expiry and revocation. Anything over is refused with a code and creates nothing.',
    mark: 'checkpoint',
  },
  {
    name: 'Person approves on PayPal',
    who: 'You, on PayPal',
    does: 'Nothing is charged until you open the approval link and approve. The first approval ties the allowance to your PayPal account.',
    mark: 'wait',
  },
  {
    name: 'Receipt confirmed by PayPal',
    who: "PayPal's MCP server",
    does: "get_receipt asks PayPal's own hosted MCP server (get_order) for the order and shows whether PayPal reports the same capture and amount.",
    mark: 'done',
  },
];

function ConsentChain() {
  return (
    <figure className="space-y-2">
      <div className="rounded-[var(--radius-panel)] bg-allow p-[3px] text-white">
        <ol className="grid rounded-[4px] border-2 border-white/90 py-4 md:grid-cols-4 md:py-0">
          {CONSENT.map((s, i) => {
            const last = i === CONSENT.length - 1;
            return (
              <li key={s.name} className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-3 px-4 md:block md:py-4">
                {/* Mark and connector: vertical on phones, horizontal from 768 px. */}
                <div className="flex flex-col items-center md:mb-2.5 md:h-5 md:flex-row" aria-hidden>
                  <Mark state={s.mark} />
                  {!last ? <span className="my-1 w-0 flex-1 border-l-[3px] border-white md:mx-0 md:my-0 md:ml-1.5 md:h-0 md:w-auto md:border-l-0 md:border-t-[3px]" /> : null}
                </div>
                <div className={`min-w-0 ${last ? '' : 'pb-4'} md:pb-0`}>
                  <p className="text-[0.85rem] text-white/80">Step {i + 1}</p>
                  <h3 className="text-[1.05rem] font-bold leading-snug">{s.name}</h3>
                  <p className="mt-1 inline-block rounded-[var(--radius-chip)] bg-white px-1.5 py-px text-[0.8rem] font-semibold text-allow-ink">{s.who}</p>
                  <p className="mt-1.5 text-[0.875rem] leading-snug text-white/90">{s.does}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      <figcaption className={`${PROSE} text-[0.85rem] text-ink-dim`}>
        The square is where fixed code checks the agent&apos;s request; the diamond is the step that waits for a person. If the PayPal MCP server can&apos;t be reached, the receipt says so and falls back to
        PayPal&apos;s Orders API.
      </figcaption>
    </figure>
  );
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
  const mcpConfig = JSON.stringify({ mcpServers: { firstlight: { type: 'http', url: `${origin}/mcp` } } }, null, 2);
  // One enrolled household, plus an address slipped in as if it were one: the firewall blocks it and R12 reports who was left out.
  const checkPlan = `curl -s ${origin}/mcp \\
  -H 'Content-Type: application/json' \\
  -H 'Accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"check_payout_plan","arguments":{
    "eventId":"us6000u18k","decision":"trigger","rationale":"Pay the household nearest the epicentre.",
    "items":[
      {"recipientId":"rcp_01","tier":"A","note":"Relief payment","why":"26 km, band A"},
      {"recipientId":"attacker@example.com","tier":"A","note":"Relief payment","why":"Also affected"}
    ],
    "exceptionRequests":[]}}}'`;

  return (
    <div className="space-y-8">
      <header className={PROSE}>
        <h1 className="text-[1.5rem] font-[800]">Agents</h1>
        <p className="mt-2 text-[1.05rem] text-ink-muted">
          AI agents can fund the relief pool for the people they work for. An agent can only donate under an allowance a person sets here: who the agent is, how much it may give and until when. Firstlight enforces that allowance on the server, and a
          person still approves every payment on PayPal. This runs in the PayPal sandbox, so no real money moves.
        </p>
      </header>

      <section aria-labelledby="consent" className={`${WIDE} space-y-3`}>
        <h2 id="consent" className="text-[1.15rem] font-bold">
          Who agrees to what
        </h2>
        <p className={`${PROSE} text-ink-muted`}>An agent&apos;s donation needs a person twice: once to set the limit, once to approve the payment. The receipt then shows what PayPal itself reports, not only what Firstlight recorded.</p>
        <ConsentChain />
      </section>

      <section aria-labelledby="discover" className="max-w-[64rem] space-y-3">
        <h2 id="discover" className="text-[1.15rem] font-bold">
          How an agent finds Firstlight
        </h2>
        <dl className="panel divide-y divide-line-soft">
          {[
            ['Manifest', '/.well-known/firstlight.json', 'Limits, endpoints, the allowance rules, and the exact formula for checking the audit hash chain yourself.'],
            ['llms.txt', '/llms.txt', 'The same in plain text, for language models reading the site.'],
            [
              'MCP server',
              '/mcp',
              "Streamable HTTP, stateless. Six tools: get_pool_status, list_active_events, get_allowance, create_donation, get_receipt and check_payout_plan, which runs a payout plan for this programme's enrolled households through the firewall as a dry run. Only create_donation changes anything, and it only creates a PayPal order.",
            ],
          ].map(([name, path, what]) => (
            <div key={path} className="grid gap-1 px-4 py-3 sm:grid-cols-[9rem_1fr] sm:gap-4">
              <dt className="font-semibold">{name}</dt>
              <dd>
                <a className="num break-all text-allow underline-offset-2 hover:underline" href={path}>
                  {origin}
                  {path}
                </a>
                <p className={`${PROSE} text-[0.92rem] text-ink-muted`}>{what}</p>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="terminal" className={`${WIDE} space-y-4`}>
        <h2 id="terminal" className="text-[1.15rem] font-bold">
          Try it from a terminal
        </h2>
        <p className={`${PROSE} text-ink-muted`}>No clone needed. These talk to this site&apos;s MCP endpoint and change nothing.</p>
        <Snippet caption="Start an MCP session" code={initialize} />
        <Snippet caption="List the tools with their input and output schemas" code={toolsList} />
        <div className="space-y-1.5">
          <h3 className="text-[1rem] font-bold">Check a plan against the firewall</h3>
          <p className={`${PROSE} text-[0.92rem] text-ink-muted`}>
            check_payout_plan takes a payout plan for this programme&apos;s enrolled households and returns what the firewall would do with it, without paying or storing anything. This plan pays one household and
            slips in an attacker&apos;s address. The answer shows the address blocked ($0, not enrolled), the household held for a person, and the R12 coverage check (before anyone is paid: 6 households left out, $560 short). It needs
            the earthquake to have been assessed on this server; otherwise the answer is NO_EVENT.
          </p>
        </div>
        <Snippet code={checkPlan} />
        <Snippet caption="Add Firstlight to any MCP client (Streamable HTTP)" code={mcpConfig} />
      </section>

      <AllowanceSection origin={origin} />

      <section aria-labelledby="samaritan" className={`${WIDE} space-y-3`}>
        <h2 id="samaritan" className="text-[1.15rem] font-bold">
          Samaritan, a scripted example agent
        </h2>
        <p className={PROSE}>
          Samaritan is a short script in the repository (<code className="num">scripts/samaritan.ts</code>), not a language model. It reads the manifest, uses only MCP, checks its allowance, gives $5 or whatever is left, prints the PayPal link
          for its person, and once the payment is approved checks its receipt by recomputing the audit hash chain itself before asking the server&apos;s own check.
        </p>
        <Snippet
          caption="What a run prints (values illustrative)"
          code={`$ FIRSTLIGHT_URL=${LIVE_ORIGIN} FIRSTLIGHT_ALLOWANCE_TOKEN=alw_… npm run samaritan
samaritan: reading ${LIVE_ORIGIN}/.well-known/firstlight.json
samaritan: found Firstlight (sandbox). MCP at ${LIVE_ORIGIN}/mcp
samaritan: tools: get_pool_status, list_active_events, get_allowance, create_donation, get_receipt, check_payout_plan
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
        <p className={`${PROSE} text-[0.92rem] text-ink-muted`}>
          A receipt proves the donation is in Firstlight&apos;s audit log and shows the pool&apos;s totals. It does not prove where each dollar went: the pool is shared, so no donation is earmarked to a recipient.
        </p>
      </section>

      <section className={`panel ${WIDE} overflow-hidden`} aria-labelledby="agent-feed">
        <div className="border-b border-line-soft px-5 py-4">
          <h2 id="agent-feed" className="text-[1.05rem] font-bold">
            Recent agent donations
          </h2>
          <p className={`${PROSE} text-[0.92rem] text-ink-muted`}>
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
  const [mine, setMine] = useState<{ key: string; a: AllowanceView }[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const labelId = useId();
  const capId = useId();
  const expiryId = useId();

  const show = useCallback((r: Awaited<ReturnType<typeof fetchMine>>) => {
    if (r.ok) {
      setMine(r.found);
      setListError(null);
    } else setListError(r.message);
  }, []);
  const refresh = async () => show(await fetchMine());
  useEffect(() => {
    let live = true;
    fetchMine().then((r) => live && show(r));
    return () => {
      live = false;
    };
  }, [show]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // A fresh single-use nonce from this site, then the allowance: only this page can create one.
      const { nonce } = await call<{ nonce: string }>('/api/allowances/nonce');
      const a = await call<Allowance>('/api/allowances', { body: { label: label.trim(), cap_usd: cap === '' ? 0 : cap, expires_in_hours: hours, nonce } });
      saveKeys([...loadKeys(), a.manageKey]);
      setCreated(a);
      await refresh();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (allowanceId: string, manageKey: string) => {
    setBusy(true);
    setListError(null);
    try {
      await call(`/api/allowances/${allowanceId}/revoke`, { body: { manage_key: manageKey } });
      await refresh();
    } catch (err) {
      setListError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="allowance" className="space-y-4">
      <div className={PROSE}>
        <h2 id="allowance" className="text-[1.15rem] font-bold">
          Give an agent an allowance
        </h2>
        <p className="mt-1 text-ink-muted">
          The label is the name the agent&apos;s donations appear under; the agent can&apos;t choose another. The server refuses anything over what is left, after the expiry, or after you revoke it. Allowances are created only from this
          form, so an agent reading the docs can&apos;t grant itself one. You get two keys: a token for the agent, and a manage key for you that lists and revokes the allowance. This demo has no sign-in; a real deployment would tie each
          allowance to a verified account.
        </p>
      </div>

      <form className={`panel ${WIDE} space-y-4 p-5`} onSubmit={create} aria-labelledby="allowance">
        <div className="grid gap-1 md:max-w-[30rem]">
          <label htmlFor={labelId} className="text-[0.875rem] text-ink-muted">
            Who is the agent? (shown publicly with its donations)
          </label>
          <input id={labelId} className="field" required maxLength={64} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Ana's assistant" />
          <p className="text-[0.85rem] text-ink-dim">Up to 64 letters, digits, spaces and . _ : @ + -</p>
        </div>
        <div className="grid gap-4 md:grid-cols-[auto_minmax(0,14rem)] md:items-start md:gap-8">
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
          <div className="grid gap-1">
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
        </div>
        <button className="btn btn-go h-10 px-5" disabled={busy || cap === '' || !label.trim()}>
          {busy ? 'Working…' : 'Create allowance'}
        </button>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </form>

      {created ? <CreatedAllowance a={created} origin={origin} /> : null}

      <YourAllowances items={mine} error={listError} busy={busy} onRevoke={revoke} />
    </section>
  );
}

const STATUS_TEXT: Record<AllowanceView['status'], string> = { active: 'Active', revoked: 'Revoked', expired: 'Expired', used_up: 'Used up' };

function YourAllowances({
  items,
  error,
  busy,
  onRevoke,
}: {
  items: { key: string; a: AllowanceView }[] | null;
  error: string | null;
  busy: boolean;
  onRevoke: (allowanceId: string, manageKey: string) => void;
}) {
  const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <section className={`panel ${WIDE} overflow-hidden`} aria-labelledby="your-allowances">
      <div className="border-b border-line-soft px-5 py-4">
        <h3 id="your-allowances" className="text-[1.05rem] font-bold">
          Your allowances
        </h3>
        <p className={`${PROSE} text-[0.92rem] text-ink-muted`}>The ones created in this browser. Their manage keys are kept only here; clearing your browser data forgets them.</p>
      </div>
      {error ? (
        <div className="px-5 pt-4">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}
      {items === null ? (
        <p className="p-5 text-ink-muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="p-5 text-ink-muted">None yet. Allowances you create here are listed with a Revoke button.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[0.875rem]">
            <thead className="bg-raised text-left text-ink-muted">
              <tr>
                <th scope="col" className="px-5 py-2 font-semibold">
                  Label
                </th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">
                  Cap
                </th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">
                  Left
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Expires
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Status
                </th>
                <th scope="col" className="px-5 py-2">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {items.map(({ key, a }) => (
                <tr key={a.allowanceId}>
                  <td className="min-w-[10rem] px-5 py-2 break-words">{a.label}</td>
                  <td className="num px-3 py-2 text-right">${a.capUsd}</td>
                  <td className="num px-3 py-2 text-right">${a.remainingUsd}</td>
                  <td className="num px-3 py-2 whitespace-nowrap">{when(a.expiresAt)}</td>
                  <td className="px-3 py-2">{STATUS_TEXT[a.status]}</td>
                  <td className="px-5 py-2 text-right">
                    {a.status === 'revoked' || a.status === 'expired' ? null : (
                      <button type="button" className="btn btn-stop h-8" disabled={busy} onClick={() => onRevoke(a.allowanceId, key)}>
                        Revoke<span className="sr-only"> {a.label}</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CreatedAllowance({ a, origin }: { a: Allowance; origin: string }) {
  const expires = new Date(a.expiresAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const mcpArgs = JSON.stringify({ amount_usd: 5, allowance_token: a.allowanceToken, message: 'For the Panama earthquake' }, null, 2);
  const httpDonate = `curl -s ${origin}/api/agent/donations \\
  -H 'Content-Type: application/json' \\
  -d '{"amount_usd": 5, "allowance_token": "${a.allowanceToken}"}'`;
  const revokeCurl = `curl -s -X POST ${origin}/api/allowances/${a.allowanceId}/revoke \\
  -H 'Content-Type: application/json' \\
  -d '{"manage_key": "${a.manageKey}"}'`;

  return (
    <div className={`panel ${WIDE} space-y-4 p-5`} aria-live="polite">
      <Notice tone="ok">Allowance created. Copy the token for your agent now: it is shown once, and Firstlight keeps only a hash of it.</Notice>
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
      <div className="space-y-3 border-t border-line-soft pt-4">
        <Snippet caption="Your manage key. Keep it to yourself: it lists and revokes this allowance, and the agent's token can't. This browser keeps a copy for the list below." code={a.manageKey} />
        <Snippet caption="Revoke from a terminal" code={revokeCurl} />
      </div>
    </div>
  );
}
