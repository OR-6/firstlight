# Architecture

```
 USGS feed / replay ──┐
 EMSC (second source) ┼─► signals ─► event store
 USGS narrative text ─┘                │
                                        ▼
 registry (ids, homes, uplift yes/no) ─► AGENT (LLM, read-only tools) ── plan: ids + tiers only
                                        │
                     sentinel (patterns + classifier), advisory
                                        ▼
                     FIREWALL (pure: R1–R10 ceilings, R12 floor)
                                        │ verdict, written to the audit log first (R11)
               ALLOW ───────────────────┤──── REQUIRE_APPROVAL ─► a person approves
                                        │       (or: firewall's own floor plan, still a person)
                                        ▼
         executor: re-run firewall on today's ledger, reserve + debit in one transaction,
                   map ids → sandbox emails, PayPal-Request-Id from the verdict
                                        ▼
         PayPal Payouts (sandbox) ◄── verified webhooks / 2 s polling ──► reconcile vs PayPal's batch record
                                        │                                   (+ Transaction Search when scoped)
                                        ▼
                    fixed note in the household's language, naming the partner and help line

 donors: people (/donate) and AI agents (MCP, within a person's allowance)
   ─► Orders v2 ─► a person approves on PayPal ─► capture ─► pool ledger
   receipts confirmed with PayPal's hosted MCP (read-only get_order), audit hashes the donor can recompute

 other agents ─► MCP check_payout_plan ─► same pure firewall, dry run, nothing stored
 hash-chained audit log records every step
```

## Rules

| Rule | Where | Checks |
|---|---|---|
| R1–R10 | `src/firewall/rules/` | Registry and enrolment date, tier by distance band (scaled by magnitude), amount from the table, per-person and event caps, budget, duplicates of the same disaster, rate and kill switch, trigger confirmed by two agencies, plan integrity, when a person must approve |
| R11 | `src/pipeline/pipeline.ts`, `src/ledger/audit.ts` | Every verdict is in the hash-chained audit log before anything acts on it |
| R12 | `src/firewall/rules/r12-coverage.ts` | Nobody eligible left out or paid below their band, with the dollar shortfall; a hold on a confirmed quake isn't silent |

## Code map

| Path | Role |
|---|---|
| `src/firewall/` | Pure rules R1–R10 and R12, plan schema, engine, bands by magnitude, fixed payout notes, the floor plan. No I/O, clock, randomness or LLM (enforced by `tests/firewall.purity.test.ts`) |
| `src/agent/` | Tool definitions, prompt, loop (max 6 turns, one repair), sentinel |
| `src/llm/` | `LlmClient`: live, record, replay, scripted |
| `src/signals/` | USGS feed/FDSN, EMSC corroboration, untrusted text, replay bundles |
| `src/registry/` | Public profiles; payee map (executor only) |
| `src/pipeline/` | assess → approve → execute → poll; webhook handling; floor plan; dry run |
| `src/ledger/` | SQLite schema, integer-cents pool ledger (credits, debits, reversals, fees), hash-chained audit log |
| `src/paypal/` | The only code with credentials: OAuth, Payouts (REST), Orders (Server SDK), webhook verification, Transaction Search, reconciliation, PayPal's hosted MCP (read-only) |
| `src/donations/` | Donation policy (pure), allowances, payer binding, refunds, receipts |
| `src/agentapi/` | Manifest, llms.txt, MCP server (six tools incl. `check_payout_plan`) |
| `src/redteam/` | Corpus harness, residual risks, held-out sentinel set, simulated PayPal |
| `src/app/`, `src/ui/` | Next.js console and API routes |
| `scripts/` | CLI, red-team report, Samaritan donor agent, chain verifier, capture, smoke tests, webhook registration |
| `docs/postman/` | Postman collection of the public endpoints |

## Data

SQLite (`better-sqlite3`), created on boot: `events`, `plans`, `verdicts`, `approvals`, `payout_batches`, `payout_items`, `ledger_entries`, `donations`, `allowances`, `webhook_events`, `audit_log`, `meta`. On the hosted demo it lives in `/tmp` and resets on restart.
