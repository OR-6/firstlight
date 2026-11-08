import { ApiError, Client, Environment, TransactionSearchController, type BalancesResponse, type SearchResponse } from '@paypal/paypal-server-sdk';
import type { PayPalClient, PayPalConfig } from './client';

/**
 * PayPal reporting (Transaction Search API) through the official PayPal Server
 * SDK's TransactionSearchController: `searchBalances` (GET /v1/reporting/balances)
 * and `searchTransactions` (GET /v1/reporting/transactions). Method and model
 * names were taken from the APIMatic Context Plugin (ContextMatic).
 *
 * Reporting needs the "Transaction search" feature on the REST app, which shows
 * up as the scope below in the OAuth token. The sandbox app checked on
 * 2026-11-08 does not have it (both calls answer 403 NOT_AUTHORIZED), so every
 * result here can be "unavailable", and callers must treat that as "we don't
 * know", never as an error that blocks the demo or a page.
 *
 * Nothing here throws: failures come back as `{ available: false }`.
 */
export const REPORTING_SCOPE = 'https://uri.paypal.com/services/reporting/search/read';

export type ReportingUnavailable = {
  available: false;
  /** MISSING_SCOPE: the app lacks Transaction Search. UNAVAILABLE: network, 5xx, timeout, bad answer. */
  reason: 'MISSING_SCOPE' | 'UNAVAILABLE';
  detail: string;
};

export type UsdBalance = { available: true; availableCents: number; totalCents: number; asOf: string | null } | ReportingUnavailable;

export type ReportedTransaction = {
  transactionId: string;
  /** PayPal reporting status: S success, P pending, V reversed, D denied. */
  status: string | null;
  /** Absolute gross amount in cents (a payout is negative on the sender's side). */
  amountCents: number | null;
  currency: string | null;
  eventCode: string | null;
  updated: string | null;
};

export type TransactionLookup = { available: true; found: ReportedTransaction[] } | ReportingUnavailable;

/** What the executor and reconciliation need. Tests pass a stub. */
export interface PayPalReporting {
  usdBalance(): Promise<UsdBalance>;
  /** Transactions with these ids in [startMs, endMs] (PayPal allows at most 31 days). */
  findTransactions(ids: readonly string[], window: { startMs: number; endMs: number }): Promise<TransactionLookup>;
}

/** The two SDK calls we use (structural, so tests can hand in a fake controller). */
export type TransactionSearchApi = Pick<TransactionSearchController, 'searchBalances' | 'searchTransactions'>;

const MAX_WINDOW_MS = 31 * 86_400_000;

export class SdkReporting implements PayPalReporting {
  private controller: TransactionSearchApi | null;

  constructor(
    private readonly client: PayPalClient,
    private readonly config: PayPalConfig,
    controller?: TransactionSearchApi,
  ) {
    this.controller = controller ?? null;
  }

  async usdBalance(): Promise<UsdBalance> {
    const gate = await this.gate();
    if (gate) return gate;
    try {
      const { result } = await this.api().searchBalances({ currencyCode: 'USD' });
      return parseUsdBalance(result);
    } catch (err) {
      return unavailable(err);
    }
  }

  async findTransactions(ids: readonly string[], window: { startMs: number; endMs: number }): Promise<TransactionLookup> {
    if (ids.length === 0) return { available: true, found: [] };
    const gate = await this.gate();
    if (gate) return gate;
    const endMs = window.endMs;
    const startMs = Math.max(window.startMs, endMs - MAX_WINDOW_MS + 60_000);
    try {
      const wanted = new Set(ids);
      const found: ReportedTransaction[] = [];
      // One window query, filtered here, instead of one call per transaction id.
      for (let page = 1; page <= 5; page++) {
        const { result } = await this.api().searchTransactions({
          startDate: rfc3339(startMs),
          endDate: rfc3339(endMs),
          fields: 'transaction_info',
          balanceAffectingRecordsOnly: 'Y',
          pageSize: 500,
          page,
        });
        for (const t of parseTransactions(result)) if (wanted.has(t.transactionId)) found.push(t);
        if (!result.totalPages || page >= result.totalPages) break;
      }
      return { available: true, found };
    } catch (err) {
      return unavailable(err);
    }
  }

  /** Skip the call when the token says the app has no Transaction Search (saves a 403 per execute). */
  private async gate(): Promise<ReportingUnavailable | null> {
    try {
      const { scope } = await this.client.getToken();
      if (!scope.split(/\s+/).includes(REPORTING_SCOPE)) {
        return { available: false, reason: 'MISSING_SCOPE', detail: 'The PayPal app has no Transaction Search scope (OAuth token scope list).' };
      }
      return null;
    } catch (err) {
      return unavailable(err);
    }
  }

  private api(): TransactionSearchApi {
    if (!this.controller) {
      const sdk = new Client({
        clientCredentialsAuthCredentials: { oAuthClientId: this.config.clientId, oAuthClientSecret: this.config.clientSecret },
        environment: Environment.Sandbox,
        timeout: 10_000,
        // No SDK logging: request/response logs would include bearer tokens.
      });
      this.controller = new TransactionSearchController(sdk);
    }
    return this.controller;
  }
}

// ── pure helpers (exported for tests) ──────────────────────────────────────────

export function parseUsdBalance(res: BalancesResponse): UsdBalance {
  const usd = res.balances?.find((b) => b.currency === 'USD');
  if (!usd) return { available: false, reason: 'UNAVAILABLE', detail: 'PayPal returned no USD balance.' };
  const total = toCents(usd.totalBalance?.value);
  const avail = toCents(usd.availableBalance?.value ?? usd.totalBalance?.value);
  if (total === null || avail === null) return { available: false, reason: 'UNAVAILABLE', detail: 'PayPal returned an unreadable USD balance.' };
  return { available: true, availableCents: avail, totalCents: total, asOf: res.asOfTime ?? res.lastRefreshTime ?? null };
}

export function parseTransactions(res: SearchResponse): ReportedTransaction[] {
  const out: ReportedTransaction[] = [];
  for (const d of res.transactionDetails ?? []) {
    const t = d.transactionInfo;
    if (!t?.transactionId) continue;
    const cents = toCents(t.transactionAmount?.value);
    out.push({
      transactionId: t.transactionId,
      status: t.transactionStatus ?? null,
      amountCents: cents === null ? null : Math.abs(cents),
      currency: t.transactionAmount?.currencyCode ?? null,
      eventCode: t.transactionEventCode ?? null,
      updated: t.transactionUpdatedDate ?? null,
    });
  }
  return out;
}

/** "-120.00" → -12000. Null for anything that isn't a plain decimal amount. */
export function toCents(value: string | undefined): number | null {
  if (typeof value !== 'string' || !/^-?\d+(\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole = '0', frac = ''] = value.trim().replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return value.trim().startsWith('-') ? -cents : cents;
}

function rfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function unavailable(err: unknown): ReportingUnavailable {
  if (err instanceof ApiError && (err.statusCode === 401 || err.statusCode === 403)) {
    return { available: false, reason: 'MISSING_SCOPE', detail: `PayPal answered ${err.statusCode}: the app is not authorised for Transaction Search.` };
  }
  const status = err instanceof ApiError ? ` (HTTP ${err.statusCode})` : '';
  return { available: false, reason: 'UNAVAILABLE', detail: `Reporting call failed${status}: ${String((err as Error)?.message ?? err).slice(0, 160)}` };
}
