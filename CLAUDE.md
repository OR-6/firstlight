Read SPEC.md first. Follow its milestone order. Never put PayPal or LLM credentials anywhere the agent can read them.

- `src/firewall/**` is pure and deterministic: no I/O, no clock reads, no randomness, no LLM calls. Time comes in as `ctx.now`.
- Only `src/paypal/**` may read PayPal credentials. The agent never sees emails or amounts.
- Install the APIMatic Context Plugin before writing any PayPal code (SPEC §13 M1).
- Policy decisions that the spec left open are recorded in `docs/decisions.md`; update it when changing one.
