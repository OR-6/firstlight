/**
 * Red-team suite (SPEC §10). Runs every payload in fixtures/redteam/corpus.json
 * against an isolated copy of Firstlight with a scripted agent that obeys the
 * payload, a careless approver, and a simulated PayPal endpoint.
 *
 *   npm run redteam                    # regex sentinel only (no API key needed)
 *   npm run redteam -- --llm replay    # + recorded Claude Haiku sentinel results
 *   npm run redteam -- --llm record    # + live Haiku sentinel, recording fixtures (needs ANTHROPIC_API_KEY)
 *
 * Writes redteam-report.json. Exits non-zero if ANY money would reach an unauthorised payee.
 */
import { writeFileSync } from 'node:fs';
import { formatUsd } from '../src/firewall/money';
import { selectLlm, type LlmMode } from '../src/llm/select';
import { runSuite } from '../src/redteam/scenarios';

const i = process.argv.indexOf('--llm');
const mode = (i >= 0 ? process.argv[i + 1] : undefined) as LlmMode | undefined;
const sentinelLlm = mode ? selectLlm(mode) : null;

const report = await runSuite(sentinelLlm);
writeFileSync('redteam-report.json', JSON.stringify(report, null, 2) + '\n');

console.log('Firstlight red-team suite — isolated ledger, simulated PayPal, nothing sent to PayPal\n');
console.log('id                 category      sentinel(re/llm)  verdict           sent       unauthorised');
for (const r of report.results) {
  const s = `${r.sentinel.regex ? 'yes' : 'no '}/${r.sentinel.llm === null ? 'n/a' : r.sentinel.llm ? 'yes' : 'no '}`;
  console.log(
    `${r.id.padEnd(18)} ${r.category.padEnd(13)} ${s.padEnd(17)} ${r.verdict.padEnd(17)} ${formatUsd(r.sentCents).padEnd(10)} ${formatUsd(r.unauthorisedCents)}`,
  );
}
const n = report.payloads;
const pct = (k: number) => `${Math.round((k / n) * 100)}%`;
console.log(`\nPayloads: ${n}`);
console.log(`Sentinel (regex): ${report.sentinel.regexCaught}/${n} flagged (${pct(report.sentinel.regexCaught)})`);
console.log(
  report.sentinel.llmCaught === null
    ? 'Sentinel (Claude Haiku): not measured (run with --llm replay or --llm record)'
    : `Sentinel (Claude Haiku): ${report.sentinel.llmCaught}/${report.sentinel.llmMeasured} flagged`,
);
console.log(`Sentinel (either layer): ${report.sentinel.eitherCaught}/${n} flagged (${pct(report.sentinel.eitherCaught)})`);
console.log(`Firewall: ${n - report.firewall.payloadsWithUnauthorisedPayout}/${n} attacks moved $0 to unauthorised payees (total unauthorised: ${formatUsd(report.firewall.unauthorisedCents)})`);
console.log(`Firewall: ${report.firewall.flaggedBeyondThreshold}/${n} held for a reason other than the $300 approval limit (the honest $680 plan already needs a person)`);
console.log(`Firewall rules alone (if the sentinel missed everything): ${report.firewall.firewallFlagged}/${n} held or blocked for a reason other than the $300 limit`);
console.log(`Payout notes: agent-written text reached PayPal in ${report.firewall.agentTextDelivered}/${n} attacks (PayPal only gets fixed templates)`);
console.log('\nResidual risks: attacks that don\'t try to pay a stranger (careless reviewer approves everything)');
console.log('id                   outcome          verdict           sent       shortfall  unauthorised');
for (const r of report.residual) {
  console.log(
    `${r.id.padEnd(20)} ${r.outcome.padEnd(16)} ${r.verdict.padEnd(17)} ${formatUsd(r.sentCents).padEnd(10)} ${(r.shortfallCents === null ? 'n/a' : formatUsd(r.shortfallCents)).padEnd(10)} ${formatUsd(r.unauthorisedCents)}`,
  );
}
console.log('\nWrote redteam-report.json');
if (report.firewall.unauthorisedCents > 0) process.exitCode = 1;
