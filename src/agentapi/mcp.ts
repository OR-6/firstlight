import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../ledger/db';
import { ALLOWANCE_TOKEN_PATTERN } from '../donations/allowance';
import { DonationError, type DonationService } from '../donations/service';
import { activeEvents, DONATION_LIMITS, poolStatusView } from './catalog';

/**
 * Firstlight's MCP server for donor agents (SPEC §5.6b): five tools, all
 * read-only except create_donation, which only creates a PayPal order that a
 * person must approve, and only under an allowance a person created.
 * Every agent-supplied string is untrusted data.
 *
 * Input schemas advertise the same limits the server enforces; every tool
 * declares an outputSchema and returns structuredContent. Arguments are
 * snake_case.
 */

// ── input schemas (mirror src/donations/policy.ts and allowance.ts) ────────

const allowanceToken = z
  .string()
  .regex(new RegExp(ALLOWANCE_TOKEN_PATTERN))
  .describe('The alw_… token a person created for you at /agents. Treat it like a password; never put it in a URL.');
const receiptIdField = z.string().regex(/^rcpt_[0-9a-f]{16}$/);

const createDonationInput = z.strictObject({
  amount_usd: z.number().min(DONATION_LIMITS.minUsd).max(DONATION_LIMITS.maxUsd).multipleOf(0.01).describe('Amount in USD, 1 to 100, at most 2 decimals. Must also fit in what is left of your allowance.'),
  allowance_token: allowanceToken,
  message: z.string().max(280).optional().describe('Optional message shown in the public feed, up to 280 characters. Stored as untrusted text; never read by the payout agent.'),
  idempotency_key: z
    .string()
    .min(8)
    .max(64)
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional()
    .describe('Optional, 8 to 64 of A-Z a-z 0-9 _ -. Repeating it under the same allowance returns the same receipt and creates no new order.'),
});

// ── output schemas ─────────────────────────────────────────────────────────

const usd = z.string().regex(/^-?\d+\.\d{2}$/);
const auditRef = z.object({ seq: z.number().int(), hash: z.string() }).nullable();

const poolOutput = z.object({
  sandbox: z.literal(true),
  currency: z.literal('USD'),
  balanceUsd: usd,
  totalDisbursedUsd: usd,
  recipientsReached: z.number().int(),
  donationsReceivedUsd: usd,
  donationsCount: z.number().int(),
  donationLimits: z.object({ minUsd: z.number(), maxUsd: z.number(), perDonorDailyUsd: z.number(), currency: z.literal('USD') }),
});

const eventsOutput = z.object({
  events: z.array(
    z.object({
      eventId: z.string(),
      title: z.string(),
      status: z.enum(['awaiting_assessment', 'assessed', 'awaiting_approval', 'paying', 'paid', 'blocked']),
      plannedUsd: usd.nullable(),
      paidUsd: usd,
      recipientsPaid: z.number().int(),
    }),
  ),
});

const allowanceOutput = z.object({
  allowanceId: z.string(),
  label: z.string(),
  status: z.enum(['active', 'revoked', 'expired', 'used_up']),
  capUsd: usd,
  committedUsd: usd.describe('Waiting for approval or received under this allowance.'),
  remainingUsd: usd,
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
});

const createOutput = z.object({
  receiptId: z.string(),
  orderId: z.string(),
  approvalUrl: z.string(),
  amountUsd: usd,
  status: z.string(),
  replayed: z.boolean(),
  allowance: allowanceOutput,
  next: z.string(),
});

