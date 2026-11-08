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

## 3. Elevator pitch (short description, ~280 characters)

> When two seismic agencies confirm a strong earthquake near families an aid organisation already enrolled, a Claude agent drafts relief payouts within minutes and nobody has to apply. A deterministic firewall checks every payment before PayPal Payouts sends it, so even a hijacked agent can't change who is paid, how much, or what they're told.

---

## 4. Project story (paste into the Devpost sections)

### Inspiration
Cash that arrives early does more good than the same cash later. When WFP sent cash to Bangladeshi households about four days before the 2020 flood peak, some 100 days earlier than its 2019 response, those households were 36% less likely to go a day without eating (WFP / Centre for Disaster Protection review). Earthquakes can't be forecast, so the fastest honest version is to pay households an aid organisation enrolled *before* the quake, within minutes of it being confirmed. Most relief funds still wait for applications.

An AI agent could make that call in minutes. But nobody should hand a language model a payout button: one poisoned news item could redirect the money. We wanted the version a cash-programme lead at a Red Cross national society or a cash NGO could actually trust, where the safety comes from the architecture, not from hoping the model behaves.

### What it does
- **For aid organisations that run cash programmes.** Households are enrolled through field partners before a disaster. When a strong quake is confirmed near them, nobody has to apply.
- **Real earthquake data.** USGS, cross-checked against a second agency (EMSC). The hosted demo replays the real M7.7 Panama earthquake of 9 October 2026 so every run is reproducible; `npm run fetch:usgs` reads the live feeds.
- **A Claude agent drafts the plan.** It decides whether the trigger is genuinely met, explains why, assigns each enrolled household a tier by distance with one tier up for a vulnerability, and flags anything a person should look at.
- **A deterministic payment firewall decides.** It recomputes eligibility and every amount itself, enforces per-person and per-event caps, blocks duplicates of the same disaster, and checks the opposite direction too: a plan that leaves an eligible household out or pays one too little goes to a person (rule R12).
- **PayPal pays.** Approved plans go out as one **PayPal Payouts** batch; signature-verified **webhooks** drive live status. Recipients get a fixed, pre-translated note with a help line: the agent can't write to them, so it can't phish them.
- **People and other AI agents fund the pool** through **PayPal Orders v2**. An agent donates over **MCP**, but only within an allowance a person set (who, how much, until when), a person approves each payment on PayPal, and the agent checks its receipt against the hash-chained audit log itself.
- **A Red Team console anyone can run**: 27 injection attacks against an agent that obeys every one, plus six attacks that don't try to pay a stranger, shown with their real outcome, including the one we don't stop.

### How we built it
- **Capability restriction instead of detection.** The agent can only name registry ids and tiers. Its output has no field for an email, an amount or an account, and its notes are never sent. An injection has nowhere to put an attacker. A sentinel (patterns plus Claude Haiku) adds a second, advisory layer.
- **The agent never holds credentials.** Only the PayPal module does, and it only acts on verdicts that are in the audit log, after re-running the firewall against the ledger as it is at that moment.
- **PayPal:** Payouts (idempotent batches via `PayPal-Request-Id`, unknown outcomes resent safely), Orders v2 through the PayPal Server SDK, webhooks verified with PayPal's signature API, refunds and reversals booked against the pool.
- **APIMatic Context Plugin:** gave Claude Code the PayPal Server SDK's endpoints and models while we built the Orders integration (create, capture, payer-action link, request ids).
- **AI:** Claude Opus 5.5 is the agent (strict tool schemas, read-only tools, one repair turn); Claude Haiku 5.5 is the sentinel. Built with Claude Code.
- **Stack:** Next.js and TypeScript, SQLite, AG Grid, Leaflet, hosted on Render. A pure firewall (no I/O, no clock, no LLM), tested by import-graph checks.
- **Replay mode** serves the recorded Claude run, so anyone can try the whole flow, with real sandbox payouts, without API keys.

### Challenges we ran into
- Designing for a *compromised* agent, not a well-behaved one: the test harness swaps in a script that obeys every injected instruction, and a reviewer who approves everything.
- Our own review found that capping what the agent can pay isn't enough: a hijacked agent could still quietly pay people less, leave them out, or phish them through the payout note. We added a floor rule and fixed notes, and we list what remains.
- PayPal batch webhooks don't carry item detail, so status is reconciled by fetching the batch; a failed webhook is processed on PayPal's retry instead of being dropped as a duplicate.

