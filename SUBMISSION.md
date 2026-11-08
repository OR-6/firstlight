# Firstlight — Submission Kit (PayPal AI Hackathon)

Everything you need to paste into Devpost, plus the video script and a final checklist. Fill the `[BRACKETS]` once the build is done; don't claim numbers you haven't measured.

**Deadline: Thu 12 Nov 2026, 12:00 PT = 21:00 Amsterdam. Target: submit by Thu 12:00 Amsterdam.**

---

## 1. Project name

**Firstlight** (recommended).

Alternates if it's taken or you want a different feel: **Tripline** (trigger + guardrail), **Aegis Relief** (shield). Check the name isn't already used by a notable product before you commit.

## 2. Tagline (Devpost limit is short — this one is 57 characters)

> Disaster cash in minutes, guarded by an AI-proof firewall

## 3. Elevator pitch (short description, ~280 characters)

> Firstlight is an AI agent that watches for earthquakes and sends relief cash through PayPal Payouts within minutes — but every payment must pass a deterministic firewall. Even a fully hijacked agent can't pay an unregistered person, change amounts, or blow the budget.

---

## 4. Project story (paste into the Devpost sections)

### Inspiration
When a major disaster hits, people need cash first, for transport, medicine, somewhere to sleep, and it is the slowest thing to arrive. Programs that pay automatically when a measurable trigger is met (parametric payouts) exist to fix the speed problem. The obvious next step is an AI agent that watches the signals, makes the call, and pays. But nobody should give a language model a payout button: one poisoned news snippet could redirect the money. We wanted to build the version you could actually trust, where the safety comes from the architecture and not from hoping the model behaves.

### What it does
- Watches live USGS earthquake data and cross-checks it against a second source.
- An AI agent assesses whether the trigger is genuinely met, explains its reasoning, assigns each registered recipient a payout tier using distance and vulnerability notes, and writes each notification in the recipient's own language.
- Every plan then passes through the **Firstlight Firewall**: deterministic code that recomputes eligibility, computes the amounts itself, enforces per-person and per-event caps, blocks duplicates, and sends anything unusual to a human for approval.
- Approved plans go out as a **PayPal Payouts** batch; **PayPal webhooks** drive live status on the dashboard. Donors, both people and **other AI agents**, fund the relief pool through **PayPal Checkout**. Agents discover Firstlight through a machine-readable manifest and an MCP endpoint, a human approves the payment on PayPal, and the donor agent gets a receipt it can verify against the audit log.
- A built-in **Red Team console** lets anyone attack it: poisoned news items, a fully compromised agent, spoofed duplicate events, late-registered attackers, over-budget plans.

### How we built it
- **Capability restriction instead of detection.** The agent can only reference registry IDs and tiers. Its output schema has no email field, no amount field, and no way to name a new payee, so an injection has nowhere to put an attacker. A sentinel classifier adds a second layer, but the guarantee comes from the schema and the firewall.
- **The agent never holds credentials.** Only the PayPal client module does, and it only acts on firewall-approved plans.
- **Next.js + TypeScript**, SQLite, AG Grid dashboards, Leaflet map, hosted on Render.
- **PayPal:** Payouts API (idempotent batches via `PayPal-Request-Id`), Orders v2 for donations, signature-verified webhooks.
- **AI:** Claude-powered agent with read-only tools and schema-validated output, plus a sentinel pass. Developed with Claude Code.
- **Tamper-evident audit log:** hash-chained, with a one-click verify.
- **Replay mode** serves recorded agent runs so anyone can test the full flow, with real sandbox payouts, without API keys.

### Challenges we ran into
- Designing for a *compromised* agent rather than a well-behaved one, so the test harness uses an agent stub that obeys every injected instruction.
- PayPal batch webhooks don't carry item detail, so status has to be reconciled by following the links back to the batch.
- Making a live demo deterministic: recorded LLM fixtures, real USGS data, real sandbox payouts.

