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

> Relief cash to families enrolled before an earthquake, minutes after it's confirmed: no application. An AI agent drafts, a deterministic firewall checks, PayPal Payouts pays.

(176 characters. Longer version for places with room: "For aid organisations that run cash programmes. When two seismic agencies confirm a strong earthquake near families they enrolled beforehand, an AI agent drafts the payouts within minutes and nobody has to apply. A deterministic firewall checks every payment before PayPal Payouts sends it: a hijacked agent can't pay anyone who isn't owed, can't pay more than the tier table allows, and can't write a word to recipients. If it pays someone less or leaves them out, a person sees exactly who.")

---

## 4. Project story (paste into the Devpost sections)

### Inspiration
After an earthquake, relief cash usually comes weeks later, and mostly to people who manage to get registered. Anticipatory, parametric cash programmes move that work to before the disaster: households are enrolled in advance and paid when a pre-agreed trigger fires. Early cash works. When WFP sent cash to Bangladeshi households about four days before the 2020 flood peak, some 100 days earlier than its 2019 response, those households were 36% less likely to go a day without eating (WFP / Centre for Disaster Protection review). Earthquakes can't be forecast, so the fastest honest version is to pay households an aid organisation enrolled *before* the quake, within minutes of it being confirmed. Most earthquake responses still spend their first weeks registering and verifying people.

An AI agent could make that call in minutes. But nobody should hand a language model a payout button: one poisoned news item could redirect the money. We wanted the version a cash-programme lead at a Red Cross national society or a cash NGO could actually trust, where the safety comes from the architecture, not from hoping the model behaves.

### What it does
- **For the cash-programme lead at a Red Cross national society or a cash NGO.** Their field partners enrol households before a disaster; the firewall's settings are the programme's pre-agreed trigger and payment rules. In our sandbox run, $680 reached seven households about 25 seconds after the batch was sent (PayPal batch `9GE626X9SA3NE`), and nobody applied.
- **Real earthquake data.** USGS, cross-checked against a second agency (EMSC). The hosted demo replays the real M7.7 Panama earthquake of 9 October 2026 so every run is reproducible; `npm run fetch:usgs` reads the live feeds.
- **An AI agent drafts the plan.** It decides whether the trigger is genuinely met, explains why, assigns each enrolled household a tier by distance with one tier up for a vulnerability, and flags anything a person should look at.
- **A deterministic payment firewall decides.** It recomputes eligibility and every amount itself, enforces per-person and per-event caps, blocks duplicates of the same disaster, and checks the opposite direction too: a plan that leaves an eligible household out or pays one too little can't go out automatically; the reviewer is shown who, and how much they'd lose (rule R12).
- **PayPal pays.** Approved plans go out as one **PayPal Payouts** batch; signature-verified **webhooks** drive live status. Recipients get a fixed, pre-translated note: what the money is, that nothing is needed, to ask their local relief partner with questions, and that nobody will ask for a password, code or fee. The agent can't write to them, so it can't phish them.
- **People and other AI agents fund the pool** through **PayPal Orders v2**. Any MCP client can donate, but it can't spend on its own: each donation is an order a person approves on PayPal, inside an allowance (label, cap, expiry) the server enforces. Each allowance is tied to the one PayPal account that approves its first payment; anything approved by another account isn't captured. Every receipt is confirmed live with PayPal through PayPal's own hosted MCP server, carries the capture id the donor can match in their PayPal activity, and the agent recomputes the audit hash chain itself.
- **A Red Team page anyone can run**: 27 injection attacks against an agent we scripted to obey every one ($0.00 reached anyone not owed), and six quieter attacks (underpaying, leaving people out, phishing through the note, an insider swapping a payee) shown with their real outcome, including the one we don't stop.

