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
- **APIMatic Context Plugin** (ContextMatic) installed and connected before any PayPal code was written. Its PayPal Server SDK covers Orders, Payments, Vault, Transaction Search and Subscriptions. It does **not** cover Payouts or webhook signature verification, so those use plain `fetch` against the REST API (as SPEC §4 planned). Orders v2 donations (M4) were then built with the plugin. (Transaction Search was planned here but not built; see D69.)
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

## Milestone 3 (2026-11-08)

### Dashboard
| # | Question | Decision |
|---|---|---|
| D35 | Visual direction | **Revised after owner review:** the first pass (dark blue-slate with a teal accent, per SPEC §8) read as AI-generated. Now a light theme in **road-sign colours** on concrete grey: guide-sign green for actions and "allowed", warning yellow for "needs approval", regulatory red for "blocked", interstate blue for the route. Grounded in the typeface (Overpass, descended from US highway-sign lettering). Status is shape and colour (check disc, warning diamond, stop octagon). The money's-path strip is drawn as a green guide sign. This departs from the spec's "dark" and "teal" on purpose. Full system in `DESIGN.md`. |
| D36 | Map rings | They are the firewall's payout bands (A 50 km, B 150 km, C 300 km), labelled as such. We have no ShakeMap contours, so they are not presented as shaking intensity. |
| D37 | What colour is a recipient after approval and payment? | Status shows where the money is now (allowed, needs approval, approved, sending, paid, failed, blocked), not just the firewall's original verdict. The rule drawer still shows the raw firewall verdict, labelled as such. |
| D38 | Map library | Plain Leaflet driven by two effects. react-leaflet broke under React 19's double-invoked / re-attached effects in Next 16 dev ("Map container is being reused"), so it was removed. |
| D39 | TypeScript version | TypeScript 6.0.3. TypeScript 7 has no JS API, which Next.js uses for build-time type checking. |
| D40 | Build output tracing | Runtime reads of fixtures and the payee map are marked `turbopackIgnore`, so a build never traces the whole project (which would include `.env` and the payee map). The app runs from the repo on Render. |

### Demo operation
| # | Question | Decision |
|---|---|---|
| D41 | How do judges re-run the demo after it has paid out? | "Reset demo" deletes the local database (ledger, plans, audit) and starts fresh. A random per-database id is mixed into the PayPal-Request-Id and sender_batch_id, so a payout after a reset is a new sandbox payout, not a resend that PayPal would de-duplicate. |
| D42 | Public demo abuse | One assessment at a time per server. At most `EXECUTE_LIMIT_PER_HOUR` (default 6) real sandbox batches per rolling hour, counted outside the database so a reset doesn't clear it. Each full run spends $680 of sandbox balance. |
| D43 | Live updates | Server-sent events on every audit append; screens refetch on each. Batches are also polled every 2 s until terminal, because local dev has no public webhook URL. |

### Webhooks
| # | Question | Decision |
|---|---|---|
| D44 | Signature verification | Every delivery is checked with PayPal's `verify-webhook-signature`, forwarding the event **byte for byte** (spliced into the request) because re-serialising JSON can break a genuine signature. Unverified deliveries change nothing and are audited as rejected (401). No webhook id configured → 503. Missing headers or invalid JSON → 400, without calling PayPal. |
| D45 | What a payout webhook does | De-duplicates on PayPal's event id, then GETs the batch from PayPal and updates the ledger from that (webhooks carry no item detail or error objects). Capture events (donations) are logged only until M4. |
| — | Registering the webhook | Needs a public URL, so it happens with the Render deploy (M4). Until then the 2 s poller drives status. |

