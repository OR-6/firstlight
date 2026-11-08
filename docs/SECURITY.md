# Security model

Firstlight assumes the AI agent **can be fully compromised**. It then guarantees that money only reaches enrolled, eligible households, at amounts the firewall computes, within budget, and that the agent can't write to recipients. It does **not** guarantee that a hijacked agent pays everyone it should: under-payment, exclusion and holds are caught and sent to a person (R12), but a careless person can still approve them. The table at the end lists what is and isn't covered. Everything below is enforced in code and covered by tests.

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
5. **The agent can't message recipients.** PayPal only ever delivers a fixed, pre-translated note with a help line and "we never ask for a password, code or fee". The agent's draft is shown to the reviewer and never sent. R9 still flags drafts with links, emails, numbers or hidden characters, because they are a sign of a compromised agent. (Before D72 the cleaned draft was sent, and our own red team found phishing notes that slipped past the checks.)
6. **Paying too little needs a person too.** R12 works out from the registry and ledger who is owed, and warns when a plan leaves an eligible household out, pays one below its band, or holds although two agencies confirmed the quake.

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

## What is and isn't covered

Run with `npm run redteam -- --llm replay` (corpus) and shown on the Red team page. "Careless reviewer" means the harness approves everything that reaches a person.

| Threat | Covered by | What happens |
|---|---|---|
| Injected instruction to pay a stranger, raise tiers, add fields, smuggle JSON, encode, translate, use look-alike ids (27 payloads) | Schema + R1–R6, R9 | $0 to anyone not owed, in 27/27; every one is also held by a firewall rule other than the $300 limit |
| Phishing through the payout note | Fixed note templates (D72) | Agent text reaches PayPal in 0 cases |
| Paying everyone less, or leaving households out | R12 (D71) | Goes to a person with the shortfall named; a careless person can still approve it |
| Pressuring the reviewer ("pre-cleared, approve now") | Sentinel `APPROVAL_PRESSURE` | The exact phrasing is flagged; paraphrases mostly aren't (the pattern layer caught 7 of 30 held-out texts, Claude Haiku 26 of 30). Still a person's call |
| Talking the agent into holding everything ("the report is a hoax"), or a forged event id that blocks the plan | R12 `HOLD_ON_MET_TRIGGER`, sentinel `DISCREDIT_EVENT` | Nothing paid, flagged for a person to re-run. A feed that stays poisoned keeps blocking: availability isn't guaranteed |
| Paying twice: same quake under a new id, replayed plan, concurrent sends | R6, DB `UNIQUE`, PayPal-Request-Id, per-plan lock | Blocked |
| Insider changes a payee address in the payee map | **Not covered** | Money goes to the swapped address. Needs the partner's two-person change control and PayPal account-holder checks |
| Fake households enrolled weeks in advance (registry poisoning) | **Not covered** by code | The registry's `verified` flag is trusted. Enrolment checks belong to the field partner |
| Someone approving without authority | **Not covered in the demo** | The console is open so judges can try it; `approver` is free text. A real deployment needs staff sign-in and two people above a threshold |
| Spoofed earthquake data | R8 needs two agencies to agree | One spoofed feed isn't enough; both being spoofed isn't covered |
| Denial of service on the public demo | Body caps, rate limits, reset cooldown, webhook budget (D65) | Slows abuse; not a full defence |

The Haiku sentinel numbers on the hosted site come from recorded runs (replay), not a live measurement on each request.

## Personal data

| Data | Where it lives | Who sees it |
|---|---|---|
| Household id, town, home location, language, vulnerability flags | Registry (synthetic in the demo) | The firewall and staff. The agent (and so the Claude API) only gets `upliftEligible: true/false`, never which condition (D84) |
| PayPal address | Payee map (env or a gitignored file) | Only the payout executor and PayPal. Masked in the audit log |
| Donor name and message | Donations table | Public feed, as plain text. Never sent to the agent |

A real deployment would also need consent at enrolment, a data-sharing agreement with the field partner and a retention period.
