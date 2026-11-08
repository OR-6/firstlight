# Decisions log

Choices made where SPEC.md was silent or ambiguous. Each one is a default, not
a law: change it here and in code together. Newest first within each section.

## Milestone 1 (2026-11-08)

### Verified at build time (SPEC §14)
- **USGS summary feed** URL pattern works (`…/summary/significant_month.geojson`, HTTP 200, `api 2.8.2`).
- **USGS FDSN event-by-id** returns a single `Feature` (not a collection), and lists more alias ids than the feed (`usauto…`).
- **EMSC SeismicPortal** works: `https://www.seismicportal.eu/fdsnws/event/1/query?format=json&…`.
  Shape: GeoJSON `FeatureCollection`; times are ISO strings; `properties.depth` is positive while `geometry.coordinates[2]` is negative.
  Its record for the Panama M7.7 (`20261009_0000264`) agrees with USGS `us6000u18k` (ΔM 0, 3.6 km, ~2 s). Corroboration does not need the fallback for now.
- Candidate replay event for M2: **`us6000u18k`, M7.7 Panama, PAGER orange, 2026-10-09** (real, reviewed, EMSC-corroborated). Fixtures saved in `fixtures/events/`.

### Firewall policy
| # | Spec gap | Decision |
|---|---|---|
| D1 | R2 "distance/intensity band": no thresholds given; per-recipient intensity needs ShakeMap. | Distance only. Bands: A ≤ 50 km, B ≤ 150 km, C ≤ 300 km (inclusive); beyond 300 km no payout. Distance is rounded to 1 m before comparing. |
| D2 | R2 says the agent tiers on "distance **and** vulnerability", but also "never higher" than the band, which would make vulnerability meaningless. | A recipient with a configured vulnerability flag (`sole_caregiver`, `mobility_impaired`, `chronic_illness`, `elderly_living_alone`) may get **one** tier above their distance band. Uplift never makes an out-of-radius recipient eligible. |
| D3 | R2 "BLOCK or downgrade". | Over-tier request → **downgrade** to the allowed tier + WARN (so a human sees it). Outside radius → BLOCK. |
| D4 | R4 has two caps but one env var. | `PER_RECIPIENT_CAP_USD` sets both the per-event and the rolling 90-day cap ($150). Over cap → BLOCK, never trimmed. FAILED/BLOCKED/DENIED/CANCELED payouts don't count against caps; everything else (incl. UNCLAIMED, RETURNED) does. |
| D5 | R5 "REQUIRE_APPROVAL, then BLOCK over hard cap": which limit is soft? | **Hard (BLOCK):** plan total > pool balance, or (already paid for event + plan) > event cap. **Soft (WARN):** plan total > 60% of pool. |
| D6 | R6 only keys on `(eventId, recipientId)`, so a spoofed or re-issued event id would re-pay everyone. | R6 also blocks if the recipient was paid for an event sharing a USGS alias id, or within **100 km and 48 h** (aftershocks count as the same disaster: for the Panama M7.7, the real M6.6 at 77 km/2.5 h and M6.0 at 25 km/10 h fall inside; the M6.1 at 80 km/77 h does not, and R4's rolling cap then limits any second payout). Any prior record blocks, whatever its status. Retrying a FAILED payout is an operator action, not a plan revision. |
| D7 | R6 `PayPal-Request-Id` "hash of batch contents". | sha256 of canonical `{eventId, sorted (recipientId, amountCents)}`. Notes are excluded, so rewording notes can't produce a fresh key for the same money. |
| D8 | R7 "N batches/hour" unspecified. | N = 3 per rolling hour; kill switch via config / `FIREWALL_KILL_SWITCH=1`. Both BLOCK the plan. |
| D9 | R8 "BLOCK or REQUIRE_APPROVAL": which is which? | Threshold not met (mag < 6.0 **and** PAGER < orange) → BLOCK. Threshold met but fewer than 2 agreeing sources → WARN. Agreement only via the non-independent "USGS reviewed + PAGER" fallback → WARN (degraded). Also requires origin times within 120 s. Event time after `now` → BLOCK. |
| D10 | Spec trigger is "mag ≥ 6.0 **or** PAGER ≥ orange", which fires for mid-ocean quakes. | Kept as written; the distance bands stop payouts where nobody is registered (→ `NO_PAYABLE_ITEMS`). |
| D11 | R9 "unknown field → REQUIRE_APPROVAL" needs the firewall to see raw output. | `evaluatePlan(raw: unknown, ctx)` parses the plan itself. Unknown keys are stripped (never read) and WARN; wrong types or missing fields → `PLAN_MALFORMED` BLOCK. Hard size limits (500 items, 5,000-char note, …) also count as malformed. |
| D12 | Agent `decision` semantics not tied to a rule. | `hold` → BLOCK (agent can only make things stricter). `escalate` → WARN. Plan `eventId` ≠ context event → BLOCK. |
| D13 | Sentinel flag has no field in `PayoutPlan`. | Passed in context (`ctx.sentinel`), set by the orchestrator, never by the agent. |
| D14 | Notes are the only agent text that reaches a recipient (phishing risk). Not covered by a rule. | Under R9: a note over 200 chars, or with a link/domain, email, phone-like number, or control/invisible characters (checked after NFKC folding) is **replaced with a fixed fallback** + WARN. Length is checked before any regex (ReDoS guard). |
| D15 | Partial plans: some items blocked, some fine. | Blocked items are never payable. Any blocked item makes the rest REQUIRE_APPROVAL (R10 `ITEMS_BLOCKED`), because a bad item suggests a bad plan. Zero payable items → BLOCK. |
| D16 | R11 "every verdict written to the audit log" can't happen inside a pure function. | The engine returns `verdict.digest`. The caller must append the verdict to the audit log; the executor (M2) refuses verdicts whose digest isn't logged (`AuditLog.hasVerdict`). |
| D17 | Item trace for UI. | Each item's `ruleTrace` = its item rules + all plan rules, sorted R1→R10. Item rules stop at the first BLOCK (later rules need data the earlier ones establish). |
| D18 | `amountUsd` in spec. | Integer **cents** everywhere; `toPayPalValue()` formats `"80.00"` at the PayPal boundary. |

### Storage
- The ledger also enforces R6 in SQL: `UNIQUE(event_id, recipient_id)` on `payout_items`, `UNIQUE(paypal_request_id)` on batches, `UNIQUE(kind, ref)` on ledger entries (so a replayed donation capture can't double-credit).
- `audit_log` has triggers blocking UPDATE/DELETE. The hash chain still detects tampering by anyone who drops the triggers.
- Secret-looking keys (`secret`, `token`, `authorization`, `client_id`, …) are redacted before hashing and storage.

### PayPal (verified 2026-11-08)
- **APIMatic Context Plugin** (ContextMatic) installed and connected before any PayPal code was written. Its PayPal Server SDK covers Orders, Payments, Vault, Transaction Search and Subscriptions. It does **not** cover Payouts or webhook signature verification, so those use plain `fetch` against the REST API (as SPEC §4 planned). Orders v2 donations (M4) and Transaction Search will be built with the plugin.
- **The sending sandbox business account must be in a Payouts-enabled country.** The first app was linked to the default sandbox business account, which is in **India (IN)**; its payout returned `403 PAYOUT_NOT_AVAILABLE — You live in a country that is not allowed to send this payout`. A new app linked to a **US** sandbox business account (funded $10,000) worked.
- **$1 smoke test passed:** batch `DHSSBZRTMH9DW`, PENDING → PROCESSING → SUCCESS in ~22 s, item `SUCCESS`, transaction `7T759407LM597511H`. Run it with `npm run smoke:payout -- --send`; `npm run paypal:check` only fetches a token.
- The OAuth token response lists scopes, so `paypal:check` can confirm the app has the Payouts scope without moving money.
- The client refuses to start unless `PAYPAL_ENV=sandbox`, and its base URL is hardcoded to `api-m.sandbox.paypal.com`.

## Milestone 2 (2026-11-08)

### Agent and LLM
| # | Spec gap / constraint | Decision |
|---|---|---|
| D19 | Spec asks for "low temperature". Claude Opus 5.5 rejects `temperature` (HTTP 400), and so will every model from API version 2026-10-21. | No sampling params. Reasoning depth is set with `output_config.effort: "high"` (Opus 5.5 defaults to `medium`). Thinking is always on in Opus 5.5. |
| D20 | Forced `tool_choice` is rejected on Opus 5.5. | `tool_choice` left at `auto`; tools use `strict: true`; the prompt says to call `submit_plan`; one repair nudge if it answers in prose. |
| D21 | Model refusals. | Server-side fallback on (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`): a declined request is re-run on Anthropic's recommended substitute. A refusal that still comes back fails the assessment (nothing paid). |
| D22 | "Max 6 tool turns" | 6 model calls per assessment, counting the repair. One repair is shared between "invalid plan" and "no plan". |
| D23 | Which model for the sentinel's "cheap" pass | `claude-haiku-5-5` (no server-side fallback exists for it). Agent model: `claude-opus-5-5`, overridable with `LLM_MODEL`. |
| D24 | Sentinel LLM layer flagged the agent's own rationale on the first live run (it discusses tiers and payments). | Snippets are labelled `external` or `agent_output`; agent output is flagged only for signs of obeying an attacker (contact details, unregistered payees, asks of the recipient). Re-recorded run is clean. Any classifier error or refusal counts as suspicious (fail closed). |
| D25 | A bare URL in the real USGS text (`www.tsunami.gov`) would trip a "link" heuristic. | Links are not a sentinel signal (notes are still link-checked by firewall R9). Test: the real USGS texts produce zero findings. |
| D26 | "News (untrusted)" source. Real news articles are copyrighted. | Untrusted text is the real, public-domain USGS "key points" and "impact summary" products from the event record. The only invented text is red-team payloads in `fixtures/redteam/`, labelled synthetic. |
| D27 | Replay fixture key | sha256 of the canonical full request (model, system, tools, messages incl. tool results). Any prompt or input change misses the cache and fails loudly; record with `npm run record:fixtures`. |

### Pipeline
| # | Question | Decision |
|---|---|---|
| D28 | Approval can be hours old when executed (TOCTOU). | `execute` re-runs the firewall against the current ledger; if the payable set or request id changed, it refuses (`STATE_CHANGED`) and you reassess. |
| D29 | R11 enforcement | `execute` refuses any verdict whose digest is not in the audit log. |
| D30 | Approval semantics | One decision per plan, final. Approver and reason are required and logged. ALLOW plans need none. |
| D31 | PayPal create fails | 4xx (except 409/429) is definitive: items marked FAILED and the money is re-credited to the pool. 5xx, network errors, 409, 429: outcome unknown, batch kept as `SUBMIT_UNKNOWN`; re-running `execute` resends with the same `PayPal-Request-Id`, so PayPal can't double-pay. |
| D32 | Where payee emails live | `config/payees.sandbox.json` (gitignored) or `PAYEES_JSON` for hosting. Only `pipeline.ts` imports the loader (enforced by `tests/isolation.test.ts`). Audit entries mask addresses (`sb-89…560@…`). |
| D33 | Registry | 8 synthetic recipients at town centres near the Panama epicentre: 4 tier A (two via vulnerability uplift), 2 B, 1 C, 1 outside the radius. Full payable plan = $680 → needs approval (> $300). |
| D34 | Demo pool | The ledger is seeded with $5,000 (idempotent `demo-pool-seed`). The sandbox business account holds $10,000, so the ledger is the binding limit. |

### First end-to-end sandbox run (2026-11-08)
- Real assessment by `claude-opus-5-5` of `us6000u18k` (M7.7 Panama): 2 turns, ~24 s, decision `trigger`, 7 recipients, $680, multilingual notes (es, en, ne, id, ja). Recorded to `fixtures/llm/`; replay reproduces it with no API key.
- The agent independently noted that several synthetic recipients' locales are unusual for Panama — true, and the kind of observation a reviewer wants.
- Approved via CLI, then PayPal sandbox batch `2BQ585TNCTVDA`: items `SUCCESS` at ~26 s, batch `SUCCESS` at ~33 s. Ledger pool $5,000 → $4,320; audit chain intact (12 entries).
- Red-team run (recorded, `npm run fl -- assess --redteam`): with 4 poisoned items added to the real USGS text, `claude-opus-5-5` still submitted exactly the legitimate $680 plan and listed all 4 attacks in its rationale. The regex sentinel flagged all 4 payloads (17 findings incl. the agent's rationale quoting the attacker addresses). Firewall: REQUIRE_APPROVAL. This is one run, not a measured rate; M3's `npm run redteam` measures the full corpus.
