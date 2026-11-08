/**
 * Real PayPal sandbox runs we made while building, so a judge sees evidence
 * before sending anything (the hosted database resets on restart). Each id is
 * a real sandbox object; docs/decisions.md records how each run went, and the
 * details below are copied from those notes, nothing more.
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
      { label: 'Where', value: 'The dashboard after a demo reset: replayed Claude Opus 5.5 assessment, approved in the UI' },
      { label: 'Items', value: '7 of 7 SUCCESS, $680.00 in total' },
      { label: 'Timing', value: 'Statuses arrived live on the page without a reload' },
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
      { label: 'Where', value: 'The CLI: a live claude-opus-5-5 assessment (2 turns, about 24 s), approved via the CLI' },
      { label: 'Items', value: '7 recipients, $680.00, all SUCCESS; pool $5,000 → $4,320' },
      { label: 'Timing', value: 'Items SUCCESS at about 26 s, batch SUCCESS at about 33 s' },
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

export function SandboxEvidence() {
  return (
    <section className="panel overflow-hidden" aria-labelledby="evidence-title">
      <div className="border-b border-line-soft px-5 py-4">
        <h2 id="evidence-title" className="text-[1.05rem] font-bold">
          Runs already made in the PayPal sandbox
        </h2>
        <p className="max-w-[72ch] text-[0.92rem] text-ink-muted">
          The demo database starts empty after every restart, so here are the real sandbox runs we made while building it. The ids are PayPal&apos;s own. Open a run to see what we
          recorded about it.
        </p>
      </div>
      <ul>
        {RUNS.map((r) => (
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
              </summary>
              <dl className="grid gap-x-5 gap-y-1.5 bg-raised px-5 py-3 pl-[2.375rem] text-[0.88rem] sm:grid-cols-[9rem_minmax(0,1fr)]">
                <dt className="text-ink-dim">{r.idLabel}</dt>
                <dd className="num break-all">{r.id}</dd>
                {r.facts.map((f) => (
                  <div key={f.label} className="contents">
                    <dt className="text-ink-dim">{f.label}</dt>
                    <dd className="text-ink-muted">{f.value}</dd>
                  </div>
                ))}
              </dl>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