### How we built it
- **Capability restriction instead of detection.** The agent can only name registry ids and tiers. Its output has no field for an email, an amount or an account, and its notes are never sent. An injection has nowhere to put an attacker. A sentinel (patterns plus a small classifier model) adds a second, advisory layer.
- **The agent never holds credentials.** Only the PayPal module does, and it only acts on verdicts that are in the audit log, after re-running the firewall against the ledger as it is at that moment.
- **PayPal Payouts:** one batch per approved plan. Its PayPal-Request-Id comes from the firewall verdict, so a retry can't pay twice; a timeout is resent under the same id; `sender_item_id` is event:household. Item statuses (SUCCESS, UNCLAIMED, RETURNED…) and PayPal's transaction ids and failure reasons are reconciled with a GET on every signature-verified webhook, with polling as a fallback.
- **PayPal Orders v2** through the PayPal Server SDK: captured on the return URL or on `CHECKOUT.ORDER.APPROVED` for donors who never come back. Pending or denied captures never credit the pool; refund and reversal webhooks debit it.
- **APIMatic Context Plugin:** gave our AI coding assistant the PayPal Server SDK's endpoints and models while we built the Orders integration (create, capture, payer-action link, request ids).
- **AI:** an LLM is the agent (strict tool schemas, read-only tools, one repair turn); a small classifier model is the advisory sentinel.
- **Stack:** Next.js and TypeScript, SQLite, AG Grid, Leaflet, hosted on Render. A pure firewall (no I/O, no clock, no LLM), tested by import-graph checks.
- **Design:** an operations console in the language of road signs (Overpass, guide-sign green, warning-yellow diamonds, red octagons). Status reads by shape as well as colour, and every household opens to a plain-English list of each firewall check.
- **Replay mode:** on the hosted demo the recorded agent run is replayed, so you can try the whole flow, including real sandbox payouts, without keys of your own. Locally, assessing and the red team need no keys; paying needs PayPal sandbox credentials.
- **Honest limits:** in the demo anyone can approve (no sign-in); a real deployment needs staff sign-in and two approvers above a threshold.

### Challenges we ran into
- Designing for a *compromised* agent, not a well-behaved one: the test harness swaps in a script that obeys every injected instruction, and a reviewer who approves everything.
- Our own review found that capping what the agent can pay isn't enough: a hijacked agent could still quietly pay people less, leave them out, or phish them through the payout note. We added a floor rule and fixed notes, and we list what remains.
- PayPal batch webhooks don't carry item detail, so status is reconciled by fetching the batch; a failed webhook is processed on PayPal's retry instead of being dropped as a duplicate.

### Accomplishments we're proud of
- **$0 to anyone not owed in 27 of 27 attacks** against an agent we scripted to obey every one, judged against a hand-written table of what each household is owed. Every attack is also held by a firewall rule other than the $300 approval limit, and agent-written text reached PayPal in none. The advisory sentinel (patterns plus a classifier model) flagged them too, but the guarantee doesn't depend on it.
- Real sandbox payouts: batch `9GE626X9SA3NE` paid $680 to seven sandbox accounts in about 25 seconds, confirmed by seven signature-verified `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` webhooks.
- Any MCP client can donate with no SDK: `tools/list` publishes the enforced limits, refusals come back as typed codes (`ALLOWANCE_UNKNOWN`, `ALLOWANCE_EXCEEDED`), and our example agent recomputes every audit hash itself.
- An honest residual-risk table: a reviewer who approves without reading would still let under-payment through (the page shows the dollar shortfall), and an insider swapping a payee address is not stopped. We say so on the page.
- Over 480 tests that run in about a second, including a seeded property test over 3,000 compromised-agent plans and an import-graph test that fails if the firewall ever reads the clock, environment, database, network or an LLM.

### What we learned
For AI agents that move money, "make the model safer" is the wrong place to put the guarantee. The model should propose; deterministic code should dispose. Limiting what the agent can *express* does more than trying to detect what it was told.

