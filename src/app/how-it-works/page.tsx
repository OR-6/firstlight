import type { Metadata } from 'next';
import Link from 'next/link';
import { defaultFirewallConfig } from '@/firewall/config';
import { Mark, type State } from '@/ui/SignMark';

/** The fixed English note PayPal delivers, as configured (pure config, no I/O). */
const EN_NOTE = (() => {
  const c = defaultFirewallConfig();
  return (c.payoutNotes.en ?? c.fallbackNote).replace('{amount}', '$120.00');
})();

/** Prose stays near 75 characters a line; tables, code and diagrams use the wider column. */
const PROSE = 'max-w-[64ch]';

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
    uses: 'Their own account, nothing here',
    can: "Receive the money in their own PayPal account (Venmo in the US), or through a licensed partner's rail where they have neither, with a message in their language. They never apply after the disaster and never see this console.",
  },
  {
    who: 'Donors',
    uses: 'The Donate page and PayPal',
    can: 'Give $1 to $100, approve it on PayPal, get a receipt whose audit entry they can verify.',
  },
  {
    who: 'AI agents donating for someone',
    uses: 'The manifest, llms.txt and the MCP server',
    can: 'Find Firstlight, check the pool and active earthquakes, and donate within an allowance a person set on the Agents page. A person still approves every payment on PayPal. Nothing an agent sends reaches the payout agent.',
  },
];

/** The path a payment takes, with who acts at each stage. Same sign-board look as the live board on Mission control. */
const STAGES: { name: string; who: string; does: string; mark: State }[] = [
  { name: 'Earthquake confirmed', who: 'USGS and EMSC', does: 'M6.0 or stronger, or a PAGER orange alert, reported by two independent seismic agencies.', mark: 'done' },
  { name: 'Agent drafts', who: 'The AI agent', does: 'Reads both reports and picks enrolled households and a tier for each. It never sees an email or an amount.', mark: 'done' },
  { name: 'Firewall checks', who: 'Fixed code, no AI', does: 'Recomputes every amount from the tier table and checks eligibility, limits, budget and duplicates. It can stop the plan.', mark: 'checkpoint' },
  { name: 'Person approves', who: 'Aid organisation staff', does: 'Only when the firewall flags something, such as a total over $300. Approving can never raise an amount.', mark: 'wait' },
  { name: 'PayPal pays', who: 'PayPal Payouts', does: 'One batch to the households’ own PayPal accounts, with a note in their language.', mark: 'done' },
];

