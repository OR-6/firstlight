# Firstlight — Submission Kit (PayPal AI Hackathon)

Everything you need to paste into Devpost, plus the video script and a final checklist. Fill the `[BRACKETS]` once the build is done; don't claim numbers you haven't measured.

**Deadline: Thu 12 Nov 2026, 12:00 PT = 21:00 Amsterdam. Target: submit by Thu 12:00 Amsterdam.**

---

## 1. Project name

**Firstlight** (recommended).

Alternates if it's taken or you want a different feel: **Tripline** (trigger + guardrail), **Aegis Relief** (shield). Check the name isn't already used by a notable product before you commit.

## 2. Tagline (56 characters)

> Earthquake relief cash in minutes, no application needed

Lead with the relief, not the firewall: about 160 entries this year pitch an "agent payment firewall". The firewall is *why it's safe*, not *what it is*.

## 3. Elevator pitch (short description, under 200 characters)

> Aid groups enrol families before a quake. Minutes after two agencies confirm it, an AI agent drafts payouts, a firewall checks every dollar, a person approves, PayPal pays. Nobody applies.

(Under 200 characters. Longer version for places with room: "For aid organisations that run cash programmes. When two seismic agencies confirm a strong earthquake near families they enrolled beforehand, an AI agent drafts the payouts within minutes and nobody has to apply. A deterministic firewall checks every payment before PayPal Payouts sends it: a hijacked agent can't pay anyone who isn't owed, can't pay more than the tier table allows, and can't write a word to recipients. If it pays someone less or leaves them out, a person sees exactly who and how many dollars, and one click drafts the firewall's own full plan. Other AI agents can fund the pool over MCP, but only inside a cap a person set, and only a person can pay, on PayPal.")

---

## 4. Project story (paste into the Devpost sections)

### Inspiration
After Nepal's 2015 earthquake, emergency cash took more than two months to start arriving, and it mostly reached people who managed to register (UNICEF's emergency top-ups through social assistance began paying in July, after the 25 April quake). Anticipatory, parametric cash programmes move that work to before the disaster: households are enrolled in advance and paid when a pre-agreed trigger fires. Early cash works. When WFP sent cash to Bangladeshi households about four days before the 2020 flood peak, some 100 days earlier than its 2019 response, those households were 36% less likely to go a day without eating (WFP / Centre for Disaster Protection review). Earthquakes can't be forecast, so the fastest honest version is to pay households an aid organisation enrolled *before* the quake, within minutes of it being confirmed. Firstlight doesn't replace the full response; it pays a first, pre-agreed transfer while the assessment happens.

An AI agent could make that call in minutes. But nobody should hand a language model a payout button: one poisoned news item could redirect the money. We wanted the version a cash-programme lead at a Red Cross national society or a cash NGO could actually trust, where the safety comes from the architecture, not from hoping the model behaves.