### Accomplishments we're proud of
- A red-team suite of [N] attack payloads. Result: [X]% flagged by the sentinel, and **[N]/[N] blocked by the firewall with $0 reaching an unauthorised payee**, even with the agent fully compromised. *(Only claim this if `npm run redteam` shows it.)*
- [N] firewall unit tests covering every rule boundary.
- End-to-end real sandbox payout, from earthquake to recipient balance, in [T] seconds.

### What we learned
For AI agents that move money, "make the model safer" is the wrong place to put the guarantee. The model should propose; deterministic code should dispose. Limiting what the agent can *express* does more than trying to detect what it was told.

### What's next
- More hazards (floods, cyclones, heat) through adapters that feed the same firewall.
- Real intensity data (USGS ShakeMap) for finer eligibility zones.
- Packaging the firewall as an MCP server so any agent can route PayPal payments through it.
- Working with licensed disbursement partners and local aid organisations. A real deployment needs identity verification and sanctions screening, which a hackathon sandbox can't demonstrate.

### Limitations (also in the README)
Firstlight runs entirely in the PayPal **sandbox**; no real money moves. All recipients are synthetic test accounts with invented locations. It is a prototype, not a financial product. Collecting and redistributing donations is regulated, so a real deployment would route funds through a registered charity or licensed partner rather than holding them itself.

---

## 5. Built with (tags)

`typescript` `nextjs` `react` `nodejs` `sqlite` `tailwindcss` `paypal` `paypal-payouts-api` `paypal-orders-api` `paypal-webhooks` `claude` `anthropic-api` `claude-code` `model-context-protocol` `ag-grid` `apimatic` `leaflet` `usgs-earthquake-api` `render` `zod` `vitest`

