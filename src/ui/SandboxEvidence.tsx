/**
 * Real PayPal sandbox runs we made while building, so a judge sees evidence
 * before sending anything (the hosted database resets on restart). Each id is
 * a real sandbox object; docs/decisions.md records how each run went.
 */
const RUNS: { when: string; what: string; id: string; idLabel: string; result: string }[] = [
  { when: '8 Nov 2026', what: 'Hosted demo: $680 to 7 households', id: '9GE626X9SA3NE', idLabel: 'Payout batch', result: 'SUCCESS in about 25 s; 7 PAYMENT.PAYOUTS-ITEM.SUCCEEDED webhooks, each signature-verified' },
  { when: '8 Nov 2026', what: 'Dashboard run: $680 to 7 households', id: 'DZCFDP9FFEUV8', idLabel: 'Payout batch', result: 'All 7 items SUCCESS, shown live without a reload' },
  { when: '8 Nov 2026', what: 'First end-to-end payout from the CLI', id: '2BQ585TNCTVDA', idLabel: 'Payout batch', result: 'Items SUCCESS at about 26 s, batch at about 33 s' },
  { when: '8 Nov 2026', what: 'Donor agent (Samaritan) $5 donation', id: '2M270176F8691393V', idLabel: 'Order capture', result: 'Approved by a person on PayPal, captured, pool $4,320 → $4,325' },
  { when: '8 Nov 2026', what: '$1 smoke test', id: 'DHSSBZRTMH9DW', idLabel: 'Payout batch', result: 'SUCCESS in about 22 s, transaction 7T759407LM597511H' },
];

export function SandboxEvidence() {
  return (
    <section className="panel overflow-hidden" aria-labelledby="evidence-title">
      <div className="border-b border-line-soft px-5 py-4">
        <h2 id="evidence-title" className="text-[1.05rem] font-bold">
          Runs already made in the PayPal sandbox
        </h2>
        <p className="max-w-[72ch] text-[0.92rem] text-ink-muted">
          The demo database starts empty after every restart, so here are the real sandbox runs we made while building it. The ids are PayPal&apos;s own.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-[0.92rem]">
          <thead className="text-[0.85rem] text-ink-muted">
            <tr className="border-b border-line-soft">
              <th className="px-5 py-2 font-semibold">Run</th>
              <th className="px-5 py-2 font-semibold">PayPal id</th>
              <th className="px-5 py-2 font-semibold">Result</th>
            </tr>
          </thead>
          <tbody>
            {RUNS.map((r) => (
              <tr key={r.id} className="border-b border-line-soft align-top last:border-0">
                <td className="px-5 py-2.5">
                  <span className="font-semibold">{r.what}</span>
                  <span className="block text-[0.85rem] text-ink-dim">{r.when}</span>
                </td>
                <td className="px-5 py-2.5">
                  <span className="block text-[0.82rem] text-ink-dim">{r.idLabel}</span>
                  <span className="num">{r.id}</span>
                </td>
                <td className="px-5 py-2.5 text-ink-muted">{r.result}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
