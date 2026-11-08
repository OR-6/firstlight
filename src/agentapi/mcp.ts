import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../ledger/db';
import { ALLOWANCE_TOKEN_PATTERN } from '../donations/allowance';
import { DonationError, type DonationService } from '../donations/service';
import { activeEvents, DONATION_LIMITS, poolStatusView, RECEIPT_STATUSES } from './catalog';

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
  handle: z.string().describe('Short public id shown next to your label in the donation feed, e.g. alid_3f9c2a.'),
  paypalAccount: z.object({
    tied: z.boolean().describe('True once the first donation approved on PayPal tied this allowance to that PayPal account.'),
    heldForOtherAccount: z.number().int().describe('Donations approved by a different PayPal account: held, never credited.'),
    note: z.string(),
  }),
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
  status: z.string().describe(RECEIPT_STATUSES),
  source: z.enum(['human', 'agent']),
  amountUsd: usd,
  refundedUsd: usd,
  currency: z.literal('USD'),
  donorRef: z.string(),
  allowanceId: z.string().nullable(),
  agentHandle: z.string().nullable(),
  approval: z.object({
    bySamePayPalAccount: z.boolean().nullable().describe('Agent donations: approved by the PayPal account this allowance is tied to. null if not approved yet or not an agent donation.'),
    note: z.string(),
  }),
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
  paypalConfirmed: z
    .object({
      status: z.string().describe('PayPal order status, e.g. COMPLETED'),
      captureId: z.string().nullable(),
      captureStatus: z.string().nullable(),
      amount: z.object({ currency: z.literal('USD'), value: z.string() }).nullable(),
      checkedAt: z.string(),
      source: z.enum(['paypal_hosted_mcp', 'paypal_orders_api']).describe("Which PayPal interface answered: PayPal's hosted MCP server (get_order) or the Orders v2 API."),
      matchesReceipt: z.boolean().describe('PayPal reports the same capture id and amount as this receipt.'),
      fallbackReason: z.string().optional(),
    })
    .nullable()
    .describe('What PayPal itself reports for this order when the receipt was fetched (cached up to 30 s). null if PayPal could not be asked; see paypalConfirmedReason.'),
  paypalConfirmedReason: z.string().optional(),
});

export function buildMcpServer(deps: { db: Db; donations: DonationService }): McpServer {
  const server = new McpServer(
    { name: 'firstlight', version: '1.2.0' },
    {
      instructions:
        'Firstlight is a disaster-relief pool running in the PayPal SANDBOX (no real money). You can check the pool and active relief events without credentials. To donate you need an allowance_token that a person created for you at /agents: it sets who you are (its label becomes your donor name), a cap and an expiry, and the server enforces them. create_donation returns a PayPal approval URL: a person must open it and approve before anything is charged. The first approval ties the allowance to that PayPal account; a donation approved by any other account is held and never credited. get_receipt shows what PayPal itself reports for the order.',
    },
  );
  const ok = <T extends Record<string, unknown>>(v: T) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }], structuredContent: v });
  // Refusals always start with a typed CODE, so an agent can branch on it.
  const fail = (code: string, message: string) => ({ isError: true, content: [{ type: 'text' as const, text: `${code}: ${message}` }] });
  const PERSON = ' Donating needs a person: they create your allowance at /agents and approve each payment on PayPal.';

  server.registerTool(
    'get_pool_status',
    {
      title: 'Pool status',
      description: 'Relief pool balance, total disbursed, recipients reached and donation limits. Read-only.' + PERSON,
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
      description: 'Current earthquake relief events and where their payouts stand. Read-only.' + PERSON,
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
      description:
        'What your allowance lets you do: label (your donor name), cap, how much is committed and left, expiry, whether it is active, and whether it is tied to one PayPal account (the first approval ties it; approvals by any other account are held, not credited). Read-only. Only the person who created the allowance can revoke it, at /agents.',
      inputSchema: z.strictObject({ allowance_token: allowanceToken }),
      outputSchema: allowanceOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ allowance_token }) => {
      const a = deps.donations.allowanceForToken(allowance_token);
      return a ? ok(a) : fail('ALLOWANCE_UNKNOWN', 'That allowance_token is not valid. Ask your person for a new one at /agents.');
    },
  );

  server.registerTool(
    'create_donation',
    {
      title: 'Create a donation',
      description:
        'Create a PayPal sandbox order for a donation of 1 to 100 USD under your allowance. Your donor name is the allowance label. Returns orderId, approvalUrl and receiptId. Nothing is charged until a person opens approvalUrl and approves it on PayPal, with the same PayPal account as earlier donations under this allowance. Refusals start with a code, e.g. ALLOWANCE_EXCEEDED.',
      inputSchema: createDonationInput,
      outputSchema: createOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const d = await deps.donations.create(args, 'agent');
        if (!d.allowance) return fail('INTERNAL', 'Could not create the donation. Try again later.');
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
        if (e instanceof DonationError) return fail(e.code, e.message);
        return fail('INTERNAL', 'Could not create the donation. Try again later.');
      }
    },
  );

  server.registerTool(
    'get_receipt',
    {
      title: 'Get a receipt',
      description:
        'Donation status, what PayPal itself reports for the order (paypalConfirmed), whether it was approved by the PayPal account your allowance is tied to, audit-log entries you can verify yourself (see receiptFormat.auditChain in the manifest), and pool totals. While status is AWAITING_APPROVAL, a person still has to approve it on PayPal. It does not show where each dollar went: the pool is shared.',
      inputSchema: z.strictObject({
        receipt_id: receiptIdField.optional().describe('The receiptId returned by create_donation.'),
        receiptId: receiptIdField.optional().describe('Same as receipt_id (either spelling works).'),
      }),
      outputSchema: receiptOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ receipt_id, receiptId }) => {
      const id = receipt_id ?? receiptId;
      if (!id) return fail('INVALID_REQUEST', 'Pass receipt_id (the receiptId returned by create_donation).');
      const r = await deps.donations.receiptWithPayPal(id);
      return r ? ok(r) : fail('NOT_FOUND', 'No donation with that receipt.');
    },
  );

  // Stateless server, fixed tool list: don't advertise list-change notifications we never send.
  server.server.registerCapabilities({ tools: { listChanged: false } });
  return server;
}
