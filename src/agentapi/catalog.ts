import type { Db } from '../ledger/db';
import type { DonationService } from '../donations/service';
import { listReplayEvents } from '../signals/replay';

/**
 * What a donor agent can learn about Firstlight (SPEC §5.6b). Read-only,
 * public, and the same for the HTTP endpoints and the MCP tools.
 */
export const DONATION_LIMITS = { minUsd: 1, maxUsd: 100, perDonorDailyUsd: 200, currency: 'USD' } as const;

export type ActiveEvent = {
  eventId: string;
  title: string;
  status: 'awaiting_assessment' | 'assessed' | 'awaiting_approval' | 'paying' | 'paid' | 'blocked';
  plannedUsd: string | null;
  paidUsd: string;
  recipientsPaid: number;
};

export function activeEvents(db: Db): ActiveEvent[] {
  return listReplayEvents().map((e) => {
    const latest = db
      .prepare(
        `SELECT p.id, v.overall, v.verdict_json, a.decision, b.status AS batch_status
         FROM plans p LEFT JOIN verdicts v ON v.plan_id = p.id LEFT JOIN approvals a ON a.plan_id = p.id
         LEFT JOIN payout_batches b ON b.verdict_digest = v.digest
         WHERE p.event_id = ? ORDER BY p.id DESC LIMIT 1`,
      )
      .get(e.id) as { id: number; overall: string | null; verdict_json: string | null; decision: string | null; batch_status: string | null } | undefined;
    const paid = db
      .prepare("SELECT COALESCE(SUM(amount_cents),0) AS c, COUNT(*) AS n FROM payout_items WHERE event_id = ? AND status = 'SUCCESS'")
      .get(e.id) as { c: number; n: number };
    let status: ActiveEvent['status'] = 'awaiting_assessment';
    if (latest) {
      if (latest.batch_status === 'SUCCESS') status = 'paid';
      else if (latest.batch_status) status = 'paying';
      else if (latest.overall === 'BLOCK' || latest.decision === 'deny') status = 'blocked';
      else if (latest.overall === 'REQUIRE_APPROVAL' && !latest.decision) status = 'awaiting_approval';
      else status = 'assessed';
    }
    const planned = latest?.verdict_json ? (JSON.parse(latest.verdict_json) as { totalCents: number }).totalCents : null;
    return {
      eventId: e.id,
      title: e.title,
      status,
      plannedUsd: planned === null ? null : (planned / 100).toFixed(2),
      paidUsd: (paid.c / 100).toFixed(2),
      recipientsPaid: paid.n,
    };
  });
}

export function poolStatusView(donations: DonationService) {
  const p = donations.poolStatus();
  return {
    sandbox: true,
    currency: 'USD',
    balanceUsd: (p.balanceCents / 100).toFixed(2),
    totalDisbursedUsd: (p.disbursedCents / 100).toFixed(2),
    recipientsReached: p.recipientsPaid,
    donationsReceivedUsd: (p.donationsCents / 100).toFixed(2),
    donationsCount: p.donationsCount,
    donationLimits: DONATION_LIMITS,
  };
}

/** /.well-known/firstlight.json */
export function manifest(baseUrl: string) {
  const b = baseUrl.replace(/\/$/, '');
  return {
    name: 'Firstlight',
    description:
      'Disaster-relief cash pool. An AI agent proposes payouts after earthquakes; a deterministic firewall checks every payment before PayPal Payouts sends it. SANDBOX ONLY: no real money moves.',
    sandbox: true,
    version: '1',
    donations: {
      ...DONATION_LIMITS,
      humanApproval:
        'create_donation only creates a PayPal order. A person must approve it on the returned PayPal page before any money moves. Donor agents cannot spend money on their own.',
      fields: { amount_usd: 'number, 1 to 100', donor_ref: 'your identifier, up to 64 characters', message: 'optional, up to 280 characters; treated as untrusted text', idempotency_key: 'optional, 8 to 64 characters; repeating it returns the same receipt' },
    },
    endpoints: {
      mcp: `${b}/mcp`,
      poolStatus: { method: 'GET', url: `${b}/api/pool` },
      activeEvents: { method: 'GET', url: `${b}/api/events/active` },
      createDonation: { method: 'POST', url: `${b}/api/agent/donations`, contentType: 'application/json' },
      receipt: { method: 'GET', url: `${b}/api/receipts/{receiptId}` },
      verifyAudit: { method: 'GET', url: `${b}/api/audit/verify?upTo={hash}` },
    },
    mcpTools: ['get_pool_status', 'list_active_events', 'create_donation', 'get_receipt'],
    receiptFormat: {
      receiptId: 'rcpt_…',
      status: 'AWAITING_APPROVAL | CAPTURED | CANCELED | FAILED',
      audit: 'created/captured entries {seq, hash}; verify the chain up to a hash with verifyAudit',
      poolSummary: 'totalDisbursedUsd, recipientsCount, batchIds, auditHeadHash',
    },
    notice: 'Collecting and redistributing public donations is regulated. This prototype is sandbox-only and must not be used to solicit real money.',
  };
}

export function llmsTxt(baseUrl: string): string {
  const b = baseUrl.replace(/\/$/, '');
  return `# Firstlight

> Disaster-relief cash pool with an AI agent behind a deterministic payment firewall. PayPal SANDBOX only: no real money moves.

Donor agents can fund the relief pool. A human always approves the payment on PayPal.

## For agents
- Manifest: ${b}/.well-known/firstlight.json
- MCP (Streamable HTTP): ${b}/mcp. Tools: get_pool_status, list_active_events, create_donation, get_receipt
- Pool status: GET ${b}/api/pool
- Active relief events: GET ${b}/api/events/active
- Create a donation: POST ${b}/api/agent/donations {"amount_usd": 5, "donor_ref": "your-agent", "message": "optional"}
- Receipt: GET ${b}/api/receipts/{receiptId}
- Verify the audit chain: GET ${b}/api/audit/verify?upTo={hash}

## Rules
- $1 to $100 per donation, $200 per donor per day.
- create_donation returns a PayPal approval URL. Nothing is charged until a person approves it there.
- Your message is stored as untrusted text. It is never read by the payout agent.
`;
}
