# Security model

Firstlight assumes the AI agent **can be fully compromised** and still guarantees that money only reaches pre-registered, eligible people, at fixed amounts, within budget. Everything below is enforced in code and covered by tests.

## Trust boundaries

| Component | Trusted with | Never sees |
|---|---|---|
| Agent (Claude Opus 5.5) | Event data, untrusted text (wrapped), registry ids, distances, flags, locales | Emails, amounts, ledger, PayPal, credentials |
| Sentinel (patterns + Claude Haiku) | Untrusted text and the agent's free text | Anything it could act on; advisory only |
| Firewall | Plan (parsed from `unknown`), event, corroboration, registry, ledger snapshot, config | I/O of any kind; it is pure |
| Payout executor | Firewall verdict, payee map, PayPal client | The agent |
| PayPal client (`src/paypal`) | Sandbox credentials | — |

Import boundaries are enforced by `tests/isolation.test.ts`; firewall purity by `tests/firewall.purity.test.ts`.

## Why an injection can't redirect money

1. **No place to put a payee.** `submit_plan` has no email, amount, currency or account field. Extra fields are ignored and force human review.
2. **Amounts are computed, not proposed.** The firewall derives the amount from the tier it allows (R2, R3).
3. **Identity is the registry.** Unknown, unverified or late-registered ids are blocked (R1). Look-alike ids don't match.
4. **The executor re-checks.** Before paying, it re-runs the firewall against the current ledger, refuses any verdict not in the audit log, and maps ids to emails itself.
5. **Notes can't phish.** Notes with links, emails, phone numbers or hidden characters are replaced with a fixed message (R9).

## Money safety

- One payout per person per disaster, enforced by the firewall and by a database `UNIQUE` constraint, and across look-alike event ids.
- PayPal `PayPal-Request-Id` derived from what is paid, so resends can't double-pay; unknown outcomes are retried with the same key.
- Donations credit the pool once per capture id, however many times the return URL, webhook or retry fires.
- Rate limits: payout batches per hour (firewall R7 and a demo-wide cap), donations per donor and globally, a card-testing pattern block.

## Untrusted input

| Source | Handling |
|---|---|
| USGS/news text | Wrapped in `<untrusted_text>` with angle brackets neutralised; scanned by the sentinel |
| Agent output | Parsed from `unknown`; free text scanned; notes checked |
| Donor `donor_ref`, `message` | Length-limited, control characters stripped, stored as data, rendered as text (never HTML), never sent to the agent or sentinel |
| PayPal webhooks | Verified with PayPal's signature API using the raw body; de-duplicated; unverified ones change nothing |

## Audit

Append-only SQLite table with triggers blocking UPDATE and DELETE, and a SHA-256 hash chain that detects edits even by someone who drops the triggers. Secrets are redacted before hashing; payee emails are masked.

## Credentials

Sandbox only: the PayPal client refuses to start unless `PAYPAL_ENV=sandbox` and its base URL is fixed to the sandbox. `.env`, the payee map and the database are gitignored. Runtime file reads are excluded from build tracing so a build can't bundle them.
