import type { Db } from '../ledger/db';
import { ALLOWANCE_LIMITS, ALLOWANCE_TOKEN_PATTERN } from '../donations/allowance';
import { RECEIPT_PROVES, type DonationService } from '../donations/service';
import { GENESIS_HASH } from '../ledger/audit';
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
    // Any batch for the event counts: a later re-assessment that R6 blocks doesn't undo a payout.
    const anyBatch = db.prepare('SELECT status FROM payout_batches WHERE event_id = ? ORDER BY id DESC LIMIT 1').get(e.id) as { status: string } | undefined;
    let status: ActiveEvent['status'] = 'awaiting_assessment';
    if (anyBatch && !latest?.batch_status) status = anyBatch.status === 'SUCCESS' ? 'paid' : 'paying';
    else if (latest) {
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
    version: '2',
    donations: {
      ...DONATION_LIMITS,
      humanApproval:
        'create_donation only creates a PayPal order. A person must approve it on the returned PayPal page before any money moves. Donor agents cannot spend money on their own.',
      fields: {
        amount_usd: 'number, 1 to 100, at most 2 decimals; must fit in what is left of your allowance',
        allowance_token: `required; ${ALLOWANCE_TOKEN_PATTERN}; created for you by a person`,
        message: 'optional, up to 280 characters; treated as untrusted text',
        idempotency_key: 'optional, 8 to 64 of A-Z a-z 0-9 _ -; repeating it under the same allowance returns the same receipt',
      },
      donorRef: 'Not sent by the agent. Agent donations are shown under the allowance label the person chose.',
    },
    allowances: {
      what: 'A person lets one agent donate up to a cap until an expiry. The server enforces the label, the cap and the expiry; each payment is still approved by a person on PayPal.',
      createPage: `${b}/agents`,
      create: { method: 'POST', url: `${b}/api/allowances`, body: { label: 'who the agent is, up to 64 characters', cap_usd: `${ALLOWANCE_LIMITS.minCapUsd} to ${ALLOWANCE_LIMITS.maxCapUsd}`, expires_in_hours: `${ALLOWANCE_LIMITS.minHours} to ${ALLOWANCE_LIMITS.maxHours}` } },
      revoke: { method: 'POST', url: `${b}/api/allowances/{allowanceId}/revoke`, body: { allowance_token: 'alw_…' }, note: 'Needs the token as well as the id. Donations still waiting for approval are cancelled.' },
      check: { method: 'POST', url: `${b}/api/agent/allowance`, body: { allowance_token: 'alw_…' } },
      remaining: 'cap minus donations under it that are being created, waiting for approval, pending at PayPal or received (refunded, denied, cancelled and failed ones do not count)',
      token: 'Shown once at creation; the server stores only its sha256. Never put it in a URL.',
    },
    endpoints: {
      mcp: `${b}/mcp`,
      poolStatus: { method: 'GET', url: `${b}/api/pool` },
      activeEvents: { method: 'GET', url: `${b}/api/events/active` },
      createDonation: { method: 'POST', url: `${b}/api/agent/donations`, contentType: 'application/json' },
      checkAllowance: { method: 'POST', url: `${b}/api/agent/allowance`, contentType: 'application/json' },
      receipt: { method: 'GET', url: `${b}/api/receipts/{receiptId}` },
      auditEntries: { method: 'GET', url: `${b}/api/audit?limit=1000` },
      verifyAudit: { method: 'GET', url: `${b}/api/audit/verify?upTo={hash}` },
    },
    mcpTools: ['get_pool_status', 'list_active_events', 'get_allowance', 'create_donation', 'get_receipt'],
    receiptFormat: {
      receiptId: 'rcpt_ followed by 16 hex characters',
      status: 'CREATING | AWAITING_APPROVAL | PENDING | CAPTURED | PARTIALLY_REFUNDED | REFUNDED | REVERSED | DENIED | CANCELED | FAILED',
      audit: 'created / captured entries {seq, hash} plus lifecycle entries (pending, refunded, reversed, denied, cancelled)',
      poolSummary: 'totalDisbursedUsd, recipientsCount, batchIds, auditHeadHash',
      whatItProves: RECEIPT_PROVES,
      auditChain: {
        howToVerify: `GET ${b}/api/audit?limit=1000 (newest first), sort by seq, then recompute every hash from seq 1 to the receipt's entry. Don't trust ${b}/api/audit/verify alone: it is the server checking itself.`,
        genesisPrevHash: GENESIS_HASH,
        entryHash: 'lowercase hex sha256 of the UTF-8 string prevHash + canonicalJson({"seq": seq, "ts": tsMs, "type": type, "payload": payload})',
        prevHash: "the previous entry's hash (genesisPrevHash for seq 1)",
        canonicalJson:
          'JSON with no whitespace; object keys sorted at every level by JavaScript default string order (UTF-16 code units); keys whose value is undefined are left out; strings and numbers written as JSON.stringify writes them. Payloads only hold strings, integers, booleans, null, arrays and objects.',
        checks: 'seq runs 1, 2, 3… with no gaps; each prevHash equals the previous hash; each hash matches its contents',
        reference: 'scripts/verify-chain.ts in the repository is a standalone implementation of this check (Samaritan uses it).',
      },
    },
    notice: 'Collecting and redistributing public donations is regulated. This prototype is sandbox-only and must not be used to solicit real money.',
  };
}

export function llmsTxt(baseUrl: string): string {
  const b = baseUrl.replace(/\/$/, '');
  return `# Firstlight

> Disaster-relief cash pool with an AI agent behind a deterministic payment firewall. PayPal SANDBOX only: no real money moves.

Donor agents can fund the relief pool, but only under an allowance a person gave them, and a person approves every payment on PayPal.

## For agents
- Manifest: ${b}/.well-known/firstlight.json
- MCP (Streamable HTTP): ${b}/mcp. Tools: get_pool_status, list_active_events, get_allowance, create_donation, get_receipt
- Allowance: a person creates one for you at ${b}/agents (label, cap $1 to $100, expiry 1 hour to 7 days) and gives you its alw_… token
- Pool status: GET ${b}/api/pool
- Active relief events: GET ${b}/api/events/active
- Check your allowance: POST ${b}/api/agent/allowance {"allowance_token": "alw_…"}
- Create a donation: POST ${b}/api/agent/donations {"amount_usd": 5, "allowance_token": "alw_…", "message": "optional"}
- Receipt: GET ${b}/api/receipts/{receiptId}
- Audit entries (recompute the hash chain yourself): GET ${b}/api/audit?limit=1000. Algorithm: manifest receiptFormat.auditChain
- Server-side chain check: GET ${b}/api/audit/verify?upTo={hash}

## Rules
- $1 to $100 per donation, $200 per donor per day, and never more than what is left of your allowance.
- Your donor name is your allowance's label. You don't send donor_ref.
- create_donation returns a PayPal approval URL. Nothing is charged until a person approves it there.
- Your message is stored as untrusted text. It is never read by the payout agent.
- A receipt shows your donation is in the audit log and what the pool has paid out. It does not show where each dollar went: the pool is shared.
`;
}