(Remove any you don't end up using. Add `emsc` if the second source works.)

## 6. Tools used and how (the form asks for this)

- **Claude Code** — used to build the application, tests and docs.
- **Claude (Anthropic API)** — the runtime agent (event assessment, tiering, multilingual notes) and the injection sentinel. *(Edit if you use a different model.)*
- **PayPal Payouts API** — relief disbursement; **Orders v2 / Checkout** — donations; **Webhooks** — live payout status; **PayPal sandbox** — all testing.
- **USGS Earthquake Hazards API** — real-time and historical event data (+ [second source] for corroboration).
- **APIMatic Context Plugin for PayPal** — gave Claude Code the PayPal API context while we built the integration.
- **AG Grid** — plan and payout tables. **Render** — hosting.
- **Leaflet / OpenStreetMap** — map.

## 7. Try it out links (placeholders)

- Live demo: `[RENDER URL]`
- Code: `[GITHUB URL]`
- Video: `[YOUTUBE URL]`

---

## 8. Demo video script (aim for 2:50–2:55, hard limit 3:00; trim narration if over)

Rules: public on YouTube, under 3 minutes, shows the project running, **no music, no copyrighted material**. Voiceover only (record audio separately, clean it, add captions). Screen-record at 1080p. Warm the Render instance first so there's no cold start in the footage. Avoid showing logos other than the PayPal sandbox screens you need.

| Time | On screen | Voiceover |
|---|---|---|
| 0:00–0:15 | Title card "Firstlight", then the Mission Control screen with the SANDBOX badge | "After a disaster, people need cash first, and it arrives last. An AI agent could change that, if you could trust it with a payout button. Firstlight is how." |
| 0:15–0:45 | Click **Replay** on `[REAL PAST EARTHQUAKE]`. Event card appears with magnitude, PAGER, second-source confirmation. Agent panel streams its assessment | "We replay a real USGS earthquake. Firstlight cross-checks a second source, and the agent decides whether the trigger is genuinely met and explains why, including what it's unsure about." |
| 0:45–1:20 | Plan table (AG Grid): tiers, amounts, verdict chips. Open one row's **rule-trace drawer**. Show localized notes | "The agent proposes tiers using distance and vulnerability. It can't set amounts and can't name a payee. The firewall recomputes everything and shows its working, rule by rule." |
| 1:20–1:50 | Approval queue → Approve. Payouts screen flips PENDING → SUCCEEDED live. **Split-screen:** a recipient's real PayPal sandbox balance increasing | "One approval, and a PayPal Payouts batch goes out. Webhooks update status live, and here's the money arriving in a recipient's sandbox account." |
| 1:50–2:25 | Red Team console. Inject the poisoned news item. Toggle **Compromised agent**. Show the agent trying to pay `attacker@…` $5,000. Rule hits light up red; "$0 to unauthorised payees". Show `[N]/[N] attacks blocked` and the audit-chain Verify | "Now we attack it. A poisoned news item tells the agent to send five thousand dollars to a stranger. We even force the agent to obey. It can't. There's no field to put the attacker in, and the firewall blocks it anyway. [N] of [N] attacks in our suite, zero dollars lost." |
| 2:25–2:48 | A second agent, "Samaritan", reads Firstlight's manifest, sees the active relief event, and creates a $5 donation within its human-set allowance. Approve it on the PayPal sandbox page; the pool meter ticks up; the agent fetches a receipt and verifies it against the audit log | "Other agents can fund it too. Samaritan finds Firstlight, offers five dollars within its owner's allowance, and a human approves it on PayPal. The receipt ties back to the audit log, so the donor can verify where the money went." |
| 2:48–2:55 | Closing card: name, tagline, repo and demo URL | "Firstlight. Let the agent act, because it can't act against you. Built with Claude Code and PayPal." |

Recording tips:
- Do one dry run per scene; cut dead time (loading spinners, typing).
- Keep the cursor slow and deliberate; zoom into the rule drawer and the split-screen.
- If a payout is slow in the sandbox, pre-trigger it and cut.
- Upload as **Public** (not Unlisted/Private), add captions, paste the link in the Devpost form.

---

## 9. Judging criteria → what proves it

The five criteria are equally weighted; stage one is pass/fail on theme and PayPal usage.

| Criterion | Evidence to make visible |
|---|---|
| Technological Implementation | Payouts (idempotent) + Orders + signature-verified Webhooks; agent with schema-validated tools; 11-rule firewall; compromised-agent test; hash-chained audit; `[N]` tests |
| Design | Ops-console UI, rule-trace drawer, SANDBOX badge, consistent visual system, map |
| Potential Impact | Faster cash after disasters; safe autonomy for agents that move money (README "Why this matters") |
| Innovation / Idea | Capability restriction instead of detection; red-team console anyone can attack; agent-to-agent donations with receipts a donor agent can verify |
| Presentation | Tight 2:50 video showing real sandbox money moving plus a live attack |

## 10. Prize targeting (a project can win one grand prize or honorable mention, plus one sponsor prize)

- **Most Impactful** — the relief story.
- **Best Use of Agentic Commerce** — the firewall for agent payments, plus agent-to-agent donations where other agents discover Firstlight and fund it (PayPal's own resources list agent-to-agent commerce as an inspiration category).
- **Most Creative** — the Red Team console.
- **Best Use of PayPal + AI** — Payouts + Orders + Webhooks with a real agent.
- **Best Demo Delivery** — the video; spend real time on it.
- **Sponsor (only one can be won):** enter on all that fit naturally and collect whichever lands. AG Grid (tables; $5,000 top prize, five winners), APIMatic (use the Context Plugin while building; three winners at $1,000 plus a six-month Business subscription), Render (hosting; credits, not cash). Channel3 and Bryntum don't fit this project, so skip them. Read each sponsor page on the Devpost site for criteria; I couldn't read AG Grid's.

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
- [ ] Keep the hosted demo running through **Dec 15, 2026** (judging ends); winners announced around Dec 21. Rotate the sandbox secret afterwards.

**Rules that disqualify (re-read before submitting)**
- No working demo or run instructions · no public repo/license · missing or > 3 min or non-public video · video doesn't show it running · project doesn't run as shown · PayPal not central · pre-existing project without significant update · non-English materials · testing not free through judging.

**If you win:** winners complete prize affidavits and identity/eligibility checks, and are responsible for their own taxes and transfer fees.

---

## 12. Placeholders to fill

`[N]` attack count · `[X]%` sentinel catch rate · `[N] tests` · `[T] seconds` end-to-end · `[REAL PAST EARTHQUAKE]` event name/ID · `[RENDER URL]` · `[GITHUB URL]` · `[YOUTUBE URL]` · `[second source]`.