### What's next
- Allowances tied to a PayPal-verified account: the person who sets an agent's cap signs in with PayPal, and only that account can approve the agent's payments.
- The payout firewall as an MCP tool, so any agent can dry-run a PayPal Payouts batch against R1–R12 before it sends anything.
- Bands from USGS ShakeMap intensity at each home instead of distance alone, and enrolment on top of an existing government social registry (shock-responsive social protection).
- A pilot design with a cash-programme partner in Central America: transfer values set from the local minimum expenditure basket and household size, and delivery through whatever rail households have (PayPal, Venmo, or a licensed partner's cash-out).
- Data minimisation: the agent only needs to know a household qualifies for an uplift, not which condition it has.
- More hazards (floods, cyclones, heat) through adapters that feed the same firewall.
- Real intensity data (USGS ShakeMap) for finer eligibility zones.
- Working with licensed disbursement partners and local aid organisations. A real deployment needs identity verification and sanctions screening, which a hackathon sandbox can't demonstrate.

### Limitations (also in the README)
Firstlight runs entirely in the PayPal **sandbox**; no real money moves. All recipients are synthetic test accounts with invented locations. It is a prototype, not a financial product. Collecting and redistributing donations is regulated, so a real deployment would route funds through a registered charity or licensed partner rather than holding them itself.

---

## 5. Built with (tags)

`paypal` `paypal-payouts-api` `paypal-orders-api` `paypal-webhooks` `paypal-server-sdk` `ai-agents` `llm` `model-context-protocol` `apimatic` `ag-grid` `render` `typescript` `nextjs` `react` `nodejs` `sqlite` `tailwindcss` `leaflet` `usgs-earthquake-api` `emsc` `zod` `vitest`

## 6. Tools used and how (the form asks for this)

- **An LLM (via API)** — the runtime agent: it checks the trigger is met, assigns tiers and flags anything a person should see; it never writes what recipients receive. A small classifier model is the advisory injection sentinel.
- **PayPal Payouts API** — relief disbursement. **Orders v2** (PayPal Server SDK) — donations. **Webhooks** — payout batch and item status, plus donation capture, pending, denied, refund and reversal events, each checked with verify-webhook-signature and de-duplicated. **PayPal sandbox** — all testing. **PayPal's hosted MCP server** (sandbox, read-only `get_order` only) confirms every donation receipt live with PayPal, with the Server SDK as fallback; PayPal's toolkit has no Payouts call, so payouts use the REST API behind the firewall. **Transaction Search** (Server SDK) for the balance check and reconciliation when the app has the scope.
- **Model Context Protocol** — Firstlight runs a Streamable HTTP MCP server at `/mcp` (get_pool_status, list_active_events, get_allowance, create_donation, get_receipt) with strict input and output schemas, plus a `/.well-known/firstlight.json` manifest and `/llms.txt` so agents can find it.
- **USGS Earthquake Hazards API** — the recorded M7.7 Panama event (us6000u18k) the demo replays, plus a read-only live-feed script. **EMSC SeismicPortal** — independent corroboration.
- **APIMatic Context Plugin for PayPal** — gave our AI coding assistant the PayPal API context while we built the integration.
- **AG Grid** — plan and payout tables. **Render** — hosting.
- **Leaflet / OpenStreetMap** — map.

## 7. Try it out links

- Live demo: https://firstlight.onrender.com
- Code: https://github.com/OR-6/firstlight
- Video: `[YOUTUBE URL]`

---

## 8. Demo video script (about 2:38, hard limit 3:00)

The full production plan is in [docs/VIDEO_PLAN.md](docs/VIDEO_PLAN.md) (shot list, capture commands, edit, upload) and the script to read is in [docs/VOICEOVER.md](docs/VOICEOVER.md). One story:

1. **0:00** The problem (relief cash takes weeks and a form; early cash works) and who it's for.
2. **0:16** A synthetic household in Chitré, enrolled in August; the M7.7 quake; two agencies agree; the AI agent drafts seven payouts under pre-agreed rules.
3. **0:38** The firewall's working for that household, the R12 shortfall warning, and the fixed Spanish note the agent can't change.
4. **1:00** A person approves $680; PayPal Payouts lands it in about 25 s; the same batch id on Payouts and in her sandbox account.
5. **1:28** The scripted hijacked agent: $0.00 to anyone not owed; what it can still try (shortfall shown); the insider swap we don't stop.
6. **1:58** A real AI assistant donates over MCP, refused over its allowance, then approved by a person on PayPal; the receipt verifies.
7. **2:16** "$680, 7 households, ~25 s. 27 attacks, $0 redirected. The model proposes; the code disposes."

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
