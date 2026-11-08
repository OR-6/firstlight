import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'How it works',
  description: 'Who Firstlight is for, how people are enrolled to receive relief cash, and how people and AI agents donate.',
};

const ROLES: { who: string; uses: string; can: string }[] = [
  {
    who: 'Aid organisation staff',
    uses: 'Mission control, Plans, Approvals, Payouts, Audit',
    can: 'Run an assessment, approve or deny what the firewall flags, send the payout batch, check the audit chain. In a real deployment these screens sit behind staff sign-in; the demo leaves them open so judges can try every step.',
  },
  {
    who: 'People affected by the earthquake',
    uses: 'Their own PayPal account, nothing here',
    can: 'Receive cash with a message in their language. They never apply after the disaster and never see this console.',
  },
  {
    who: 'Donors',
    uses: 'The Donate page and PayPal',
    can: 'Give $1 to $100, approve it on PayPal, get a receipt whose audit entry they can verify.',
  },
  {
    who: 'AI agents donating for someone',
    uses: 'The manifest, llms.txt and the MCP server',
    can: "Find Firstlight, check the pool and active earthquakes, create a donation. A person still approves every payment on PayPal. Nothing an agent sends reaches the payout agent.",
  },
];

export default function HowItWorks() {
  return (
    <article className="max-w-[78ch] space-y-8">
      <header>
        <h1 className="text-[1.5rem] font-[800]">How Firstlight works</h1>
        <p className="mt-2 text-[1.05rem] text-ink-muted">
          After a major earthquake, people need cash first and it usually arrives last. Firstlight is for aid organisations that run cash programmes. When a strong quake is confirmed near households they have already enrolled, an AI agent drafts who
          should get how much, a deterministic payment firewall checks it, a person approves anything unusual, and PayPal sends the money. Nobody has to fill in a form while their house is damaged.
        </p>
      </header>

      <section aria-labelledby="who">
        <h2 id="who" className="text-[1.15rem] font-bold">
          Who uses what
        </h2>
        <div className="panel mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[0.93rem]">
            <thead className="text-[0.85rem] text-ink-muted">
              <tr className="border-b border-line-soft">
                <th className="px-4 py-2.5 font-semibold">Who</th>
                <th className="px-4 py-2.5 font-semibold">Uses</th>
                <th className="px-4 py-2.5 font-semibold">Can</th>
              </tr>
            </thead>
            <tbody>
              {ROLES.map((r) => (
                <tr key={r.who} className="border-b border-line-soft align-top last:border-0">
                  <th scope="row" className="px-4 py-3 font-semibold">
                    {r.who}
                  </th>
                  <td className="px-4 py-3 text-ink-muted">{r.uses}</td>
                  <td className="px-4 py-3">{r.can}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="enrol" className="space-y-3">
        <h2 id="enrol" className="text-[1.15rem] font-bold">
          How people are enrolled to receive money
        </h2>
        <p>
          Enrolment happens before a disaster, through the aid organisation&apos;s field partners: local Red Cross branches, municipalities, community groups. A caseworker checks identity, records the home location, the person&apos;s language and
          any flags such as limited mobility, and links a PayPal account. Firstlight only ever sees an id, a town, a home location and those flags. The PayPal address lives in a separate map that only the payout step can read.
        </p>
        <p>
          There is deliberately no public sign-up. Fake registrations flood in after every disaster, so the firewall refuses anyone enrolled less than 72 hours before the earthquake (rule R1). Someone missed by enrolment is helped through the
          partner&apos;s normal channels, not through a form the agent could be pointed at.
        </p>
        <p className="text-ink-muted">In this demo the eight enrolled households near the M7.7 Panama earthquake are synthetic, and their PayPal accounts are sandbox test accounts.</p>
      </section>

      <section aria-labelledby="give" className="space-y-3">
        <h2 id="give" className="text-[1.15rem] font-bold">
          How donors find Firstlight and give
        </h2>
        <p>
          People donate on the <Link href="/donate" className="font-semibold text-allow underline-offset-2 hover:underline">Donate page</Link>: choose an amount, approve it on PayPal, and come back to a receipt. The pool, what has been paid
          out and to how many people are shown there, live.
        </p>
        <p>
          AI agents, such as an assistant someone has asked to give $5 to earthquake relief, find Firstlight through{' '}
          <a href="/.well-known/firstlight.json" className="font-semibold text-allow underline-offset-2 hover:underline">
            its manifest
          </a>{' '}
          and{' '}
          <a href="/llms.txt" className="font-semibold text-allow underline-offset-2 hover:underline">
            llms.txt
          </a>
          , then donate over MCP at <code className="num">/mcp</code>. The agent can only create a PayPal order; the person it works for approves the payment on PayPal, so there is real permission from a real customer. Every receipt carries
          audit-log hashes the donor can check at <code className="num">/api/audit/verify</code>.
        </p>
      </section>

      <section aria-labelledby="safe" className="space-y-3">
        <h2 id="safe" className="text-[1.15rem] font-bold">
          Why the agent can&apos;t be talked into paying the wrong person
        </h2>
        <p>
          The agent reads news and agency text that anyone could have poisoned. So it is given no way to name an email, an amount or an account: it can only pick ids it was shown and a tier. The firewall then recomputes every amount from the
          tier table and checks eligibility, limits, budget, duplicates and corroboration from two seismic agencies. The <Link href="/redteam" className="font-semibold text-allow underline-offset-2 hover:underline">red-team console</Link> runs 27
          injection attacks against an agent that obeys every one of them; none moves money to anyone who isn&apos;t enrolled.
        </p>
      </section>

      <section aria-labelledby="real" className="space-y-3">
        <h2 id="real" className="text-[1.15rem] font-bold">
          What a real deployment would add
        </h2>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>Staff sign-in and roles for the console; two-person approval above a set amount.</li>
          <li>Donations routed through a registered charity or licensed partner, with sanctions screening and identity checks at enrolment.</li>
          <li>A persistent database and the live USGS feed switched on (the demo replays a real recorded earthquake).</li>
        </ul>
        <p className="text-ink-muted">Everything here runs in the PayPal sandbox. No real money moves; please don&apos;t send real money.</p>
      </section>
    </article>
  );
}
