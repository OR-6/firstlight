# Firstlight

**Disaster-relief cash, sent by an AI agent that can't be talked into paying the wrong person.**

> **SANDBOX ONLY: no real money moves.** Every payment goes through the PayPal sandbox. All recipients are synthetic test accounts.

After a major earthquake, people need cash first and it arrives last. Firstlight lets an AI agent read the earthquake data, decide whether relief should go out, choose who gets which tier and write to each person in their language. Then a deterministic **payment firewall** checks the plan, computes every amount itself, sends anything unusual to a human, and only then does PayPal Payouts send money. Donors, both people and other AI agents, fund the pool through PayPal Checkout. Built for the PayPal AI Hackathon.

- **Try it:** https://firstlight.onrender.com (replay mode, no keys needed; PayPal sandbox)
- **Video:** _added after recording_
- Spec: [SPEC.md](SPEC.md) · decisions: [docs/decisions.md](docs/decisions.md) · design: [DESIGN.md](DESIGN.md) · [docs/SECURITY.md](docs/SECURITY.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Security model: capability restriction beats detection

The agent's output schema has **no field for an email, an amount, a currency or an account**. It can refer to people only by registry ids it was shown, and choose a tier (A, B or C). An injected instruction has nowhere to put an attacker's address.

Then the firewall (pure functions, no I/O, no LLM) re-checks everything:

| Rule | Checks |
|---|---|
| R1 | Recipient is registered, verified, and signed up ≥ 72 h before the quake |
| R2 | Tier allowed by distance from the epicentre (one tier up for a vulnerability flag); none beyond 300 km |
| R3 | Amount comes from the tier table, never from the agent |
| R4 | Per-person limits per event and over 90 days |
| R5 | Event budget against the pool and the event cap |
| R6 | One payout per person per disaster (including the same quake under another id); idempotent PayPal requests |
| R7 | Payout rate limit and kill switch |
| R8 | Earthquake confirmed by two independent sources (USGS + EMSC) and over threshold |
| R9 | Plan integrity: malformed plans, unknown fields, injection flags, exception requests, unsafe notes |
| R10 | A human approves anything over $300 or with any warning |
| R11 | Every verdict is in the hash-chained audit log before anything acts on it |

A sentinel (pattern checks plus a Claude Haiku classifier) scans untrusted text and the agent's output. It is advisory: a flag forces human review, but the guarantee is the schema plus the firewall.

### Red-team results

`npm run redteam -- --llm replay`: 27 prompt-injection payloads (direct, hidden in news, fake system messages, smuggled JSON, base64/ROT13, five languages, look-alike characters, instructions split across sources). The agent is replaced by a script that **obeys every instruction**, and a careless reviewer approves whatever reaches them.

| | Result |
|---|---|
| Sentinel pattern checks | flagged 21 / 27 |
| Sentinel Claude Haiku | flagged 25 / 27 |
| Either sentinel layer | flagged 27 / 27 |
| **Firewall: attacks that moved $0 to unauthorised payees** | **27 / 27** |

With the real agent (Claude Opus 5.5, recorded run) and four poisoned news items, the agent submitted only the legitimate plan and named all four attacks for the reviewer.

**Tests:** 336 (`npm test`), including table-driven firewall cases for every rule boundary, a 3,000-plan compromised-agent fuzz test, an end-to-end compromised-agent test asserting what PayPal was actually asked to pay, audit tamper detection, webhook signature failures, and donor-side injection, XSS and replay cases.

## What's real

- **Earthquake:** USGS `us6000u18k`, M7.7 Panama, 2026-10-09, PAGER orange, confirmed by EMSC. Copies of the real USGS and EMSC responses are in `fixtures/events/`.
- **Agent:** Claude Opus 5.5 with tool use. Replay mode serves recorded responses keyed by a hash of the full request; `npm run record:fixtures` records new ones.
- **PayPal (sandbox):** Payouts (real batches, idempotent), Orders v2 for donations (PayPal Server SDK, built with the APIMatic Context Plugin), verified webhooks, and polling as a fallback.

## Quickstart

```bash
git clone https://github.com/OR-6/firstlight && cd firstlight
cp .env.example .env          # add your PayPal SANDBOX app credentials
cp config/payees.sandbox.example.json config/payees.sandbox.json   # your sandbox personal accounts
npm i
npm run dev                   # http://localhost:3000, replay mode, no Anthropic key needed
```

Your sandbox app must be linked to a **US** sandbox business account; others can return `PAYOUT_NOT_AVAILABLE`.

| Command | What it does |
|---|---|
| `npm test` | All tests |
| `npm run redteam -- --llm replay` | Attack suite; writes `redteam-report.json` |
| `npm run fl -- assess` / `approve` / `execute` / `audit` | The loop from the command line |
| `npm run samaritan` | Demo donor agent: finds Firstlight via its manifest, donates over MCP, waits for a person to approve on PayPal |
| `npm run paypal:check` | Verify sandbox credentials (no money moves) |
| `npm run smoke:payout -- --send` | $1.00 sandbox payout to `PAYPAL_SMOKE_RECEIVER` |
| `npm run webhook:register -- https://…` | Register the webhook on the sandbox app |
| `npm run record:fixtures` | Re-record the Claude run (needs `ANTHROPIC_API_KEY`) |
| `npm run fetch:usgs` | Live USGS feed, read-only |

## Environment

| Variable | Purpose |
|---|---|
| `PAYPAL_ENV` | Must be `sandbox`; anything else refuses to start |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Sandbox app credentials (read only by `src/paypal`) |
| `PAYPAL_WEBHOOK_ID` | From `npm run webhook:register`; webhooks are refused without it |
| `APP_BASE_URL` | Public URL (PayPal return links, manifest) |
| `PAYEES_JSON` or `config/payees.sandbox.json` | recipientId → sandbox email; read only by the payout executor |
| `DEMO_MODE` | `replay` (default) or `live` |
| `ANTHROPIC_API_KEY`, `LLM_MODEL` | Live mode and recording only |
| `TIER_A_USD`, `TIER_B_USD`, `TIER_C_USD`, `PER_RECIPIENT_CAP_USD`, `EVENT_CAP_USD`, `APPROVAL_THRESHOLD_USD` | Firewall policy |
| `EXECUTE_LIMIT_PER_HOUR` | Public-demo cap on real sandbox payout batches |
| `FIRSTLIGHT_DB` | SQLite path (default `data/firstlight.db`) |

## For other agents

- Manifest: `/.well-known/firstlight.json`, summary: `/llms.txt`
- MCP (Streamable HTTP): `/mcp` with `get_pool_status`, `list_active_events`, `create_donation`, `get_receipt`
- A donor agent can only create a PayPal order. **A person approves it on PayPal**; nothing is charged otherwise. Receipts carry audit-log hashes the donor can verify at `/api/audit/verify?upTo=<hash>`.

## Judge access

The hosted demo runs in replay mode with sandbox credentials held server-side. Use "Reset demo" on Mission control to start over. Payout batches are capped per hour. On Render's free tier the first request after idling can take about a minute.

## Limitations and honest scope

- Sandbox only; no real money moves. Recipients and their homes are synthetic.
- The map rings are the firewall's payout bands, not measured shaking intensity.
- A real deployment would need identity verification, sanctions screening and a licensed disbursement partner.
- Collecting and redistributing public donations is regulated. A real deployment would route donations through a registered charity or licensed partner. **Do not use this prototype to solicit real money.**
- The hosted demo's database resets when the server restarts.

## License

[MIT](LICENSE)