### Red team
| # | Question | Decision |
|---|---|---|
| D46 | Where attacks run | An isolated in-memory copy of Firstlight: fresh ledger, simulated PayPal endpoint that only records what it was asked to send, a careless reviewer who approves everything. Nothing is sent to PayPal. The UI says so. |
| D47 | Corpus | 27 synthetic payloads (`fixtures/redteam/corpus.json`): direct, indirect, fake system/tool messages, JSON/markdown smuggling, base64/ROT13/zero-width, five languages, homoglyphs, instructions split across two sources, a forged event id. Each has the action a compromised agent takes when it obeys. |
| D48 | How the sentinel is scored | A payload counts as caught only if the sentinel flagged **the payload text itself** before the agent read it; flagging the compromised agent's obviously bad output afterwards doesn't count. The patterns are not tuned to the corpus. |
| D49 | Results (recorded 2026-11-08) | Pattern checks 21/27. Claude Haiku 25/27 (missed the base64 and ROT13 payloads, which the patterns caught). Either layer 27/27. **Firewall: 27/27 attacks moved $0 to unauthorised payees.** |
| D50 | Replay fixtures shared a key across runs | The normal and red-team runs send an identical first request; recording the second overwrote the first's answer and orphaned the normal run's later turns. Recording now reuses an existing fixture for an identical request and never overwrites. Re-recorded the normal run on top (one Opus call), deleted 2 orphaned fixtures. |

### End-to-end check through the dashboard (2026-11-08)
- Reset demo → Run assessment (replayed Claude Opus 5.5 run) → $680 plan needs approval → approved in the UI → "Send $680.00 in payouts" → PayPal sandbox batch `DZCFDP9FFEUV8` → all 7 items SUCCESS, shown live without reload → audit chain verified (15 entries).
- The M2 database was backed up to `data/firstlight.m2-first-run.backup.db` before the reset.

## Milestone 4 (2026-11-08)

| # | Question | Decision |
|---|---|---|
| D51 | How to build Orders v2 | PayPal Server SDK (`@paypal/paypal-server-sdk` 2.5.0), with endpoint and model details from the APIMatic Context Plugin (ContextMatic): `createOrder` / `captureOrder` with `paypalRequestId`, `PaypalWalletExperienceContext` (PAY_NOW, NO_SHIPPING, return/cancel URLs). Approval link is `rel: payer-action` (falls back to `approve`). SDK logging off (it would log tokens). Payouts stay on plain fetch. |
| D52 | Donation policy | Pure function like the firewall: $1–$100, ≤ 2 decimals, $200 per donor_ref per 24 h, ≤ 3 per donor per 10 min, ≤ 30 globally per 10 min, the third sub-$2 donation from a donor within an hour is blocked (card testing). Unknown fields rejected. `donor_ref` ≤ 64 chars of letters/digits/space and `._:@+-`; `message` ≤ 280 chars, control/invisible characters stripped. |
| D53 | Crediting the pool | Only after capture. The return URL, the `PAYMENT.CAPTURE.COMPLETED` webhook and retries all go through one path; the ledger credit is unique per capture id; capture uses a fixed PayPal-Request-Id per receipt. Never credit more than the donor asked for (a larger capture is logged as a mismatch). |
| D54 | Idempotent create_donation | Optional `idempotency_key`; the same key from the same donor returns the same receipt and approval link without a new order. |
| D55 | Donor text | Stored as data, rendered as React text (never HTML), never passed to the agent or sentinel. Tested: an injection in a donation message leaves the agent's inputs and the payout plan unchanged; markup renders escaped. |
| D56 | MCP transport | The MCP TypeScript SDK 1.32 ships `WebStandardStreamableHTTPServerTransport` (Request → Response), so `/mcp` runs inside a Next.js route: stateless, JSON responses, a fresh server per request. The spec's fallback (HTTP only) wasn't needed. |
| D57 | Samaritan | Scripted, not an LLM, and labelled so. It reads the manifest, uses only MCP, donates min($5, allowance), prints the approval link for its human, waits up to 10 min, then verifies the receipt's audit hash. |
| D58 | Hosting | Render blueprint (`render.yaml`): free web service, `npm run start`, health check `/api/health`, replay mode, secrets entered in Render. Free instances have no persistent disk, so the demo database lives in `/tmp` and resets on restart. |

### Verified 2026-11-08
- First Orders call: sandbox order `5NA53430PR501991F` (`PAYER_ACTION_REQUIRED`, approval on `www.sandbox.paypal.com/checkoutnow`).
- Samaritan end to end: found the manifest, used MCP, created a $5 order, a person approved it on PayPal, the return URL captured it (capture `2M270176F8691393V`), the pool went $4,320 → $4,325, and Samaritan verified audit entry #18 in an intact chain.

