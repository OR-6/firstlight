# Firstlight

> **SANDBOX ONLY: no real money moves.** All recipients are synthetic.

Disaster-relief cash payouts proposed by an AI agent and gated by a deterministic payment firewall the agent can't talk its way past. Built for the PayPal AI Hackathon. The full spec is in [SPEC.md](SPEC.md). Policy choices not covered by the spec are in [docs/decisions.md](docs/decisions.md).

**Status: Milestone 1 (foundations).** Done: firewall, ledger, audit chain, USGS ingestion. No PayPal or LLM integration yet.

```bash
npm i
npm test           # firewall (table-driven + compromised-agent fuzz), ledger, audit, USGS
npm run typecheck
npm run fetch:usgs # live USGS feed, read-only
```

License: [MIT](LICENSE).
