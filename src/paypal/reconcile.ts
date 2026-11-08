import { normaliseItemStatus } from '../ledger/ledger';
import { PayPalApiError, type PayPalClient } from './client';
import { TERMINAL_BATCH_STATUSES, getPayoutBatch, type PayoutBatchDetails } from './payouts';
import { toCents, type PayPalReporting, type ReportedTransaction } from './reporting';

/**
 * Read-only reconciliation: does our ledger agree with PayPal?
 *  1. Payouts: GET the batch and compare every item's amount, status and
 *     transaction id, plus the batch status and total.
 *  2. Transaction Search (only if the app has the scope): look up the items'
 *     transaction ids. PayPal says it can take up to three hours for a
 *     transaction to be indexed, so a missing id younger than that is
 *     "not indexed yet", not a mismatch.
 * Nothing is written anywhere; nothing throws for one batch's failure.
 */

export type LedgerBatchInput = {
  batchId: number;
  eventId: string;
  paypalBatchId: string | null;
  status: string;
  createdMs: number;
  items: { recipientId: string; amountCents: number; status: string; paypalItemId: string | null; transactionId: string | null }[];
};

export type Difference = {
  /** null for batch-level differences. */
  recipientId: string | null;
  field: 'batch_status' | 'batch_total' | 'missing_at_paypal' | 'missing_in_ledger' | 'amount' | 'currency' | 'status' | 'transaction_id' | 'search_status' | 'search_amount' | 'search_missing';
  ledger: string | null;
  paypal: string | null;
};

export type SearchState =
  | { state: 'matches'; indexed: number }
  | { state: 'not_indexed_yet'; indexed: number; waiting: number }
  | { state: 'differences'; indexed: number }
  | { state: 'nothing_to_check' }
  | { state: 'missing_scope' | 'unavailable'; detail: string };

export type BatchReconciliation = {
  batchId: number;
  paypalBatchId: string | null;
  /** matches: everything agrees. in_progress: PayPal hasn't finished the batch. */
  state: 'matches' | 'differences' | 'in_progress' | 'not_submitted' | 'unavailable';
  checkedMs: number;
  items: number;
  paypalBatchStatus: string | null;
  feesCents: number | null;
  differences: Difference[];
  transactionSearch: SearchState;
  detail: string | null;
};

/** PayPal: "It takes a maximum of three hours for executed transactions to appear". */
export const SEARCH_INDEX_LAG_MS = 3 * 3_600_000;

/** Pure: compare the ledger's view of one batch with PayPal's batch GET. */
export function compareBatch(ledger: LedgerBatchInput, paypal: PayoutBatchDetails): { differences: Difference[]; terminal: boolean; feesCents: number | null } {
  const diffs: Difference[] = [];
  const header = paypal.batch_header;
  if (header.batch_status !== ledger.status) diffs.push({ recipientId: null, field: 'batch_status', ledger: ledger.status, paypal: header.batch_status });

  const ledgerTotal = ledger.items.reduce((t, i) => t + i.amountCents, 0);
  const paypalTotal = toCents(header.amount?.value);
  if (paypalTotal !== null && paypalTotal !== ledgerTotal) diffs.push({ recipientId: null, field: 'batch_total', ledger: dollars(ledgerTotal), paypal: header.amount!.value });

  const bySender = new Map<string, NonNullable<PayoutBatchDetails['items']>[number]>();
  for (const it of paypal.items ?? []) if (it.payout_item.sender_item_id) bySender.set(it.payout_item.sender_item_id, it);
  const seen = new Set<string>();
  for (const li of ledger.items) {
    const sid = `${ledger.eventId}:${li.recipientId}`;
    seen.add(sid);
    const pi = bySender.get(sid);
    if (!pi) {
      diffs.push({ recipientId: li.recipientId, field: 'missing_at_paypal', ledger: dollars(li.amountCents), paypal: null });
      continue;
    }
    const amount = toCents(pi.payout_item.amount?.value);
    if (amount !== null && amount !== li.amountCents) diffs.push({ recipientId: li.recipientId, field: 'amount', ledger: dollars(li.amountCents), paypal: pi.payout_item.amount!.value });
    const currency = pi.payout_item.amount?.currency;
    if (currency && currency !== 'USD') diffs.push({ recipientId: li.recipientId, field: 'currency', ledger: 'USD', paypal: currency });
    const status = normaliseItemStatus(pi.transaction_status).status;
    if (pi.transaction_status !== undefined && status !== li.status) diffs.push({ recipientId: li.recipientId, field: 'status', ledger: li.status, paypal: pi.transaction_status });
    if ((pi.transaction_id ?? null) !== li.transactionId && pi.transaction_id) diffs.push({ recipientId: li.recipientId, field: 'transaction_id', ledger: li.transactionId, paypal: pi.transaction_id });
  }
  for (const [sid, pi] of bySender) {
    if (!seen.has(sid)) diffs.push({ recipientId: sid.split(':')[1] ?? sid, field: 'missing_in_ledger', ledger: null, paypal: pi.payout_item.amount?.value ?? null });
  }
  const terminal = (TERMINAL_BATCH_STATUSES as readonly string[]).includes(header.batch_status);
  return { differences: diffs, terminal, feesCents: toCents(header.fees?.value) };
}