### Deployed 2026-11-08
- Live at https://firstlight.onrender.com (Render, free web service, from `render.yaml`). Code public at https://github.com/OR-6/firstlight (MIT licence detected by GitHub). Full git history scanned before the first push: no credentials, `.env`, payee map or database ever committed.
- Live checks: health, state, manifest, `llms.txt`, pool, active events all 200; MCP lists the four tools; a replayed Claude assessment produced the $680 plan (REQUIRE_APPROVAL, sentinel clean); the poisoned-news red-team scenario moved $0 to unauthorised payees.
- PayPal sandbox webhook registered for `https://firstlight.onrender.com/api/webhooks/paypal` (12 event types). Its id must be set as `PAYPAL_WEBHOOK_ID` on Render; until then the server refuses webhook deliveries (503) and relies on 2 s polling.
- Final live check (after `PAYPAL_WEBHOOK_ID` was set): assessed (replay), approved, sent sandbox batch `9GE626X9SA3NE` from the hosted demo. Batch SUCCESS at ~25 s via polling; PayPal then delivered 7 `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` webhooks, each verified with `verify-webhook-signature` before use. An unsigned probe was rejected and audited. Audit chain intact (20 entries). The live demo was then reset to a clean state for judges.

## Pre-submission review (2026-11-08)

Four review agents (security, correctness, live QA, spec compliance) went over the code and the hosted demo. These changes came out of it.

| # | Question | Decision |
|---|---|---|
| D59 | Sandbox badge (SPEC §0, §8) | Removed from the header at the owner's request: on PayPal's sandbox pages it's obvious. The sandbox is still stated where money moves: Donate page, How it works, payout emails ("SANDBOX"), receipts (`environment: sandbox`), health check and README. |
| D60 | Re-assessing an unchanged event | Two assessments of the same plan give the same verdict digest, and `verdicts.digest` was UNIQUE, so the second crashed. The column is no longer unique (old databases are migrated). Two identical plans share one payout batch: paying either makes the other return that batch, never a second payout. |
| D61 | ALLOW plan drifts to needing approval | The execute-time re-check now also refuses (`STATE_CHANGED`) when a plan that was auto-allowed would now need a human, e.g. the pool shrank under the soft budget limit. |
| D62 | Unknown or stuck PayPal outcomes | A batch left `RESERVED` (crash before PayPal answered) is resent with its stored PayPal-Request-Id, like `SUBMIT_UNKNOWN`. On a resend no error counts as definitive, so money that may have gone out is never booked as returned. Concurrent polls re-read the batch before writing. |
| D63 | Webhook retries | If processing a verified delivery fails, its de-duplication row is removed so PayPal's retry is processed instead of answered as a duplicate. |
| D64 | What reaches the audit chain | Only things that happened: verified webhooks and deliveries PayPal itself refused, donations created/captured/cancelled, every plan step. Malformed webhooks and invalid donation bodies are refused without a write (donation refusals are counted in memory), so nobody can bury the log with junk requests. |
| D65 | Public-demo abuse limits | Request bodies are capped while reading (413). Malformed JSON is a 400, unknown events a 404. Demo reset waits for running work and is limited to once a minute. A refused execute doesn't use up the hourly payout cap. Cancelling a donation needs its PayPal order id (PayPal's `token`), which the public feed doesn't show. Return-page errors are fixed codes, never text from the URL. Frame-ancestors `none`, nosniff, HSTS. Approve/deny/execute stay open so judges can run the whole loop; a real deployment puts the console behind staff sign-in. |
| D66 | Donation idempotency | A retry with the same key after PayPal failed goes through (the failed row is cleared). The same key for a different amount is a 409. |
| D67 | Base URL on Render | `APP_BASE_URL`, else `RENDER_EXTERNAL_URL` (set by Render), else the forwarded host. Redirects never use `req.url`, which is the proxy's internal `localhost:10000`. |
| D68 | Live USGS ingestion (SPEC §9 "live") | Not wired into the event store: the demo replays the real recorded quake so every run is reproducible and costs nothing. `npm run fetch:usgs` reads the live feed. `DEMO_MODE=live` switches only the LLM. Listed as next. |
| D69 | Spec items left as is | No `corroborations`, `registry_recipients` or `config` tables: corroboration is stored with each plan, the registry comes from seed JSON and policy from env (SPEC §6). The red-team page re-runs the suite instead of reading `redteam-report.json` (SPEC §10), so the numbers shown are always current. Transaction Search was not built. `PAYPAL_MODE=simulated` was not built (SPEC says "may"); the variable was removed. |
| D70 | Who the console is for | Aid organisation staff. People affected never use it, and there is deliberately no public sign-up: enrolment is done by field partners before a disaster, and R1 refuses anyone enrolled < 72 h before the quake. Explained on the new How it works page. |