### Accomplishments we're proud of
- **$0 to anyone not owed in 27 of 27 attacks**, judged against a hand-written table of what each household is owed. Every attack is also held by a firewall rule other than the $300 approval limit, and agent-written text reached PayPal in none. (`npm run redteam -- --llm replay`; the sentinel flagged 22/27 by patterns, 25/27 by Claude Haiku, 27/27 either way.)
- Real sandbox payouts: about 30 seconds from sending the batch to $680 landing in seven households' sandbox accounts.
- An honest residual-risk table: paying less or leaving people out goes to a person; an insider swapping a payee address is not stopped, and we say so on the page.
- Table-driven tests for every firewall rule boundary, a property test over 3,000 generated compromised-agent plans, and end-to-end tests of what PayPal was actually asked to pay (`npm test`).

### What we learned
For AI agents that move money, "make the model safer" is the wrong place to put the guarantee. The model should propose; deterministic code should dispose. Limiting what the agent can *express* does more than trying to detect what it was told.

### What's next
- A pilot design with a cash-programme partner in Central America: transfer values set from the local minimum expenditure basket and household size, and delivery through whatever rail households have (PayPal, Venmo, or a licensed partner's cash-out).
- Data minimisation: the agent only needs to know a household qualifies for an uplift, not which condition it has.
- More hazards (floods, cyclones, heat) through adapters that feed the same firewall.
- Real intensity data (USGS ShakeMap) for finer eligibility zones.
- Packaging the firewall as an MCP server so any agent can route PayPal payments through it.
- Working with licensed disbursement partners and local aid organisations. A real deployment needs identity verification and sanctions screening, which a hackathon sandbox can't demonstrate.

### Limitations (also in the README)
Firstlight runs entirely in the PayPal **sandbox**; no real money moves. All recipients are synthetic test accounts with invented locations. It is a prototype, not a financial product. Collecting and redistributing donations is regulated, so a real deployment would route funds through a registered charity or licensed partner rather than holding them itself.

---

## 5. Built with (tags)

`paypal` `paypal-payouts-api` `paypal-orders-api` `paypal-webhooks` `paypal-server-sdk` `claude` `anthropic-api` `claude-code` `model-context-protocol` `apimatic` `ag-grid` `render` `typescript` `nextjs` `react` `nodejs` `sqlite` `tailwindcss` `leaflet` `usgs-earthquake-api` `emsc` `zod` `vitest`

## 6. Tools used and how (the form asks for this)

- **Claude Code** — used to build the application, tests and docs.
- **Claude (Anthropic API)** — Claude Opus 5.5 is the runtime agent (event assessment, tiering, multilingual notes); Claude Haiku 5.5 is the injection sentinel.
- **PayPal Payouts API** — relief disbursement; **Orders v2 / Checkout** — donations; **Webhooks** — live payout status; **PayPal sandbox** — all testing.
- **USGS Earthquake Hazards API** — real-time and historical event data (+ EMSC SeismicPortal for independent corroboration).
- **APIMatic Context Plugin for PayPal** — gave Claude Code the PayPal API context while we built the integration.
- **AG Grid** — plan and payout tables. **Render** — hosting.
- **Leaflet / OpenStreetMap** — map.

## 7. Try it out links

- Live demo: https://firstlight.onrender.com
- Code: https://github.com/OR-6/firstlight
- Video: `[YOUTUBE URL]`

---

## 8. Demo video script (about 2:35, hard limit 3:00)

Rules: public on YouTube, under 3 minutes, shows the project running, **no music, no copyrighted material**. Voiceover only (record audio separately, clean it, add captions). Screen-record at 1080p. Warm the Render instance first so there's no cold start in the footage. Avoid showing logos other than the PayPal sandbox screens you need.

The full production plan is in [docs/VIDEO_PLAN.md](docs/VIDEO_PLAN.md) (shot list, capture commands, edit, upload) and the script to read is in [docs/VOICEOVER.md](docs/VOICEOVER.md). In short, about 2:35, one story:

1. **0:00** Household 04 in Chitré was enrolled in August; a M7.7 quake hits.
2. **0:12** Two agencies agree; the Claude agent drafts seven households' payouts.
3. **0:35** The firewall's working for household 04, and the fixed Spanish note the agent can't change.
4. **1:00** A person approves $680; PayPal Payouts lands it in about 30 s, shown in a sandbox account.
5. **1:30** The hijacked-agent attack: $0.00 to anyone not owed. What it can still try, and the one thing we don't stop.
6. **2:00** An AI agent donates within a person's allowance; a person approves on PayPal; the receipt verifies.
7. **2:22** "The model proposes; the code disposes."

---

## 9. Judging criteria → what proves it

The five criteria are equally weighted; stage one is pass/fail on theme and PayPal usage.

| Criterion | Evidence to make visible |
|---|---|
| Technological Implementation | Payouts (idempotent) + Orders + signature-verified Webhooks; agent with schema-validated tools; firewall R1–R10 and R12, audit rule R11; compromised-agent test; hash-chained audit; 350 tests |
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
