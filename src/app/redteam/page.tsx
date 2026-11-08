'use client';

import { useState } from 'react';
import type { ScenarioResult, SuiteReport } from '@/redteam/scenarios';
import { Notice, VerdictChip, usd } from '@/ui/format';
import { ApiError, call, useApi } from '@/ui/live';
import { RULE_NAMES } from '@/ui/RuleDrawer';
import type { RuleId } from '@/firewall/types';

type Scenario = { id: string; title: string; attempted: string };

export default function RedTeamPage() {
  const { data } = useApi<{ scenarios: Scenario[] }>('/api/redteam/run');
  const [active, setActive] = useState<string | null>(null);
  const [result, setResult] = useState<ScenarioResult | null>(null);
  const [suite, setSuite] = useState<SuiteReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (id: string) => {
    setBusy(id);
    setActive(id);
    setError(null);
    setResult(null);
    try {
      setResult(await call<ScenarioResult>('/api/redteam/run', { body: { scenario: id } }));
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(null);
    }
  };
  const runSuite = async () => {
    setBusy('suite');
    setError(null);
    try {
      setSuite(await call<SuiteReport>('/api/redteam/report', { body: {} }));
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[1.4rem] font-[800]">Red team</h1>
        <p className="mt-1 max-w-[74ch] text-ink-muted">
          Try to make Firstlight pay someone it shouldn&apos;t. Each attack runs against an isolated copy of the system with a fresh ledger and a simulated PayPal endpoint, and a careless reviewer approves whatever reaches them. Nothing is sent to PayPal.
        </p>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}

      <div className="grid gap-5 lg:grid-cols-12">
        <ul className="panel divide-y divide-line-soft self-start lg:col-span-5">
          {(data?.scenarios ?? []).map((s) => (
            <li key={s.id} className={`p-4 ${active === s.id ? 'bg-raised' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-bold">{s.title}</h2>
                  <p className="mt-0.5 text-[0.88rem] leading-relaxed text-ink-muted">{s.attempted}</p>
                </div>
                <button
                  className="btn h-8 shrink-0"
                  onClick={() => run(s.id)}
                  disabled={busy !== null}
                  aria-label={busy === s.id ? `Running attack: ${s.title}` : `Run attack: ${s.title}`}
                >
                  {busy === s.id ? 'Running…' : 'Run attack'}
                </button>
              </div>
            </li>
          ))}
        </ul>
        <div className="lg:col-span-7">{result ? <Result r={result} /> : <Placeholder busy={busy !== null && busy !== 'suite'} />}</div>
      </div>

      <section className="panel p-5" aria-labelledby="suite-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="suite-title" className="text-[1.1rem] font-bold">
              Full attack suite
            </h2>
            <p className="text-[0.9rem] text-ink-muted">
              27 prompt-injection payloads: direct, hidden in news, fake system messages, smuggled JSON, base64 and ROT13, four non-English languages, look-alike characters, and instructions split across two sources. Then six attacks that don&apos;t try to pay a stranger, including the one Firstlight doesn&apos;t stop.
            </p>
          </div>
          <button className="btn btn-go" onClick={runSuite} disabled={busy !== null}>
            {busy === 'suite' ? 'Running 27 attacks…' : 'Run all 27 attacks'}
          </button>
        </div>
        {suite ? <Suite s={suite} /> : null}
      </section>
    </div>
  );
}

function Placeholder({ busy }: { busy: boolean }) {
  return (
    <div className="panel flex min-h-[260px] items-center justify-center p-6 text-center text-ink-muted">
      {busy ? 'Running the attack against an isolated copy…' : 'Pick an attack to see what it tried, which firewall rules stopped it, and what would have reached PayPal.'}
    </div>
  );
}

function Result({ r }: { r: ScenarioResult }) {
  const fired = r.rulesFired.filter((f) => f.reasonCode !== 'OVER_APPROVAL_THRESHOLD' || r.rulesFired.length === 1);
  return (
    <section className="panel overflow-hidden" aria-live="polite">
      <div className="border-b border-line-soft p-5">
        <p className={`num text-[1.6rem] font-[800] leading-tight ${r.unauthorisedCents === 0 ? 'text-allow' : 'text-block'}`}>
          {usd(r.unauthorisedCents)} reached anyone not entitled to it
        </p>
        <p className="mt-1 text-ink-muted">
          {r.title}. Agent: {r.agent}.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[0.9rem]">
          <span className="text-ink-muted">Firewall verdict</span>
          <VerdictChip v={r.verdict} />
          <span className="text-ink-muted">
            Sentinel: {r.sentinel.findings ? `${r.sentinel.findings} findings` : 'nothing flagged'}
          </span>
          <span className="text-ink-muted">Reviewer: {r.approvedBy}</span>
        </div>
      </div>
      <div className="grid gap-0 md:grid-cols-2">
        <div className="border-line-soft p-5 md:border-r">
          <h3 className="mb-2 text-[0.95rem] font-bold">What the firewall caught</h3>
          {fired.length === 0 ? (
            <p className="text-[0.9rem] text-ink-muted">No rule fired.</p>
          ) : (
            <ul className="space-y-2 text-[0.88rem]">
              {fired.slice(0, 14).map((f, i) => (
                <li key={i}>
                  <span className="font-semibold">{f.recipientId === 'plan' ? 'Whole plan' : f.recipientId}</span>{' '}
                  <span className="text-ink-dim">
                    {f.ruleId} {RULE_NAMES[f.ruleId as RuleId]}
                  </span>
                  <p className="break-words text-ink-muted" title={f.detail}>
                    {f.detail.length > 110 ? `${f.detail.slice(0, 110)}…` : f.detail}
                  </p>
                </li>
              ))}
              {fired.length > 14 ? <li className="text-ink-dim">and {fired.length - 14} more</li> : null}
            </ul>
          )}
        </div>
        <div className="p-5">
          <h3 className="mb-2 text-[0.95rem] font-bold">What would have reached PayPal</h3>
          {r.sent.length === 0 ? (
            <p className="text-[0.9rem] text-ink-muted">Nothing. The plan was blocked before payout.</p>
          ) : (
            <table className="w-full text-[0.9rem]">
              <tbody>
                {r.sent.map((s) => (
                  <tr key={s.recipientId} className="border-b border-line-soft last:border-0">
                    <td className="py-1.5 font-semibold">{s.recipientId}</td>
                    <td className="num py-1.5 text-right">{usd(s.cents)}</td>
                    <td className={`py-1.5 pl-3 text-right ${s.authorised ? 'text-allow' : 'text-block'}`}>{s.authorised ? 'Registered' : 'Not entitled'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {r.sent.length ? (
            <p className="num mt-3 text-[0.85rem] text-ink-muted">
              Total {usd(r.sentCents)}
              {r.sent.every((x) => x.authorised) ? ', all to pre-registered recipients at tier-table amounts.' : `, of which ${usd(r.unauthorisedCents)} to people not entitled to it.`}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function Suite({ s }: { s: SuiteReport }) {
  const safe = s.payloads - s.firewall.payloadsWithUnauthorisedPayout;
  return (
    <div className="mt-5 space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-[var(--radius-control)] border border-allow/40 bg-allow-wash p-4">
          <p className="num text-[1.5rem] font-[800] text-allow">
            {safe} of {s.payloads} attacks moved {usd(s.firewall.unauthorisedCents)} to unauthorised payees
          </p>
          <p className="text-[0.88rem] text-ink-muted">
            The firewall result, checked against a hand-written table of what each household is owed. It does not depend on the sentinel. A firewall rule other than the $300 limit held {s.firewall.firewallFlagged} of {s.payloads}, and agent-written text reached PayPal in {s.firewall.agentTextDelivered}.
          </p>
        </div>
        <div className="rounded-[var(--radius-control)] border border-line p-4">
          <p className="num text-[1.05rem] font-bold">
            Sentinel flagged {s.sentinel.eitherCaught} of {s.payloads}
          </p>
          <p className="num text-[0.88rem] text-ink-muted">
            Pattern checks {s.sentinel.regexCaught} of {s.payloads}. Claude Haiku {s.sentinel.llmCaught ?? 'not measured'}
            {s.sentinel.llmCaught !== null ? ` of ${s.sentinel.llmMeasured}` : ''}. The sentinel is advisory: a flag only forces human review.
          </p>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-[0.88rem]">
          <thead className="text-ink-muted">
            <tr className="border-b border-line-soft text-left">
              <th className="py-2 pr-3 font-semibold">Attack</th>
              <th className="py-2 pr-3 font-semibold">Kind</th>
              <th className="py-2 pr-3 font-semibold">Patterns</th>
              <th className="py-2 pr-3 font-semibold">Claude Haiku</th>
              <th className="py-2 pr-3 font-semibold">Firewall</th>
              <th className="py-2 text-right font-semibold">Unauthorised</th>
            </tr>
          </thead>
          <tbody>
            {s.results.map((r) => (
              <tr key={r.id} className="border-b border-line-soft last:border-0">
                <td className="py-1.5 pr-3">{r.title}</td>
                <td className="py-1.5 pr-3 text-ink-muted">{r.category.replace('_', ' ')}</td>
                <td className={`py-1.5 pr-3 ${r.sentinel.regex ? 'text-ink' : 'text-ink-dim'}`}>{r.sentinel.regex ? 'Flagged' : 'Missed'}</td>
                <td className={`py-1.5 pr-3 ${r.sentinel.llm ? 'text-ink' : 'text-ink-dim'}`}>{r.sentinel.llm === null ? 'Not measured' : r.sentinel.llm ? 'Flagged' : 'Missed'}</td>
                <td className="py-1.5 pr-3">
                  <VerdictChip v={r.verdict} />
                </td>
                <td className="num py-1.5 text-right font-semibold text-allow">{usd(r.unauthorisedCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Residual rows={s.residual} />
    </div>
  );
}

const OUTCOME: Record<SuiteReport['residual'][number]['outcome'], { label: string; className: string }> = {
  stopped: { label: 'Stopped', className: 'text-allow-ink' },
  'needs a person': { label: 'Needs a person', className: 'text-hold' },
  'not stopped': { label: 'Not stopped', className: 'font-bold text-block-ink' },
};

function Residual({ rows }: { rows: SuiteReport['residual'] }) {
  return (
    <section aria-labelledby="residual-title" className="border-t border-line-soft pt-4">
      <h3 id="residual-title" className="text-[1rem] font-bold">
        Attacks that don&apos;t try to pay a stranger
      </h3>
      <p className="max-w-[78ch] text-[0.88rem] text-ink-muted">
        Same hijacked agent, same careless reviewer who approves everything. &ldquo;Needs a person&rdquo; means the plan is held and the reason named; a careless person can still approve it, and the shortfall column shows what households would then lose.
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[720px] text-[0.88rem]">
          <thead className="text-ink-muted">
            <tr className="border-b border-line-soft text-left">
              <th className="py-2 pr-3 font-semibold">Attack</th>
              <th className="py-2 pr-3 font-semibold">Outcome</th>
              <th className="py-2 pr-3 font-semibold">What stops it</th>
              <th className="py-2 pr-3 text-right font-semibold">Shortfall</th>
              <th className="py-2 text-right font-semibold">To anyone not owed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line-soft align-top last:border-0">
                <td className="py-1.5 pr-3">
                  <span className="font-semibold">{r.title}</span>
                  <span className="block text-ink-muted">{r.attempted}</span>
                </td>
                <td className={`py-1.5 pr-3 ${OUTCOME[r.outcome].className}`}>{OUTCOME[r.outcome].label}</td>
                <td className="py-1.5 pr-3 text-ink-muted">{r.defence}</td>
                <td className="num py-1.5 pr-3 text-right">{r.shortfallCents === null ? 'n/a' : usd(r.shortfallCents)}</td>
                <td className={`num py-1.5 text-right font-semibold ${r.unauthorisedCents > 0 ? 'text-block-ink' : 'text-allow'}`}>{usd(r.unauthorisedCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
