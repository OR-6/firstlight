# Firstlight

> **SANDBOX ONLY: no real money moves.** All recipients are synthetic.

Disaster-relief cash payouts proposed by an AI agent and gated by a deterministic payment firewall the agent can't talk its way past. Built for the PayPal AI Hackathon. The full spec is in [SPEC.md](SPEC.md). Policy choices not covered by the spec are in [docs/decisions.md](docs/decisions.md).

**Status: Milestone 2 (the loop) done.** A Claude agent assesses a real USGS earthquake, a deterministic firewall checks its plan, a human approves, and a real PayPal sandbox Payouts batch goes out. Replay mode reproduces the recorded agent run with no API key. Dashboard comes in M3.

```bash
npm i
npm test           # firewall (table-driven + compromised-agent fuzz), ledger, audit, USGS, PayPal client
npm run typecheck
npm run fetch:usgs # live USGS feed, read-only

cp .env.example .env   # sandbox credentials; the sender must be a US sandbox business account
npm run paypal:check               # token + Payouts scope, no money moves
npm run smoke:payout -- --send     # $1.00 sandbox payout to PAYPAL_SMOKE_RECEIVER

# The loop (state in data/firstlight.db). Replay mode needs no Anthropic key.
cp config/payees.sandbox.example.json config/payees.sandbox.json   # your sandbox personal accounts
npm run fl -- assess                      # agent → sentinel → firewall (replays recorded Claude run)
npm run fl -- assess --redteam            # same, with poisoned news injected
npm run fl -- approve 1 --by you --reason "checked"
npm run fl -- execute 1                   # real PayPal sandbox batch, polled to completion
npm run fl -- audit                       # verify the hash chain
npm run record:fixtures                   # re-record the Claude run (needs ANTHROPIC_API_KEY)
```

License: [MIT](LICENSE).
