# Firstlight

> **SANDBOX ONLY: no real money moves.** All recipients are synthetic.

Disaster-relief cash payouts proposed by an AI agent and gated by a deterministic payment firewall the agent can't talk its way past. Built for the PayPal AI Hackathon. The full spec is in [SPEC.md](SPEC.md). Policy choices not covered by the spec are in [docs/decisions.md](docs/decisions.md).

**Status: Milestone 1 (foundations) done.** Firewall, ledger, audit chain, USGS ingestion, and a PayPal sandbox client with a working $1 Payouts smoke test. No LLM integration yet.

```bash
npm i
npm test           # firewall (table-driven + compromised-agent fuzz), ledger, audit, USGS, PayPal client
npm run typecheck
npm run fetch:usgs # live USGS feed, read-only

cp .env.example .env   # sandbox credentials; the sender must be a US sandbox business account
npm run paypal:check               # token + Payouts scope, no money moves
npm run smoke:payout -- --send     # $1.00 sandbox payout to PAYPAL_SMOKE_RECEIVER
```

License: [MIT](LICENSE).
