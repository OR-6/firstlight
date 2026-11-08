/**
 * "Samaritan": a small donor agent (SPEC §5.6b). It is scripted, not an LLM.
 *
 * It discovers Firstlight from its manifest, uses the MCP tools to check the
 * pool and the active relief events, donates within an allowance its human
 * set, prints the PayPal approval link for that human, waits for the
 * approval, then fetches the receipt and verifies it against the audit log.
 *
 *   npm run samaritan                                   # local dev server
 *   FIRSTLIGHT_URL=https://… SAMARITAN_ALLOWANCE_USD=20 npm run samaritan
 *
 * Samaritan never sees a password or card: the human approves on PayPal.
 */
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = (process.env.FIRSTLIGHT_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const ALLOWANCE = Number(process.env.SAMARITAN_ALLOWANCE_USD ?? 20);
const PREFERRED_GIFT = 5;
const say = (s: string) => console.log(`samaritan: ${s}`);

type ToolText = { content?: { type: string; text?: string }[]; isError?: boolean };
const parse = <T>(r: ToolText): T => JSON.parse(r.content?.find((c) => c.type === 'text')?.text ?? '{}') as T;

async function main() {
  say(`reading ${BASE}/.well-known/firstlight.json`);
  const manifest = (await (await fetch(`${BASE}/.well-known/firstlight.json`)).json()) as {
    name: string;
    sandbox: boolean;
    endpoints: { mcp: string };
    donations: { minUsd: number; maxUsd: number };
  };
  if (!manifest.sandbox) throw new Error('refusing: this demo agent only donates to sandbox deployments');
  say(`found ${manifest.name} (sandbox). MCP at ${manifest.endpoints.mcp}`);

  const client = new Client({ name: 'samaritan', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(manifest.endpoints.mcp)));
  const tools = (await client.listTools()).tools.map((t) => t.name);
  say(`tools: ${tools.join(', ')}`);

  const pool = parse<{ balanceUsd: string; recipientsReached: number }>((await client.callTool({ name: 'get_pool_status', arguments: {} })) as ToolText);
  const { events } = parse<{ events: { eventId: string; title: string; status: string }[] }>(
    (await client.callTool({ name: 'list_active_events', arguments: {} })) as ToolText,
  );
  say(`pool holds $${pool.balanceUsd}; ${pool.recipientsReached} people paid so far`);
  const active = events.filter((e) => e.status !== 'awaiting_assessment');
  if (active.length === 0) {
    say('no active relief event, so not donating');
    return;
  }
  for (const e of active) say(`active: ${e.title} (${e.status.replaceAll('_', ' ')})`);

  const amount = Math.min(PREFERRED_GIFT, ALLOWANCE, manifest.donations.maxUsd);
  if (amount < manifest.donations.minUsd) {
    say(`allowance $${ALLOWANCE} is below the $${manifest.donations.minUsd} minimum, so not donating`);
    return;
  }
  say(`donating $${amount.toFixed(2)} (allowance $${ALLOWANCE.toFixed(2)})`);
  const created = (await client.callTool({
    name: 'create_donation',
    arguments: {
      amount_usd: amount,
      donor_ref: 'samaritan-agent',
      message: `For ${active[0]!.title.split(' (')[0]}`,
      idempotency_key: `sam-${randomBytes(6).toString('hex')}`,
    },
  })) as ToolText;
  if (created.isError) throw new Error(created.content?.[0]?.text ?? 'create_donation failed');
  const d = parse<{ receiptId: string; approvalUrl: string }>(created);

  console.log('\n  A person must approve this payment on PayPal (sandbox):');
  console.log(`  ${d.approvalUrl}\n`);
  say(`waiting for approval of ${d.receiptId}…`);

  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const receipt = parse<{
      status: string;
      amountUsd: string;
      audit: { captured: { seq: number; hash: string } | null };
      poolSummary: { totalDisbursedUsd: string; recipientsCount: number; auditHeadHash: string };
    }>((await client.callTool({ name: 'get_receipt', arguments: { receiptId: d.receiptId } })) as ToolText);
    if (receipt.status === 'CAPTURED' && receipt.audit.captured) {
      say(`received: $${receipt.amountUsd} is in the pool (audit entry #${receipt.audit.captured.seq})`);
      const check = (await (await fetch(`${BASE}/api/audit/verify?upTo=${receipt.audit.captured.hash}`)).json()) as { ok: boolean; count: number };
      say(check.ok ? `verified: entry #${receipt.audit.captured.seq} is in an intact chain of ${check.count} entries` : 'WARNING: the audit chain did not verify');
      say(`so far Firstlight has paid $${receipt.poolSummary.totalDisbursedUsd} to ${receipt.poolSummary.recipientsCount} people`);
      await client.close();
      return;
    }
    if (receipt.status === 'CANCELED' || receipt.status === 'FAILED') {
      say(`donation ${receipt.status.toLowerCase()}; nothing was charged`);
      await client.close();
      return;
    }
  }
  say('gave up waiting after 10 minutes; nothing is charged unless the approval completes');
  await client.close();
}

main().catch((e) => {
  console.error(`samaritan: ${(e as Error).message}`);
  process.exitCode = 1;
});
