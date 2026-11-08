/**
 * PayPal sandbox smoke test (SPEC §13 M1). Reads credentials from .env.
 *
 *   npm run paypal:check                  # get an OAuth token only; no money moves
 *   npm run smoke:payout -- --send        # send $1.00 (sandbox) to PAYPAL_SMOKE_RECEIVER
 *
 * Never prints tokens or secrets.
 */
import { randomUUID } from 'node:crypto';
import { PayPalApiError, PayPalClient, loadPayPalConfig } from '../src/paypal/client';
import { TERMINAL_BATCH_STATUSES, buildPayoutBatchBody, createPayoutBatch, getPayoutBatch } from '../src/paypal/payouts';

const args = new Set(process.argv.slice(2));
const client = new PayPalClient(loadPayPalConfig());

async function main() {
  const token = await client.getToken();
  const scopes = token.scope.split(/\s+/).filter(Boolean);
  const payoutScope = scopes.some((s) => s.includes('/payouts'));
  console.log(`✓ OAuth token OK (sandbox, app_id ${token.appId ?? 'unknown'}, ${scopes.length} scopes)`);
  console.log(`${payoutScope ? '✓' : '✗'} Payouts scope ${payoutScope ? 'present' : 'MISSING — enable Payouts on the sandbox app'}`);

  if (!args.has('--send')) {
    console.log('\nCheck only. Re-run with --send to send $1.00 (sandbox).');
    return;
  }

  const receiver = process.env.PAYPAL_SMOKE_RECEIVER?.trim();
  if (!receiver) throw new Error('Set PAYPAL_SMOKE_RECEIVER in .env to a sandbox PERSONAL account email');

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const body = buildPayoutBatchBody({
    senderBatchId: `firstlight-smoke-${stamp}`,
    emailSubject: 'Firstlight sandbox smoke test',
    emailMessage: 'SANDBOX test payout. No real money moves.',
    items: [{ receiverEmail: receiver, amountCents: 100, note: 'Firstlight sandbox smoke test ($1).', senderItemId: `smoke:${stamp}` }],
  });
  const created = await createPayoutBatch(client, body, randomUUID());
  const batchId = created.body.batch_header.payout_batch_id;
  console.log(`\n→ Payout batch created: ${batchId} (status ${created.body.batch_header.batch_status}, debug_id ${created.debugId})`);

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const { body: b } = await getPayoutBatch(client, batchId);
    const item = b.items?.[0];
    const line = `  batch ${b.batch_header.batch_status}; item ${item?.transaction_status ?? '?'}${item?.errors?.name ? ` (${item.errors.name})` : ''}`;
    console.log(line);
    const done = (TERMINAL_BATCH_STATUSES as readonly string[]).includes(b.batch_header.batch_status);
    if (done && item?.transaction_status && item.transaction_status !== 'PENDING') {
      const ok = b.batch_header.batch_status === 'SUCCESS' && item.transaction_status === 'SUCCESS';
      console.log(ok ? `\n✓ $1.00 delivered to ${receiver} (transaction ${item.transaction_id})` : '\n✗ Payout did not succeed — see statuses above');
      if (!ok) process.exitCode = 1;
      return;
    }
  }
  console.log('\n… still processing after 60 s. Re-check later with the batch id above.');
}

main().catch((err) => {
  if (err instanceof PayPalApiError) {
    console.error(`✗ ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
  } else {
    console.error(`✗ ${(err as Error).message}`);
  }
  process.exitCode = 1;
});