### What it does
- **No application.** Most relief apps ask survivors to apply and an AI to judge them, which is exactly where fraud and injection get in. Here households are enrolled before the quake by field partners, the trigger is two seismic agencies, not a form, and the AI agent's output has no field where a payee or an amount could go.
- **A firewall with a floor, not just a ceiling.** Other payment firewalls stop an AI from paying too much. Firstlight also stops it from quietly paying too little or leaving someone out: the reviewer sees exactly who and how many dollars, and one click drafts the plan of everyone owed.
- **For the cash-programme lead at a Red Cross national society or a cash NGO** who has to sign off on every dollar. The firewall's settings are the programme's pre-agreed trigger and payment rules. In our sandbox run every one of seven payouts ($680) showed SUCCESS about 25 seconds after the batch was sent (our audit log); PayPal's own record has batch `9GE626X9SA3NE` complete 34 seconds after creation. Nobody applied.
- **Real earthquake data.** USGS, cross-checked against a second agency (EMSC). The hosted demo replays the real M7.7 Panama earthquake of 9 October 2026 so every run is reproducible.
- **An AI agent reads what the rules can't.** Tiers and amounts come from rules agreed before the quake (distance bands that shrink for smaller quakes, one tier up for vulnerability). The agent reads the agencies' impact reports and flags where those rules may under-serve people: in the Panama run it asked a person to check households in Macaracas and Santiago, where USGS reported deaths. It never learns a household's health condition, only that an uplift applies.
- **A deterministic firewall decides.** It recomputes every amount, enforces caps and blocks duplicates. If a plan leaves an eligible household out or pays it too little, the reviewer sees who and how many dollars (R12), and one click drafts the firewall's own plan of everyone owed.
- **Every step is traceable.** Each payout batch links to its entries in a hash-chained audit log, filterable by plan, batch or event type; "Tamper with a copy" shows the chain breaking at an edited entry; /payouts reads the recorded sandbox batches back from PayPal and shows they match, fees included.
- **PayPal pays.** Approved plans go out as one **PayPal Payouts** batch; signature-verified **webhooks** drive live status, and each batch is reconciled with PayPal's own record. Recipients get a fixed note in their language naming the partner who enrolled them and its help line; the agent can't write to them, so it can't phish them.
- **People and other AI agents fund the pool** through **PayPal Orders v2**. An agent can ask, but only a person can pay, and only up to an allowance that person set on the site. The first approval ties the allowance to that PayPal account. Every receipt is confirmed with PayPal itself (PayPal's hosted MCP server, read-only `get_order`, with the Orders API as fallback) and carries the capture id the donor sees in their PayPal activity.
- **The firewall is an MCP tool too.** `check_payout_plan` lets any tool that drafts payouts for this programme (a partner's spreadsheet importer, a second hazard agent, an auditor's agent) run its plan through the same firewall first: a plan that pays one household and slips in an attacker's address comes back with the attacker blocked and six households worth $560 flagged as left out. No money moves.
- **A Red Team page anyone can run**: 27 injection attacks against an agent we scripted to obey every one. 26 are held for a person and 1 is blocked outright, each by a rule other than the $300 limit; even when a scripted careless reviewer approves, $0 reaches anyone not owed. Six quieter attacks show their real outcome, including the one we don't stop.

### How we built it
- **Capability restriction instead of detection.** The agent can only name registry ids and tiers. Its output has no field for an email, an amount or an account, and its notes are never sent. An injection has nowhere to put an attacker. A sentinel (patterns plus a small classifier model) adds a second, advisory layer.
- **The agent never holds credentials.** Only the PayPal module does, and it only acts on verdicts that are in the audit log, after re-running the firewall against the ledger as it is at that moment.
- **PayPal Payouts:** one batch per approved plan. Idempotency in two layers: the PayPal-Request-Id is a hash of the event, households and amounts in the firewall verdict (notes left out), and the database enforces one payout per (event, household), so neither a retry nor a second plan version can pay anyone twice (on the hosted demo the key also includes a per-database id, so a demo reset starts fresh); a timeout is resent under the same id; `sender_item_id` is event:household. Item statuses (SUCCESS, UNCLAIMED, RETURNED…) and PayPal's transaction ids and failure reasons are reconciled with a GET on every signature-verified webhook, with polling as a fallback.
- **PayPal Orders v2** through the PayPal Server SDK: captured on the return URL or on `CHECKOUT.ORDER.APPROVED` for donors who never come back. Pending or denied captures never credit the pool; refund and reversal webhooks debit it.
- **APIMatic Context Plugin:** before any PayPal code, we used it to look up the Server SDK's Orders, Payments and Transaction Search endpoints and models. It caught that `payer.payer_id` is deprecated (allowances bind to `payment_source.paypal.account_id`), that the approval link is `rel: payer-action`, that the SDK's request log includes the token (so it's off), and that the SDK has no Payouts or webhook verification (so those went to REST).
- **An integer-cents pool ledger.** Each credit or debit is unique per PayPal capture, batch or item id; a batch is reserved and debited in one SQLite transaction before PayPal is called; PayPal's batch fees are booked from `batch_header.fees`; refunds reserve their debit before calling PayPal.
- **AI:** an LLM is the agent (strict tool schemas, read-only tools, one repair turn); a small classifier model is the advisory sentinel.
- **Stack:** Next.js and TypeScript, SQLite, AG Grid, Leaflet, hosted on Render. A pure firewall (no I/O, no clock, no LLM), enforced by tests that scan its source and walk everything it imports.
- **Design:** an operations console in the language of road signs, so status reads by shape as well as colour. Every hold says why a person must decide, in dollars and town names; on a phone a yellow bar follows the reviewer to the decision; every household opens to a plain-English list of each firewall check and the exact message PayPal will send.
- **Replay mode:** on the hosted demo the recorded agent run is replayed, so you can try the whole flow, including real sandbox payouts, without keys of your own. Locally, assessing and the red team need no keys; paying needs PayPal sandbox credentials.
- **Honest limits:** in the demo anyone can approve, send payouts or refund a donation (no sign-in); a real deployment needs staff sign-in and two approvers above a threshold.

### Challenges we ran into
- Designing for a *compromised* agent, not a well-behaved one: the test harness swaps in a script that obeys every injected instruction, and a reviewer who approves everything.
- Our own review found that capping what the agent can pay isn't enough: a hijacked agent could still quietly pay people less, leave them out, or phish them through the payout note. We added a floor rule and fixed notes, and we list what remains.
- PayPal batch webhooks don't carry item detail, so status is reconciled by fetching the batch; a failed webhook is processed on PayPal's retry instead of being dropped as a duplicate.

### Accomplishments we're proud of
- **$0 to anyone not owed in 27 of 27 attacks** against an agent we scripted to obey every one, judged against a hand-written table of what each household is owed. Every attack is also held by a firewall rule other than the $300 approval limit, and agent-written text reached PayPal in none. The advisory sentinel (patterns plus a classifier model) flagged them too, but the guarantee doesn't depend on it.
- **A poisoned feed can't quietly withhold aid:** if the agent holds, forges an event id or leaves people out, deterministic code drafts the full owed plan for a person to approve.
- Real sandbox payouts: batch `9GE626X9SA3NE` paid $680 to seven sandbox accounts in about 25 seconds, confirmed by seven signature-verified `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` webhooks.
- **The firewall is an MCP tool other agents can call:** `check_payout_plan` dry-runs any payout plan against R1–R12 before anything is sent to PayPal.
- Any MCP client can donate with no SDK: `tools/list` publishes the enforced limits, refusals come back as typed codes (`ALLOWANCE_UNKNOWN`, `ALLOWANCE_EXCEEDED`), and our example agent recomputes every audit hash itself.
- An honest residual-risk table: a reviewer who approves without reading would still let under-payment through (the page shows the dollar shortfall), and an insider swapping a payee address is not stopped. We say so on the page.
- 868 tests in 38 files, green in CI next to typecheck, zero-warning lint and the red-team suite, including a seeded property test over 3,000 compromised-agent plans, a model-based test that runs random ledger operations (reservations, stale PayPal reports, refunds below zero, fee corrections) against an independent model after every step, and purity tests (a source scan plus a walk of everything the firewall imports) that fail if it ever reads the clock, environment, database, network or an LLM. CI runs them, lint and the red team on every push.

### What we learned
For AI agents that move money, "make the model safer" is the wrong place to put the guarantee. The model should propose; deterministic code should dispose. Limiting what the agent can *express* does more than trying to detect what it was told, and a floor matters as much as a ceiling.

And on PayPal: the Server SDK has no Payouts or webhook verification, so those go to REST; verify webhooks on the raw bytes; batch webhooks carry no item detail, so GET the batch; book `batch_header.fees` or your ledger drifts from PayPal.

### What's next
- Sign in with PayPal when creating an allowance, so the cap is bound to a verified PayPal customer up front, not at its first approved payment.
- Bands from USGS ShakeMap intensity at each home instead of distance (today: distance bands scaled by magnitude), and enrolment on top of an existing government social registry (shock-responsive social protection).
- A pilot design with a cash-programme partner in Central America: transfer values set from the local minimum expenditure basket and household size, and delivery through whatever rail households have (PayPal, Venmo, or a licensed partner's cash-out).
- More hazards (floods, cyclones, heat) through adapters that feed the same firewall.
- Working with licensed disbursement partners and local aid organisations. A real deployment needs identity verification and sanctions screening, which a hackathon sandbox can't demonstrate.

### Limitations (also in the README)
Firstlight runs entirely in the PayPal **sandbox**; no real money moves. All recipients are synthetic test accounts with invented locations. It is a prototype, not a financial product. Collecting and redistributing donations is regulated, so a real deployment would route funds through a registered charity (for example via PayPal Giving Fund) or a licensed partner rather than holding them itself.

---

## 5. Built with (tags)

`paypal` `paypal-payouts-api` `paypal-orders-api` `paypal-webhooks` `paypal-server-sdk` `ai-agents` `llm` `model-context-protocol` `apimatic` `ag-grid` `render` `typescript` `nextjs` `react` `nodejs` `sqlite` `tailwindcss` `leaflet` `usgs-earthquake-api` `emsc` `zod` `vitest` `postman` `paypal-mcp-server`

## 6. Tools used and how (the form asks for this)

- **An LLM (via API)** — the runtime agent: it checks the trigger is met, assigns tiers and flags anything a person should see; it never writes what recipients receive. A small classifier model is the advisory injection sentinel.
- **PayPal Payouts (REST)** — one batch per approved plan; the PayPal-Request-Id is a hash of what the firewall approved, so a resend returns the same batch; item statuses only move forward.
- **PayPal Orders v2 and refunds (Server SDK)** — donations with a payer-action link, captured on return or on `CHECKOUT.ORDER.APPROVED`; staff refunds reserve their debit first.
- **PayPal webhooks** — every delivery checked with verify-webhook-signature on the raw bytes, with 2 s polling as a fallback; every batch reconciled with PayPal's own record and its fees booked.
- **PayPal's hosted MCP server** (sandbox, read-only `get_order` only) — confirms every donation receipt with PayPal itself, with the Server SDK as fallback. PayPal's toolkit has no Payouts call, so payouts stay on REST behind the firewall.
- **PayPal Transaction Search (Server SDK)** — balance check before a batch and transaction lookups: built and tested; the hosted demo's sandbox app doesn't have the feature enabled yet, so live reconciliation uses the Payouts batch record.
- **Model Context Protocol** — a Streamable HTTP server at `/mcp` with six tools: get_pool_status, list_active_events, get_allowance, create_donation, get_receipt and check_payout_plan. `check_payout_plan` dry-runs a payout plan for this programme's households against the firewall without moving money. Every tool has strict input and output schemas; agents find the server through `/.well-known/firstlight.json` and `/llms.txt`.
- **USGS Earthquake Hazards API** — the recorded M7.7 Panama event (us6000u18k) the demo replays, plus a read-only live-feed script. **EMSC SeismicPortal** — independent corroboration.
- **APIMatic Context Plugin for PayPal** — used before any PayPal code was written to look up the Server SDK's Orders, Payments and Transaction Search endpoints. It surfaced the `rel: payer-action` approval link, the deprecated `payer.payer_id` (so allowances bind to `payment_source.paypal.account_id`) and the SDK's token logging (switched off), and showed the SDK has no Payouts or webhook verification, so those went to REST.
- **AG Grid** — the plan grid (pinned total row, sortable distance and amount, keyboard row opening) and the payout grid (per-batch CSV export for finance with PayPal transaction ids and failure reasons), themed to the road-sign design system with only the modules in use; card layouts below 768 px.
- **Render** — hosting from the `render.yaml` blueprint with a readiness health check and a Deploy to Render button.
- **Postman** — the judge path as a collection: a read-only folder safe for the Collection Runner (tests on every request, `planId` captured, PayPal reconciliation, initialize, tools/list and five MCP tool calls including `check_payout_plan` catching an attacker address) and a separate folder for requests that change state or send sandbox money (`docs/postman/`).
- **Leaflet / OpenStreetMap** — map.

## 7. Try it out links

- Live demo: https://firstlight.onrender.com
- Code: https://github.com/OR-6/firstlight
- Video: `[YOUTUBE URL]`

---

## 8. Demo video script (about 2:40 with cards, hard limit 3:00)

The full production plan is in [docs/VIDEO_PLAN.md](docs/VIDEO_PLAN.md) (shot list, capture commands, edit, upload) and the script to read is in [docs/VOICEOVER.md](docs/VOICEOVER.md), which holds the block times. One story:

1. **0:00** Cold open on one woman's PayPal account receiving $120 with a Spanish note; the problem (Nepal 2015: two months) and who it's for.
2. **0:18** A synthetic household in Chitré, enrolled in August; the M7.7 quake; two agencies agree; the AI agent drafts seven payouts under pre-agreed rules and flags two towns for a person.
3. **0:42** Ceilings and a floor: the firewall's working for that household, and the fixed Spanish note the agent can't change.
4. **1:02** A person approves $680; PayPal Payouts pays within half a minute; the same transaction id on Payouts and in her PayPal account.
5. **1:24** The scripted hijacked agent: $0.00 to anyone not owed; what it can still try; the insider swap we don't stop.
6. **1:52** An AI agent asks for $50 and is refused, then $5 is approved by a person on PayPal; the receipt is confirmed by PayPal itself.
7. **2:10** The audit chain verifies, a tampered copy breaks, recorded batches match PayPal; "The model proposes; the code disposes."

---

## 9. Judging criteria → what proves it

The five criteria are equally weighted; stage one is pass/fail on theme and PayPal usage.

| Criterion | Evidence to make visible |
|---|---|
| Technological Implementation | Payouts (idempotent) + Orders + signature-verified Webhooks; agent with schema-validated tools; firewall R1–R10 and R12, audit rule R11; compromised-agent test; hash-chained audit; 480+ tests |
| Design | Road-sign visual system (DESIGN.md), rule-trace drawer, map with payout bands, How it works page for every audience |
| Potential Impact | Cash to enrolled families minutes after a quake, no application; safe autonomy for agents that move money (How it works page) |
| Innovation / Idea | Capability restriction instead of detection; red-team console anyone can attack; agent-to-agent donations with receipts a donor agent can verify |
| Presentation | Tight 2:50 video showing real sandbox money moving plus a live attack |

## 10. Prize targeting (a project can win one grand prize or honorable mention, plus one sponsor prize)

- **Most Impactful** — the relief story.
- **Best Use of Agentic Commerce** — the firewall for agent payments, plus agent-to-agent donations where other agents discover Firstlight and fund it (PayPal's own resources list agent-to-agent commerce as an inspiration category).
- **Most Creative** — the Red Team console.
- **Best Use of PayPal + AI** — Payouts + Orders + Webhooks with a real agent.
- **Best Demo Delivery** — the video; spend real time on it.
- **Sponsor (only one can be won):** enter on all that fit naturally and collect whichever lands. AG Grid (tables; $5,000 top prize, five winners), APIMatic (use the Context Plugin while building; three winners at $1,000 plus a six-month Business subscription), Render (hosting; credits, not cash). Channel3 and Bryntum don't fit this project, so skip them. AG Grid's page rewards AG Studio polish, so plain Community tables are a long shot there; APIMatic is the most realistic sponsor prize, so show the Context Plugin in the README and the video. Tick AG Grid, APIMatic and Render on the form either way.

---

## 11. Submission-day checklist

**Wednesday night**
- [ ] Hosted demo up and warmed; webhook registered on the sandbox app; a full replay run succeeds from a fresh browser/incognito.
- [ ] Repo public, `LICENSE` (MIT) shows in the About section, README complete (security model, quickstart, env table, limitations, judge access).
- [ ] No secrets in git history (scan). Sandbox credentials for judges are sandbox-only.
- [ ] The Samaritan demo agent runs against the hosted site; `/.well-known/firstlight.json` and the `/mcp` endpoint respond.
- [ ] `npm run redteam` result pasted into README and numbers in this document updated.
- [ ] Video recorded, < 3:00, uploaded **public** to YouTube, plays logged-out.

**Thursday (submit by 12:00 Amsterdam; absolute limit 21:00)**
- [ ] Devpost: name, tagline, description, built-with, tools-used, links, video, repo.
- [ ] Open the repo and the demo in a private window and confirm the video link works.
- [ ] Submit. Screenshot the confirmation.
- [ ] Keep the hosted demo running until winners are announced on **Dec 21, 2026**, and don't change the repo, video or demo after submitting. `render.yaml` auto-deploys every push to `main`, so freeze `main` (or turn off auto-deploy) at submission. Rotate the sandbox secret afterwards.

**Rules that disqualify (re-read before submitting)**
- No working demo or run instructions · no public repo/license · missing or > 3 min or non-public video · video doesn't show it running · project doesn't run as shown · PayPal not central · pre-existing project without significant update · non-English materials · testing not free through judging.

**If you win:** winners complete prize affidavits and identity/eligibility checks, and are responsible for their own taxes and transfer fees.

---

## 12. Placeholders to fill

Filled in on 2026-11-08 from measured results. Still to fill: `[YOUTUBE URL]`.
