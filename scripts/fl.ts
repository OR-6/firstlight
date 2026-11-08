/**
 * Firstlight CLI (M2) — drives the real loop until the dashboard exists.
 *
 *   npm run fl -- assess [--event us6000u18k] [--llm replay|record|live] [--redteam]
 *   npm run fl -- approve <planId> --by <name> --reason "<text>"
 *   npm run fl -- deny <planId> --by <name> --reason "<text>"
 *   npm run fl -- execute <planId>            # real PayPal SANDBOX payout, then polls status
 *   npm run fl -- audit                       # verify the hash chain
 *
 * State lives in data/firstlight.db (gitignored). SANDBOX ONLY.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { firewallConfigFromEnv } from '../src/firewall/config';
import { formatUsd } from '../src/firewall/money';
import { openDb } from '../src/ledger/db';
import { selectLlm, type LlmMode } from '../src/llm/select';
import { PayPalClient, loadPayPalConfig } from '../src/paypal/client';
import { Pipeline } from '../src/pipeline/pipeline';
import { loadPayees } from '../src/registry/payees';
import { loadRegistry } from '../src/registry/registry';
import { loadReplayEvent } from '../src/signals/replay';
import type { UntrustedText } from '../src/signals/untrusted';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);

const DEMO_POOL_CENTS = 5_000_00;
mkdirSync('data', { recursive: true });
const db = openDb(process.env.FIRSTLIGHT_DB ?? 'data/firstlight.db');
const llmMode = (flag('llm') ?? (process.env.DEMO_MODE === 'live' ? 'live' : 'replay')) as LlmMode;
const llm = selectLlm(llmMode);
const registry = loadRegistry();
const pipeline = new Pipeline({
  db,
  llm,
  sentinelLlm: llm,
  registry,
  config: firewallConfigFromEnv(process.env),
  agentModel: process.env.LLM_MODEL || undefined,
});
// Sandbox demo pool (idempotent). The ledger, not a PayPal balance, is the source of truth.
pipeline.ledger.seedCredit('demo-pool-seed', DEMO_POOL_CENTS);

async function main() {
  console.log('SANDBOX — no real money moves.\n');
  switch (cmd) {
    case 'assess': {
      const eventId = flag('event') ?? 'us6000u18k';
      const bundle = loadReplayEvent(eventId);
      const extra: UntrustedText[] = has('redteam')
        ? (JSON.parse(readFileSync('fixtures/redteam/poisoned-news.json', 'utf8')) as { items: UntrustedText[] }).items
        : [];
      console.log(`Assessing ${bundle.event.title} with LLM mode "${llmMode}"${extra.length ? ` + ${extra.length} red-team items` : ''}…`);
      const t0 = Date.now();
      const a = await pipeline.assess({ ...bundle, untrusted: [...bundle.untrusted, ...extra] });
      console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);

      console.log(`Plan #${a.planId} (event ${a.eventId}, version ${a.version})`);
      if (!a.agent.ok) {
        console.log(`✗ Agent failed: ${a.agent.reason}`);
        return;
      }
      const plan = a.agent.rawPlan as { decision?: string; rationale?: string; exceptionRequests?: unknown[] };
      console.log(`Agent (${a.agent.servedBy}, ${a.agent.turns} turns): decision = ${plan.decision}`);
      console.log(`Rationale: ${plan.rationale}\n`);
      console.log(`Sentinel: ${a.sentinel.injectionSuspected ? `SUSPECTED (${a.sentinel.findings.length} findings)` : 'clean'}`);
      for (const f of a.sentinel.findings.slice(0, 12)) console.log(`  - [${f.layer}] ${f.target}: ${f.rule} — ${f.excerpt}`);

      const v = a.verdict!;
      console.log(`\nFirewall: ${v.overall}   total ${formatUsd(v.totalCents)}`);
      for (const r of v.planRules) console.log(`  ${r.id.padEnd(3)} ${r.status.padEnd(5)} ${r.reasonCode} — ${r.detail}`);
      console.log('\n  recipient  req→allowed  amount    verdict            note');
      for (const i of v.items) {
        const itemRules = i.ruleTrace.filter((r) => r.scope === 'item' && r.status !== 'pass').map((r) => r.reasonCode);
        console.log(
          `  ${i.recipientId.padEnd(10)} ${i.requestedTier}→${i.allowedTier ?? '-'}         ${formatUsd(i.amountCents).padEnd(9)} ${i.verdict.padEnd(18)} ${i.note.slice(0, 60)}${itemRules.length ? `  [${itemRules.join(', ')}]` : ''}`,
        );
      }
      if (v.overall === 'REQUIRE_APPROVAL') console.log(`\nNext: npm run fl -- approve ${a.planId} --by <name> --reason "<why>"`);
      if (v.overall === 'ALLOW') console.log(`\nNext: npm run fl -- execute ${a.planId}`);
      return;
    }
    case 'approve':
    case 'deny': {
      const planId = Number(argv[1]);
      pipeline.decide(planId, cmd, flag('by') ?? '', flag('reason') ?? '');
      console.log(`Plan #${planId}: ${cmd === 'approve' ? 'approved' : 'denied'} by ${flag('by')}.`);
      if (cmd === 'approve') console.log(`Next: npm run fl -- execute ${planId}`);
      return;
    }
    case 'execute': {
      const planId = Number(argv[1]);
      const paypal = new PayPalClient(loadPayPalConfig());
      const payees = loadPayees(process.env, new Set(registry.map((r) => r.recipientId)));
      let batch = await pipeline.execute(planId, paypal, payees);
      console.log(`PayPal batch ${batch.paypal_batch_id} (${batch.status}) for plan #${planId}`);
      const t0 = Date.now();
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const s = await pipeline.poll(batch.id, paypal);
        batch = s.batch;
        console.log(`  ${((Date.now() - t0) / 1000).toFixed(0).padStart(3)} s  batch ${s.batch.status}  ${s.items.map((x) => `${x.recipientId}:${x.status}`).join(' ')}`);
        if (s.terminal) break;
      }
      console.log(`\nPool balance now ${formatUsd(pipeline.ledger.poolBalanceCents())}`);
      return;
    }
    case 'audit': {
      const check = pipeline.audit.verify();
      console.log(check.ok ? `✓ audit chain intact: ${check.count} entries, head ${check.headHash.slice(0, 16)}…` : `✗ audit chain BROKEN at seq ${check.brokenAtSeq}: ${check.reason}`);
      return;
    }
    default:
      console.log('Usage: npm run fl -- assess|approve|deny|execute|audit (see scripts/fl.ts)');
  }
}

main().catch((err) => {
  console.error(`✗ ${(err as Error).message}`);
  process.exitCode = 1;
});
