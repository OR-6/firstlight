/**
 * "Samaritan": a small donor agent (SPEC §5.6b). It is scripted, not an LLM.
 *
 * It discovers Firstlight from its manifest, uses the MCP tools to check its
 * allowance, the pool and the active relief events, donates within what its
 * allowance has left, prints the PayPal approval link for its human, waits for
 * the approval, then checks the receipt against the audit log twice: by
 * recomputing the hash chain itself from GET /api/audit, and by asking the
 * server's own /api/audit/verify.
 *
 * A person creates the allowance first, at /agents on the site, and hands
 * Samaritan the token:
 *
 *   FIRSTLIGHT_ALLOWANCE_TOKEN=alw_… npm run samaritan                    # local dev server
 *   FIRSTLIGHT_URL=https://… FIRSTLIGHT_ALLOWANCE_TOKEN=alw_… npm run samaritan
 *
 * Samaritan never sees a password or card: the human approves on PayPal. The
 * server, not Samaritan, decides its donor name (the allowance label) and cap.
 */
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { verifyChain, type PublicAuditEntry } from './verify-chain';

const BASE = (process.env.FIRSTLIGHT_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = process.env.FIRSTLIGHT_ALLOWANCE_TOKEN?.trim() ?? '';
const PREFERRED_GIFT_CENTS = 5_00;
const say = (s: string) => console.log(`samaritan: ${s}`);
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

type ToolResult = { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
function result<T>(r: ToolResult): T {
  if (r.isError) throw new Error(r.content?.find((c) => c.type === 'text')?.text ?? 'tool call failed');
  return (r.structuredContent ?? JSON.parse(r.content?.find((c) => c.type === 'text')?.text ?? '{}')) as T;
}
const cents = (usd: string) => Math.round(Number(usd) * 100);

async function main() {
  if (!TOKEN) {
    say(`no allowance. Ask a person to create one at ${BASE}/agents, then run:`);
    console.log('\n  FIRSTLIGHT_ALLOWANCE_TOKEN=alw_… npm run samaritan\n');
    process.exitCode = 1;
    return;
  }

  say(`reading ${BASE}/.well-known/firstlight.json`);
  const manifest = (await (await fetch(`${BASE}/.well-known/firstlight.json`)).json()) as {
    name: string;
    sandbox: boolean;
    endpoints: { mcp: string; auditEntries?: { url: string } };
    donations: { minUsd: number; maxUsd: number };
  };
  if (!manifest.sandbox) throw new Error('refusing: this demo agent only donates to sandbox deployments');
  say(`found ${manifest.name} (sandbox). MCP at ${manifest.endpoints.mcp}`);

  const client = new Client({ name: 'samaritan', version: '1.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(manifest.endpoints.mcp)));
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    say(`tools: ${tools.join(', ')}`);

    const allowance = result<{ label: string; status: string; capUsd: string; remainingUsd: string; expiresAt: string }>(
      (await client.callTool({ name: 'get_allowance', arguments: { allowance_token: TOKEN } })) as ToolResult,
    );
    say(`allowance "${allowance.label}": $${allowance.remainingUsd} left of $${allowance.capUsd}, ${allowance.status}, expires ${allowance.expiresAt}`);
    if (allowance.status !== 'active') {
      say('this allowance is not active, so not donating');
      return;
    }

    const pool = result<{ balanceUsd: string; recipientsReached: number }>((await client.callTool({ name: 'get_pool_status', arguments: {} })) as ToolResult);
    const { events } = result<{ events: { eventId: string; title: string; status: string }[] }>((await client.callTool({ name: 'list_active_events', arguments: {} })) as ToolResult);
    say(`pool holds $${pool.balanceUsd}; ${pool.recipientsReached} people paid so far`);
    const active = events.filter((e) => e.status !== 'awaiting_assessment');
    if (active.length === 0) {
      say('no active relief event, so not donating');
      return;
    }
    for (const e of active) say(`active: ${e.title} (${e.status.replaceAll('_', ' ')})`);

    const amountCents = Math.min(PREFERRED_GIFT_CENTS, cents(allowance.remainingUsd), manifest.donations.maxUsd * 100);
    if (amountCents < manifest.donations.minUsd * 100) {
      say(`only $${allowance.remainingUsd} left on the allowance, below the $${manifest.donations.minUsd} minimum, so not donating`);
      return;
    }
    say(`donating ${dollars(amountCents)} under allowance "${allowance.label}"`);
    const d = result<{ receiptId: string; approvalUrl: string; allowance: { remainingUsd: string } }>(
      (await client.callTool({
        name: 'create_donation',
        arguments: {
          amount_usd: amountCents / 100,
          allowance_token: TOKEN,
          message: `For ${active[0]!.title.split(' (')[0]}`,
          idempotency_key: `sam-${randomBytes(6).toString('hex')}`,
        },
      })) as ToolResult,
    );
    say(`allowance left after this: $${d.allowance.remainingUsd}`);

    console.log('\n  A person must approve this payment on PayPal (sandbox):');
    console.log(`  ${d.approvalUrl}\n`);
    say(`waiting for approval of ${d.receiptId}…`);

    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      const receipt = result<{
        status: string;
        amountUsd: string;
        audit: { captured: { seq: number; hash: string } | null };
        poolSummary: { totalDisbursedUsd: string; recipientsCount: number };
        paypal: { captureId: string | null };
        approval?: { bySamePayPalAccount: boolean | null; note: string };
        paypalConfirmed?: { status: string; amount: { value: string } | null; source: string; matchesReceipt: boolean } | null;
        paypalConfirmedReason?: string;
      }>((await client.callTool({ name: 'get_receipt', arguments: { receipt_id: d.receiptId } })) as ToolResult);
      if (receipt.status === 'CAPTURED' && receipt.audit.captured) {
        const entry = receipt.audit.captured;
        say(`received: $${receipt.amountUsd} is in the pool (audit entry #${entry.seq})`);
        const pc = receipt.paypalConfirmed;
        if (pc) {
          const via = pc.source === 'paypal_hosted_mcp' ? "PayPal's hosted MCP server" : "PayPal's Orders API";
          say(pc.matchesReceipt ? `PayPal itself (${via}) reports the order ${pc.status}, $${pc.amount?.value ?? '?'}, same capture as the receipt` : `WARNING: PayPal (${via}) reports something different from the receipt`);
        } else {
          say(`could not ask PayPal about the order just now (${receipt.paypalConfirmedReason ?? 'no reason given'})`);
        }
        if (receipt.approval) say(receipt.approval.note);
        if (receipt.paypal.captureId) say(`the person who approved can find capture ${receipt.paypal.captureId} in their own PayPal activity`);

        // 1. Recompute the chain myself from the public entries (algorithm: manifest receiptFormat.auditChain).
        const entriesUrl = manifest.endpoints.auditEntries?.url ?? `${BASE}/api/audit?limit=1000`;
        const log = (await (await fetch(entriesUrl)).json()) as { entries: PublicAuditEntry[] };
        const mine = verifyChain(log.entries, entry.hash);
        if (mine.ok) {
          say(
            `recomputed ${mine.checked} audit hashes myself: entry #${entry.seq} is intact ${mine.fromGenesis ? 'back to the first entry' : `back to the oldest entry fetched (#${entry.seq - mine.checked + 1}); older entries were not checked`}`,
          );
        } else {
          say(`WARNING: my own check of the audit chain failed: ${mine.reason}`);
        }

        // 2. The server's own check, for comparison.
        const check = (await (await fetch(`${BASE}/api/audit/verify?upTo=${entry.hash}`)).json()) as { ok: boolean; count: number };
        say(check.ok ? `the server's /api/audit/verify agrees: intact chain of ${check.count} entries` : "WARNING: the server's own audit check did not verify");

        say('this shows my donation is recorded in the audit log; it does not show where each dollar goes, because the pool is shared');
        say(`so far Firstlight has paid $${receipt.poolSummary.totalDisbursedUsd} to ${receipt.poolSummary.recipientsCount} people from the pool`);
        return;
      }
      if (receipt.status === 'PAYER_MISMATCH') {
        say('held: it was approved by a different PayPal account than the one my allowance is tied to, so it was not captured or credited');
        return;
      }
      if (['CANCELED', 'FAILED', 'DENIED'].includes(receipt.status)) {
        say(`donation ${receipt.status.toLowerCase()}; nothing was charged`);
        return;
      }
    }
    say('gave up waiting after 10 minutes; nothing is charged unless the approval completes');
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(`samaritan: ${(e as Error).message}`);
  process.exitCode = 1;
});
