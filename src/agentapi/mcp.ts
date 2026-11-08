import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../ledger/db';
import { DonationError, type DonationService } from '../donations/service';
import { activeEvents, poolStatusView } from './catalog';

/**
 * Firstlight's MCP server for donor agents (SPEC §5.6b): four tools, all
 * read-only except create_donation, which only creates a PayPal order that a
 * person must approve. Every agent-supplied string is untrusted data.
 */
export function buildMcpServer(deps: { db: Db; donations: DonationService }): McpServer {
  const server = new McpServer(
    { name: 'firstlight', version: '1.0.0' },
    {
      instructions:
        'Firstlight is a disaster-relief pool running in the PayPal SANDBOX (no real money). You can check the pool, see active relief events, and create a donation. create_donation returns a PayPal approval URL: a human must open it and approve before anything is charged.',
    },
  );
  const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }], structuredContent: v as Record<string, unknown> });
  const fail = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });

  server.registerTool(
    'get_pool_status',
    { title: 'Pool status', description: 'Relief pool balance, total disbursed, recipients reached and donation limits.', annotations: { readOnlyHint: true } },
    async () => json(poolStatusView(deps.donations)),
  );

  server.registerTool(
    'list_active_events',
    { title: 'Active relief events', description: 'Current earthquake relief events and where their payouts stand.', annotations: { readOnlyHint: true } },
    async () => json({ events: activeEvents(deps.db) }),
  );

  server.registerTool(
    'create_donation',
    {
      title: 'Create a donation',
      description:
        'Create a PayPal sandbox order for a donation of 1 to 100 USD. Returns orderId, approvalUrl and receiptId. Nothing is charged until a person approves it at approvalUrl.',
      inputSchema: {
        amount_usd: z.number().describe('Amount in USD, 1 to 100.'),
        donor_ref: z.string().describe('Your identifier, up to 64 characters.'),
        message: z.string().optional().describe('Optional message, up to 280 characters.'),
        idempotency_key: z.string().optional().describe('Optional; repeating it returns the same receipt.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const d = await deps.donations.create(args, 'agent');
        return json({
          receiptId: d.receiptId,
          orderId: d.orderId,
          approvalUrl: d.approvalUrl,
          amountUsd: d.amountUsd,
          status: d.status,
          replayed: d.replayed,
          next: 'Ask a person to open approvalUrl and approve the payment on PayPal, then call get_receipt.',
        });
      } catch (e) {
        if (e instanceof DonationError) return fail(`${e.code}: ${e.message}`);
        return fail('Could not create the donation. Try again later.');
      }
    },
  );

  server.registerTool(
    'get_receipt',
    {
      title: 'Get a receipt',
      description: 'Donation status plus audit-log references you can verify, and a summary of payouts so far.',
      inputSchema: { receiptId: z.string().regex(/^rcpt_[0-9a-f]{16}$/).describe('The receiptId returned by create_donation.') },
      annotations: { readOnlyHint: true },
    },
    async ({ receiptId }) => {
      const r = deps.donations.receipt(receiptId);
      return r ? json(r) : fail('No donation with that receipt.');
    },
  );

  return server;
}