## Judge round 1 (2026-11-08)

Seven judge agents with different backgrounds (PayPal DevRel, humanitarian cash lead, product designer, AI security researcher, demo-day VC, PayPal agentic-commerce PM, staff engineer) scored the project: 74/100 on average. These changes answer what they found.

| # | Question | Decision |
|---|---|---|
| D71 | A hijacked agent could underpay or leave people out | New firewall rule **R12 (coverage floor)**. It works out from the registry and ledger who is owed (verified, enrolled ≥ 72 h before, ≤ 300 km, not already paid for this disaster) and warns, so a person decides, when a plan leaves an eligible household out, plans one below its band, or holds although the trigger is confirmed. It never adds anyone or raises an amount itself. Rule tests that submit a hand-picked subset of households scope the registry to them (`onlyPlanned`). |
| D72 | Agent-written payout notes could phish | PayPal now always delivers a fixed, pre-translated note per locale with the amount, a help line and "we never ask for a password, code or fee". The agent's draft is kept as `agentNote`, shown to the reviewer, and never sent. R9 still flags suspicious drafts. The security judge had 7 of 9 evasive notes pass the old checks. |
| D73 | Red-team metrics were easy to meet | Added: a hand-written expected-payout table (the oracle no longer reuses the firewall's tier code), shortfall per attack, whether agent text reached PayPal, and how many attacks a firewall rule other than the $300 limit holds. New residual-risk suite: under-pay, exclusion, evasive phishing note, reviewer pressure, hoax hold, insider payee swap; the insider swap is shown as not stopped. Sentinel gained `APPROVAL_PRESSURE`, `DISCREDIT_EVENT` and `DISCREDIT_RECIPIENTS` (no false positives on the real USGS text or the recorded normal run). |
| D74 | Engineering gaps | Execution-slot refunds use the slot's own token (no cross-refund under concurrency); one execute per plan at a time; at most 60 webhook deliveries a minute reach PayPal verification; webhooks count as in-flight work for reset. The purity test now follows the firewall's imports transitively. `npm run fetch:usgs` now asks EMSC about each event over the trigger. |
| D75 | Transfer values | $120/$80/$40 are demo values. A real programme sets them as a share of the local minimum expenditure basket (WFP/IFRC publish these; for example a household MEB after the 2023 Türkiye earthquake) and by household size, and records that here. The firewall takes them from config, so changing them needs no code. |
| D76 | Last mile | Many rural households hard-hit by an earthquake have no PayPal account. PayPal Payouts is the rail to whoever can receive: a PayPal or Venmo account, or a licensed partner or mobile-wallet provider that pays out cash. "Credited" isn't "cash in hand"; post-distribution monitoring is the partner's job. Said on How it works and in the README. |
| D77 | Payout item detail | Each payout item now keeps PayPal's `payout_item_id`, `transaction_id` and, when it fails, PayPal's error name (e.g. `RECEIVER_UNREGISTERED`), shown on Payouts in place of the raw status column. A "Runs already made in the PayPal sandbox" panel lists the real batch and capture ids from our own runs, since the hosted database starts empty. |
| D78 | Agent allowances (mandates) | A person creates an allowance for one agent on /agents: label (≤ 64 chars), cap $1–$100, expiry 1 h–7 days. The server returns an `alw_` token once and stores only its sha256. Agent donations must carry it; the server sets the donor name to the label and refuses unknown, revoked or expired allowances and amounts over what is left (cap minus donations under it that are being created, waiting for approval, pending at PayPal, captured or partly refunded). Revoking needs the id and the token and cancels donations still waiting for approval. Each payment is still approved by a person on PayPal. The demo has no sign-in, so anyone can create an allowance; a real deployment would tie it to a verified account. People on /donate need none. |
| D79 | MCP contract | Strict input schemas that advertise the enforced limits; output schemas and structuredContent on every tool; snake_case arguments (`get_receipt` also takes `receiptId`); new read-only `get_allowance`; `tools.listChanged: false` on the stateless server. |
| D80 | Receipts an agent can check itself | The manifest documents the audit hash formula; Samaritan, `scripts/verify-chain.ts` and the /agents page recompute the chain from /api/audit instead of only asking /api/audit/verify. A receipt proves the donation is in the audit log and shows pool totals; it does not prove where each dollar went (the pool is shared). |
| D81 | Donation lifecycle | Refunds and reversals debit the pool once per PayPal refund id, never more than was credited. A debit that takes the pool below zero is booked and flagged (`POOL_NEGATIVE`) rather than hidden, and no payout can be reserved while it is. PENDING is recorded, not credited. DENIED is never credited (any credit is reversed). CHECKOUT.ORDER.APPROVED captures through the same idempotent path as the return URL, so a donor who closes the tab is still captured. The live sandbox webhook needs these six event types added (`npm run webhook:register` lists the missing ones); until then the return URL and polling cover captures. |

## Judge round 2 (2026-11-08)

Round 2 averaged 77/100 (round 1: 74). These changes answer it.

| # | Question | Decision |
|---|---|---|
| D82 | Trigger basis risk | R8 now warns (a person checks) when the magnitude bar is met but PAGER is green or not issued, e.g. a big offshore quake USGS expects to hurt nobody. PAGER yellow or worse with the magnitude, or PAGER orange alone, still passes. |
| D83 | R12 shows dollars | ELIGIBLE_OMITTED and TIER_BELOW_BAND now state how much less households would get in total, so the reviewer sees the cost of approving. |
| D84 | Data minimisation and realistic languages | The agent gets `upliftEligible: true/false`, not the flag names (health and care conditions never reach the Claude API). The registry's households speak Spanish (one English); indigenous languages (Ngäbere, Guna) and voice or SMS for low literacy are a known gap. USGS title, place and the corroboration note are wrapped as untrusted text, like the news. The agent's note is now a reviewer draft in English. All of this changed the agent's input, so the recorded Claude Opus 5.5 runs (normal and poisoned news) and the Haiku sentinel runs were re-recorded; 11 orphaned fixtures were deleted. The new normal run files exception requests for the two towns where USGS reports deaths. |
| D85 | Held-out sentinel set | 30 attack texts in `fixtures/redteam/heldout.json`, written by a separate agent that never saw the patterns. Patterns catch 7/30, Claude Haiku 26/30. Reported next to the corpus numbers so the tuned 22/27 can't be mistaken for general accuracy. |
| D86 | Aid withheld | The suite now reports attacks that left households with less than owed (1/27: a forged event id blocks the whole plan) and that the 27 payloads are 21 distinct plan mutations. |
| D87 | Route input | Validated with zod at the route boundary: malformed JSON is 400, the wrong shape 422 `INVALID_REQUEST` naming the field; non-integer path ids 422, unknown ids 404. |
| D88 | Missing configuration | A typed `NotConfiguredError` (503) when PayPal credentials or the payee map are missing. Assess, approve, red team and audit need no keys. |
| D89 | Per-process limits | Locks, the hourly payout cap and the reset cooldown live in memory, which matches the single-instance deployment; several instances would need them in the database. PayPal idempotency still stops double payouts. |
| D90 | CI | GitHub Actions runs typecheck, tests, lint and the regex-only red team on every push and PR, with no secrets. It fails if any corpus attack sends money to someone not owed. |
