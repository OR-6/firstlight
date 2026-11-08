# Architecture

```
 USGS feed / replay ──┐
 EMSC (second source) ┼─► signals ─► event store
 USGS narrative text ─┘                │
                                        ▼
 registry (ids, homes, flags) ──► AGENT (Claude, read-only tools) ── plan: ids + tiers only
                                        │
                     sentinel (patterns + Claude Haiku), advisory
                                        ▼
                                FIREWALL (pure, R1–R10)
                                        │ verdict (logged: R11)
                          ALLOW ────────┤──── REQUIRE_APPROVAL ─► human approves
                                        ▼
                     executor: re-check ledger, map ids → sandbox emails
                                        ▼
                       PayPal Payouts (sandbox) ◄── webhooks / 2 s polling
 donors (people, agents) ─► Orders v2 ─► human approves on PayPal ─► capture ─► pool ledger
                 hash-chained audit log records every step
```

## Code map

| Path | Role |
|---|---|
| `src/firewall/` | Pure rules R1–R10, plan schema, engine. No I/O |
| `src/agent/` | Tool definitions, prompt, loop (max 6 turns, one repair), sentinel |
| `src/llm/` | `LlmClient`: live, record, replay, scripted |
| `src/signals/` | USGS feed/FDSN, EMSC corroboration, untrusted text, replay bundles |
| `src/registry/` | Public profiles; payee map (executor only) |
| `src/pipeline/` | assess → approve → execute → poll; webhook handling |
| `src/ledger/` | SQLite schema, pool ledger, hash-chained audit log |
| `src/paypal/` | The only code with credentials: OAuth, Payouts (fetch), Orders (SDK), webhook verification |
| `src/donations/` | Donation policy (pure) and service |
| `src/agentapi/` | Manifest, llms.txt, MCP server for donor agents |
| `src/redteam/` | Corpus harness, console scenarios, simulated PayPal |
| `src/app/`, `src/ui/` | Next.js dashboard and API routes |
| `scripts/` | CLI, red-team report, Samaritan donor agent, smoke tests, webhook registration |

## Data

SQLite (`better-sqlite3`), created on boot: `events`, `plans`, `verdicts`, `approvals`, `payout_batches`, `payout_items`, `ledger_entries`, `donations`, `webhook_events`, `audit_log`, `meta`.