function PathDiagram() {
  return (
    <figure className="space-y-2">
      <div className="rounded-[var(--radius-panel)] bg-allow p-[3px] text-white">
        <ol className="grid rounded-[4px] border-2 border-white/90 py-4 md:grid-cols-5 md:py-0">
          {STAGES.map((s, i) => {
            const last = i === STAGES.length - 1;
            return (
              <li key={s.name} className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-3 px-4 md:block md:py-4">
                {/* Mark and connector: vertical on phones, horizontal from 768 px. */}
                <div className="flex flex-col items-center md:mb-2.5 md:h-5 md:flex-row" aria-hidden>
                  <Mark state={s.mark} />
                  {!last ? <span className="my-1 w-0 flex-1 border-l-[3px] border-white md:mx-0 md:my-0 md:ml-1.5 md:h-0 md:w-auto md:border-l-0 md:border-t-[3px]" /> : null}
                </div>
                <div className={`min-w-0 ${last ? '' : 'pb-4'} md:pb-0`}>
                  <p className="text-[0.85rem] text-white/80">Stage {i + 1}</p>
                  <h3 className="text-[1.05rem] font-bold leading-snug">{s.name}</h3>
                  <p className="mt-1 inline-block rounded-[var(--radius-chip)] bg-white px-1.5 py-px text-[0.8rem] font-semibold text-allow-ink">{s.who}</p>
                  <p className="mt-1.5 text-[0.875rem] leading-snug text-white/90">{s.does}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      <figcaption className="text-[0.85rem] text-ink-dim">
        The square is the checkpoint where fixed code checks every plan. On Mission control that stage shows its result instead: a check when the plan is allowed, a diamond when a person has to decide, a red octagon when it is blocked.
      </figcaption>
    </figure>
  );
}

export default function HowItWorks() {
  return (
    <article className="space-y-8">
      <header className={PROSE}>
        <h1 className="text-[1.5rem] font-[800]">How Firstlight works</h1>
        <p className="mt-2 text-[1.05rem] text-ink-muted">
          After a major earthquake, people need cash first and it usually arrives last. Firstlight is for aid organisations that run cash programmes. When a strong quake is confirmed near households they have already enrolled, an AI agent drafts who
          should get how much, a deterministic payment firewall checks it, a person approves anything unusual, and PayPal sends the money. Nobody has to fill in a form while their house is damaged.
        </p>
      </header>

      <section aria-labelledby="path" className="max-w-[1200px]">
        <h2 id="path" className="mb-3 text-[1.15rem] font-bold">
          The path a payment takes
        </h2>
        <PathDiagram />
      </section>

      <div className="max-w-[1100px] space-y-8">
        <section aria-labelledby="who">
          <h2 id="who" className="text-[1.15rem] font-bold">
            Who uses what
          </h2>
          <div className="panel mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label="Who uses what">
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

        <section aria-labelledby="enrol" className={`${PROSE} space-y-3`}>
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
          <p>
            Enrolment doesn&apos;t have to be a separate list. Where a government already runs a social registry for cash transfers, the same pre-checked households can be used, and the firewall pays a top-up when the quake hits. The sector calls
            this shock-responsive social protection.
          </p>
          <p className="text-ink-muted">In this demo the eight enrolled households near the M7.7 Panama earthquake are synthetic, and their PayPal accounts are sandbox test accounts.</p>
        </section>

        <section aria-labelledby="lastmile" className={`${PROSE} space-y-3`}>
          <h2 id="lastmile" className="text-[1.15rem] font-bold">
            Who can actually receive the money
          </h2>
          <p>
            Many rural households hit hardest by an earthquake don&apos;t have a PayPal account. PayPal Payouts reaches PayPal accounts, and Venmo accounts in the US only. For households without one, a real deployment would put a licensed partner&apos;s or a
            mobile-wallet provider&apos;s rail behind the same firewall, so the same checks decide who is paid and how much. Turning that money into cash nearby, and checking afterwards that people got it, is the field partner&apos;s job.
          </p>
          <p>
            Every payment arrives with the same fixed message in the household&apos;s language. It says what the money is, that nothing needs to be done, names the field partner who enrolled them with that partner&apos;s help line for questions or if the money doesn&apos;t arrive, and that nobody from the
            programme will ask for a password, code or fee. The agent can&apos;t change it. In English it reads:
          </p>
          <p lang="en" className="rounded-[var(--radius-control)] border border-line-soft bg-panel px-3 py-2 text-[0.95rem]">
            {EN_NOTE}
          </p>
          <p className="text-ink-muted">
            The amounts ($120, $80, $40 by distance) are demo values. A real programme sets them as a share of the local minimum expenditure basket and by household size.
          </p>
        </section>

        <section aria-labelledby="wrong" className={`${PROSE} space-y-3`}>
          <h2 id="wrong" className="text-[1.15rem] font-bold">
            If the money doesn&apos;t arrive, or something is wrong
          </h2>
          <p>
            The household contacts the field partner who enrolled them. The payment note names that partner and gives their help line (synthetic in this demo).
          </p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              The partner checks the payment&apos;s status in PayPal Payouts, shown on the{' '}
              <Link href="/payouts" className="font-semibold text-allow underline-offset-2 hover:underline">
                Payouts page
              </Link>
              : paid, unclaimed, returned or failed, with PayPal&apos;s reason.
            </li>
            <li>
              A payment nobody has claimed can be cancelled, which puts the money back in the pool. Once the partner has fixed the account details, it is sent again through the same firewall checks.
            </li>
            <li>Complaints, such as a wrong amount or a household left out, are logged by the partner and reviewed by the aid organisation.</li>
            <li>
              After the payments, the partner contacts a sample of households to check the money arrived, could be turned into cash and was used as needed. Aid organisations call this post-distribution monitoring.
            </li>
          </ul>
        </section>

        <section aria-labelledby="data" className={`${PROSE} space-y-3`}>
          <h2 id="data" className="text-[1.15rem] font-bold">
            Personal data
          </h2>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              <span className="font-semibold">Consent at enrolment.</span> The caseworker explains what is recorded, why, and who sees it, and the household agrees before anything is stored.
            </li>
            <li>
              <span className="font-semibold">What the AI agent sees:</span> an id, the town, the distance from the epicentre and a yes or no for whether the household gets a higher tier because of a health or care need. Never the condition
              itself, a name, an email or a PayPal account.
            </li>
            <li>
              <span className="font-semibold">What PayPal sees,</span> as the payment provider: the household&apos;s PayPal account, the amount and the fixed note. Nothing about why they were chosen.
            </li>
            <li>
              <span className="font-semibold">Home locations</span> are stored at village level in a real deployment. That is enough to work out the distance bands, and it doesn&apos;t point to a house.
            </li>
            <li>
              <span className="font-semibold">Retention.</span> Personal data is kept for the programme and its reporting period, then deleted. A household can ask to be removed from the registry at any time.
            </li>
          </ul>
          <p className="text-ink-muted">The demo&apos;s households are synthetic and their homes are single map points.</p>
        </section>

        <section aria-labelledby="give" className={`${PROSE} space-y-3`}>
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
            , then donate over MCP at <code className="num">/mcp</code>. First the person it works for sets an allowance on the{' '}
            <Link href="/agents" className="font-semibold text-allow underline-offset-2 hover:underline">
              Agents page
            </Link>
            : who the agent is, how much it may give and until when. The server enforces it, and the person still approves every payment on PayPal, so there is real permission from a real customer. Every receipt carries audit-log hashes the
            donor can recompute itself.
          </p>
        </section>

        <section aria-labelledby="rules" className={`${PROSE} space-y-3`}>
          <h2 id="rules" className="text-[1.15rem] font-bold">
            Who sets the rules, and who decides
          </h2>
          <p>
            The firewall&apos;s settings are the programme&apos;s pre-agreed trigger and payment rules: how strong a quake must be, how far from it each tier reaches, what each tier pays, and the limits. In humanitarian terms they are an
            early-action protocol, signed off before the season, not chosen by the agent on the day. The approval step is the designated person&apos;s decision: when the firewall flags a plan, that person approves or denies it, and can
            never raise an amount.
          </p>
        </section>

        <section aria-labelledby="pilot" className={`${PROSE} space-y-3`}>
          <h2 id="pilot" className="text-[1.15rem] font-bold">
            Path to a pilot
          </h2>
          <dl className="space-y-3">
            <div>
              <dt className="font-semibold">Who signs</dt>
              <dd className="text-ink-muted">
                The cash programme that runs the response, such as a national Red Cross or Red Crescent society or a government social-protection agency, signs the early-action protocol before the season. Firstlight runs what it
                signed; it doesn&apos;t set policy.
              </dd>
            </div>
            <div>
              <dt className="font-semibold">What the programme configures</dt>
              <dd className="text-ink-muted">
                Tier amounts from the local minimum expenditure basket, the distance bands and trigger, per-household and per-event limits, the approval threshold, and the field partner and help line named in the payment note.
              </dd>
            </div>
            <div>
              <dt className="font-semibold">What Firstlight replaces</dt>
              <dd className="text-ink-muted">
                Today, after a quake, staff register affected households by hand, build a spreadsheet of who gets what, and upload it as a bulk transfer. Firstlight starts from households enrolled beforehand and replaces the spreadsheet and
                the bulk upload with a checked plan, one approval and one payout batch.
              </dd>
            </div>
            <div>
              <dt className="font-semibold">How a pilot is measured</dt>
              <dd className="text-ink-muted">
                Time from the trigger to the first dollar in a household&apos;s account. Alongside it: the share of eligible households paid in full, and money that reached anyone not owed, which must stay at zero.
              </dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="safe" className={`${PROSE} space-y-3`}>
          <h2 id="safe" className="text-[1.15rem] font-bold">
            Why the agent can&apos;t be talked into paying the wrong person
          </h2>
          <p>
            The agent reads news and agency text that anyone could have poisoned. So it is given no way to name an email, an amount or an account: it can only pick ids it was shown and a tier. The firewall then recomputes every amount from the
            tier table and checks eligibility, limits, budget, duplicates and corroboration from two seismic agencies. The <Link href="/redteam" className="font-semibold text-allow underline-offset-2 hover:underline">red-team console</Link> runs 27
            injection attacks against an agent that obeys every one of them; none moves money to anyone who isn&apos;t enrolled.
          </p>
        </section>

        <section aria-labelledby="real" className={`${PROSE} space-y-3`}>
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
      </div>
    </article>
  );
}