const receiptOutput = z.object({
  receiptId: z.string(),
  status: z.string().describe('CREATING | AWAITING_APPROVAL | PENDING | CAPTURED | PARTIALLY_REFUNDED | REFUNDED | REVERSED | DENIED | CANCELED | FAILED'),
  source: z.enum(['human', 'agent']),
  amountUsd: usd,
  refundedUsd: usd,
  currency: z.literal('USD'),
  donorRef: z.string(),
  allowanceId: z.string().nullable(),
  createdAt: z.string(),
  capturedAt: z.string().nullable(),
  paypal: z.object({ orderId: z.string().nullable(), captureId: z.string().nullable(), environment: z.literal('sandbox') }),
  audit: z.object({
    created: auditRef,
    captured: auditRef,
    lifecycle: z.array(z.object({ type: z.string(), seq: z.number().int(), hash: z.string() })),
    headHash: z.string(),
    verifyUrl: z.string().nullable(),
    entriesUrl: z.string(),
  }),
  poolSummary: z.object({ totalDisbursedUsd: usd, recipientsCount: z.number().int(), batchIds: z.array(z.string()), auditHeadHash: z.string() }),
  whatThisProves: z.string(),
  sandbox: z.literal(true),
});

export function buildMcpServer(deps: { db: Db; donations: DonationService }): McpServer {
  const server = new McpServer(
    { name: 'firstlight', version: '1.1.0' },
    {
      instructions:
        'Firstlight is a disaster-relief pool running in the PayPal SANDBOX (no real money). You can check the pool and active relief events without credentials. To donate you need an allowance_token that a person created for you at /agents: it sets who you are (its label becomes your donor name), a cap and an expiry, and the server enforces them. create_donation returns a PayPal approval URL: a person must open it and approve before anything is charged.',
    },
  );
  const ok = <T extends Record<string, unknown>>(v: T) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }], structuredContent: v });
  const fail = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });

  server.registerTool(
    'get_pool_status',
    {
      title: 'Pool status',
      description: 'Relief pool balance, total disbursed, recipients reached and donation limits.',
      inputSchema: z.strictObject({}),
      outputSchema: poolOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ok(poolStatusView(deps.donations)),
  );

  server.registerTool(
    'list_active_events',
    {
      title: 'Active relief events',
      description: 'Current earthquake relief events and where their payouts stand.',
      inputSchema: z.strictObject({}),
      outputSchema: eventsOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ok({ events: activeEvents(deps.db) }),
  );

  server.registerTool(
    'get_allowance',
    {
      title: 'Check your allowance',
      description: 'What your allowance lets you do: label (your donor name), cap, how much is committed and left, expiry, and whether it is active.',
      inputSchema: z.strictObject({ allowance_token: allowanceToken }),
      outputSchema: allowanceOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ allowance_token }) => {
      const a = deps.donations.allowanceForToken(allowance_token);
      return a ? ok(a) : fail('ALLOWANCE_UNKNOWN: That allowance_token is not valid. Ask your person for a new one at /agents.');
    },
  );

  server.registerTool(
    'create_donation',
    {
      title: 'Create a donation',
      description:
        'Create a PayPal sandbox order for a donation of 1 to 100 USD under your allowance. Your donor name is the allowance label. Returns orderId, approvalUrl and receiptId. Nothing is charged until a person approves it at approvalUrl.',
      inputSchema: createDonationInput,
      outputSchema: createOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const d = await deps.donations.create(args, 'agent');
        if (!d.allowance) return fail('Could not create the donation. Try again later.');
        return ok({
          receiptId: d.receiptId,
          orderId: d.orderId,
          approvalUrl: d.approvalUrl,
          amountUsd: d.amountUsd,
          status: d.status,
          replayed: d.replayed,
          allowance: d.allowance,
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
      description:
        'Donation status, audit-log entries you can verify yourself (see receiptFormat.auditChain in the manifest), and pool totals. It does not show where each dollar went: the pool is shared.',
      inputSchema: z.strictObject({
        receipt_id: receiptIdField.optional().describe('The receiptId returned by create_donation.'),
        receiptId: receiptIdField.optional().describe('Same as receipt_id (either spelling works).'),
      }),
      outputSchema: receiptOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ receipt_id, receiptId }) => {
      const id = receipt_id ?? receiptId;
      if (!id) return fail('Pass receipt_id (the receiptId returned by create_donation).');
      const r = deps.donations.receipt(id);
      return r ? ok(r) : fail('No donation with that receipt.');
    },
  );

  // Stateless server, fixed tool list: don't advertise list-change notifications we never send.
  server.server.registerCapabilities({ tools: { listChanged: false } });
  return server;
}