/** Pure: compare successful items with what Transaction Search returned. */
export function compareSearch(
  ledger: LedgerBatchInput,
  found: readonly ReportedTransaction[],
  now: number,
): { state: SearchState; differences: Difference[] } {
  const paid = ledger.items.filter((i) => i.status === 'SUCCESS' && i.transactionId);
  if (paid.length === 0) return { state: { state: 'nothing_to_check' }, differences: [] };
  const byId = new Map<string, ReportedTransaction[]>();
  for (const t of found) byId.set(t.transactionId, [...(byId.get(t.transactionId) ?? []), t]);
  const diffs: Difference[] = [];
  let indexed = 0;
  let waiting = 0;
  for (const i of paid) {
    const hits = byId.get(i.transactionId!) ?? [];
    if (hits.length === 0) {
      if (now - ledger.createdMs < SEARCH_INDEX_LAG_MS) waiting++;
      else diffs.push({ recipientId: i.recipientId, field: 'search_missing', ledger: i.transactionId, paypal: null });
      continue;
    }
    indexed++;
    // An id can appear twice in reporting (balance-affecting and not); any agreeing record will do.
    if (!hits.some((h) => h.amountCents === null || h.amountCents === i.amountCents)) {
      diffs.push({ recipientId: i.recipientId, field: 'search_amount', ledger: dollars(i.amountCents), paypal: hits[0]!.amountCents === null ? null : dollars(hits[0]!.amountCents) });
    }
    if (!hits.some((h) => h.status === null || h.status === 'S')) diffs.push({ recipientId: i.recipientId, field: 'search_status', ledger: 'SUCCESS', paypal: hits[0]!.status });
  }
  if (diffs.length > 0) return { state: { state: 'differences', indexed }, differences: diffs };
  if (waiting > 0) return { state: { state: 'not_indexed_yet', indexed, waiting }, differences: [] };
  return { state: { state: 'matches', indexed }, differences: [] };
}

/** Reconcile one batch against PayPal. Never throws. */
export async function reconcileBatch(
  ledger: LedgerBatchInput,
  paypal: PayPalClient,
  reporting: PayPalReporting | null,
  now: number,
): Promise<BatchReconciliation> {
  const base = {
    batchId: ledger.batchId,
    paypalBatchId: ledger.paypalBatchId,
    checkedMs: now,
    items: ledger.items.length,
    paypalBatchStatus: null,
    feesCents: null,
    differences: [] as Difference[],
    detail: null,
  };
  if (!ledger.paypalBatchId) {
    return { ...base, state: 'not_submitted', transactionSearch: { state: 'nothing_to_check' }, detail: 'PayPal has not accepted this batch, so there is nothing to compare yet.' };
  }
  let details: PayoutBatchDetails;
  try {
    details = (await getPayoutBatch(paypal, ledger.paypalBatchId)).body;
  } catch (err) {
    const why = err instanceof PayPalApiError ? `HTTP ${err.status}${err.paypalName ? ` ${err.paypalName}` : ''}` : String((err as Error)?.message ?? err).slice(0, 160);
    return { ...base, state: 'unavailable', transactionSearch: { state: 'nothing_to_check' }, detail: `Couldn't read this batch from PayPal (${why}).` };
  }
  const batch = compareBatch(ledger, details);

  let search: SearchState = { state: 'nothing_to_check' };
  let searchDiffs: Difference[] = [];
  const ids = ledger.items.filter((i) => i.status === 'SUCCESS' && i.transactionId).map((i) => i.transactionId!);
  if (ids.length > 0) {
    if (!reporting) {
      search = { state: 'unavailable', detail: 'No reporting client.' };
    } else {
      try {
        const lookup = await reporting.findTransactions(ids, { startMs: ledger.createdMs - 3_600_000, endMs: now });
        if (!lookup.available) search = { state: lookup.reason === 'MISSING_SCOPE' ? 'missing_scope' : 'unavailable', detail: lookup.detail };
        else ({ state: search, differences: searchDiffs } = compareSearch(ledger, lookup.found, now));
      } catch (err) {
        search = { state: 'unavailable', detail: String((err as Error)?.message ?? err).slice(0, 200) };
      }
    }
  }

  const differences = [...batch.differences, ...searchDiffs];
  return {
    ...base,
    paypalBatchStatus: details.batch_header.batch_status,
    feesCents: batch.feesCents,
    differences,
    transactionSearch: search,
    state: !batch.terminal ? 'in_progress' : differences.length > 0 ? 'differences' : 'matches',
  };
}

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}
