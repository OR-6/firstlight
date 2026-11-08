/**
 * PayPal REST client — the ONLY module that reads PayPal credentials
 * (SPEC §5.5, CLAUDE.md). Sandbox only: the base URL is fixed and the loader
 * refuses to start unless PAYPAL_ENV=sandbox.
 *
 * Plain fetch, no SDK: the PayPal Server SDK (checked via the APIMatic
 * ContextMatic plugin, 2026-11-08) does not cover Payouts or webhook
 * verification, which are the calls this module exists for. Reporting
 * (balances, Transaction Search) is in the SDK and lives in reporting.ts.
 */
import { SdkReporting, type PayPalReporting } from './reporting';

export const PAYPAL_SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';

export type PayPalConfig = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
};

type Env = Record<string, string | undefined>;

/** Whether sandbox credentials are present (for status displays; never returns them). */
export function paypalConfigured(env: Env = process.env): boolean {
  return env.PAYPAL_ENV === 'sandbox' && Boolean(env.PAYPAL_CLIENT_ID?.trim() && env.PAYPAL_CLIENT_SECRET?.trim());
}

export function loadPayPalConfig(env: Env = process.env): PayPalConfig {
  if (env.PAYPAL_ENV !== 'sandbox') {
    throw new Error(`Firstlight is sandbox-only: PAYPAL_ENV must be "sandbox" (got ${JSON.stringify(env.PAYPAL_ENV ?? null)})`);
  }
  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in .env');
  return { baseUrl: PAYPAL_SANDBOX_BASE_URL, clientId, clientSecret };
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    readonly paypalName: string | null,
    readonly debugId: string | null,
    readonly details: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'PayPalApiError';
  }
}

export type PayPalResponse<T> = { status: number; body: T; debugId: string | null };

type Token = { accessToken: string; expiresAt: number; scope: string; appId: string | null };

export class PayPalClient {
  private token: Token | null = null;
  private reportingApi: PayPalReporting | null = null;

  constructor(
    private readonly config: PayPalConfig,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly clock: () => number = Date.now,
    private readonly timeoutMs = 20_000,
  ) {}

  /** OAuth2 client-credentials token, cached until 60 s before expiry. */
  async getToken(): Promise<Token> {
    if (this.token && this.clock() < this.token.expiresAt) return this.token;
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    const res = await this.fetchImpl(`${this.config.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = parseJson(await res.text());
    if (!res.ok) throw toApiError(res.status, res.headers.get('paypal-debug-id'), body, 'OAuth token request failed');
    const b = body as { access_token?: unknown; expires_in?: unknown; scope?: unknown; app_id?: unknown };
    if (typeof b.access_token !== 'string' || typeof b.expires_in !== 'number') {
      throw new PayPalApiError(res.status, null, null, null, 'OAuth token response missing access_token/expires_in');
    }
    this.token = {
      accessToken: b.access_token,
      expiresAt: this.clock() + Math.max(0, b.expires_in - 60) * 1000,
      scope: typeof b.scope === 'string' ? b.scope : '',
      appId: typeof b.app_id === 'string' ? b.app_id : null,
    };
    return this.token;
  }

  /**
   * Balances and Transaction Search via the Server SDK, with the same credentials.
   * Calls are skipped (reported as MISSING_SCOPE) when this client's token lacks the
   * reporting scope, so stubbed clients in tests never reach the network.
   */
  reporting(): PayPalReporting {
    return (this.reportingApi ??= new SdkReporting(this, this.config));
  }

  /** Authenticated JSON request. `requestId` becomes the PayPal-Request-Id idempotency header. */
  /** `rawBody` sends a pre-serialised JSON string as-is (webhook verification needs exact bytes). */
  async request<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; rawBody?: string; requestId?: string } = {},
  ): Promise<PayPalResponse<T>> {
    if (!path.startsWith('/v')) throw new Error(`unexpected PayPal path: ${path}`);
    const { accessToken } = await this.getToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
    const payload = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.requestId) headers['PayPal-Request-Id'] = opts.requestId;
    const res = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const debugId = res.headers.get('paypal-debug-id');
    const body = parseJson(await res.text());
    if (!res.ok) throw toApiError(res.status, debugId, body, `${method} ${path} failed`);
    return { status: res.status, body: body as T, debugId };
  }
}

function parseJson(text: string): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { unparsed: text.slice(0, 500) };
  }
}

function toApiError(status: number, debugId: string | null, body: unknown, prefix: string): PayPalApiError {
  const b = (body ?? {}) as { name?: unknown; error?: unknown; message?: unknown; error_description?: unknown; details?: unknown };
  const name = typeof b.name === 'string' ? b.name : typeof b.error === 'string' ? b.error : null;
  const msg = typeof b.message === 'string' ? b.message : typeof b.error_description === 'string' ? b.error_description : '';
  return new PayPalApiError(
    status,
    name,
    debugId,
    b.details ?? null,
    `${prefix}: HTTP ${status}${name ? ` ${name}` : ''}${msg ? ` — ${msg}` : ''}${debugId ? ` (debug_id ${debugId})` : ''}`,
  );
}
