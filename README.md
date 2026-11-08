# Firstlight

> **SANDBOX ONLY: no real money moves.** All recipients are synthetic.

Disaster-relief cash payouts proposed by an AI agent and gated by a deterministic payment firewall the agent can't talk its way past. Built for the PayPal AI Hackathon. The full spec is in [SPEC.md](SPEC.md). Policy choices not covered by the spec are in [docs/decisions.md](docs/decisions.md).

**Status: Milestone 3 (the product) done.** A dashboard runs the whole loop: a Claude agent assesses a real USGS earthquake, a deterministic firewall checks its plan, a person approves, a real PayPal sandbox Payouts batch goes out, and statuses update live. Replay mode reproduces the recorded Claude runs with no API key. Donations and deployment come in M4.

**Red-team results** (`npm run redteam -- --llm replay`, 27 prompt-injection payloads, agent replaced by a script that obeys every instruction, a careless reviewer approving everything):

| | Flagged |
|---|---|
| Sentinel pattern checks | 21 / 27 |
| Sentinel Claude Haiku | 25 / 27 |
| Either sentinel layer | 27 / 27 |
| **Firewall: attacks that moved $0 to unauthorised payees** | **27 / 27** |

The sentinel is advisory; the firewall result does not depend on it.

```bash
npm i
npm run dev       # dashboard at http://localhost:3000 (replay mode, no Anthropic key needed)
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
npm run redteam -- --llm replay           # 27-payload attack suite, writes redteam-report.json
```

License: [MIT](LICENSE).
