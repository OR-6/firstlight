import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

/**
 * Client for PayPal's hosted MCP server (the remote server from
 * paypal/agent-toolkit, documented at developer.paypal.com/tools/mcp-server).
 * Sandbox only: the host is fixed to mcp.sandbox.paypal.com. Bearer = an
 * OAuth client-credentials access token from src/paypal/client.ts.
 *
 * Transport: SSE on /sse. Probed 2026-11-08 with a valid sandbox token: GET
 * /sse opens the stream (200 text/event-stream, `endpoint` event), while the
 * documented Streamable HTTP path /http and also /mcp answer 404 Not Found.
 *
 * Firstlight only ever READS through it. The allowlist below is checked before
 * any call leaves the process, so a bug elsewhere cannot make this client
 * create orders, pay them or refund them.
 */
export const PAYPAL_SANDBOX_MCP_URL = 'https://mcp.sandbox.paypal.com/sse';
export const HOSTED_MCP_READ_ONLY_TOOLS: readonly string[] = ['get_order'];

/** What a read of an order tells us (from either the hosted MCP or the Server SDK). */
export type OrderLookup = {
  orderId: string;
  status: string;
  payerId: string | null;
  captureId: string | null;
  captureStatus: string | null;
  amountCents: number | null;
};

export class HostedMcpError extends Error {
  constructor(
    readonly stage: 'allowlist' | 'connect' | 'call' | 'parse',
    message: string,
  ) {
    super(message);
    this.name = 'HostedMcpError';
  }
}

export class HostedPayPalMcp {
  constructor(
    private readonly accessToken: () => Promise<string>,
    private readonly url = PAYPAL_SANDBOX_MCP_URL,
    private readonly timeoutMs = 6_000,
  ) {
    if (new URL(url).hostname !== 'mcp.sandbox.paypal.com') throw new Error('Firstlight is sandbox-only: the hosted PayPal MCP host must be mcp.sandbox.paypal.com');
  }

  private async session<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const token = await this.accessToken();
    // The token goes in a header only (on the stream GET and every POST), never in the URL or a log line.
    const transport = new SSEClientTransport(new URL(this.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    const client = new Client({ name: 'firstlight-receipts', version: '1.0.0' });
    try {
      try {
        await client.connect(transport, { timeout: this.timeoutMs });
      } catch (err) {
        throw new HostedMcpError('connect', scrub((err as Error).message));
      }
      return await fn(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /** Tool names and their input schemas (tools/list is metadata only). Used by the probe script. */
  async listTools(): Promise<{ name: string; inputSchema: unknown }[]> {
    return this.session(async (client) => {
      try {
        return (await client.listTools(undefined, { timeout: this.timeoutMs })).tools.map((t) => ({ name: t.name, inputSchema: t.inputSchema }));
      } catch (err) {
        throw new HostedMcpError('call', scrub((err as Error).message));
      }
    });
  }

  /** Call one allowlisted, read-only tool and return its text content. */
  async callReadOnly(name: string, args: Record<string, unknown>): Promise<string> {
    if (!HOSTED_MCP_READ_ONLY_TOOLS.includes(name)) throw new HostedMcpError('allowlist', `${name} is not on the read-only allowlist`);
    return this.session(async (client) => {
      let res: Awaited<ReturnType<Client['callTool']>>;
      try {
        res = await client.callTool({ name, arguments: args }, undefined, { timeout: this.timeoutMs });
      } catch (err) {
        throw new HostedMcpError('call', scrub((err as Error).message));
      }
      const text = (res.content as { type: string; text?: string }[] | undefined)?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('') ?? '';
      if (res.isError) throw new HostedMcpError('call', scrub(text).slice(0, 200) || 'tool returned an error');
      return text;
    });
  }

  /** get_order through PayPal's hosted MCP server. */
  async getOrder(orderId: string): Promise<OrderLookup> {
    if (!/^[A-Z0-9]{8,36}$/.test(orderId)) throw new HostedMcpError('allowlist', 'invalid order id');
    const text = await this.callReadOnly('get_order', { id: orderId });
    return parseOrderJson(text, orderId);
  }
}

/** PayPal REST order JSON (snake_case) → OrderLookup. The hosted MCP returns the REST body as text. */
export function parseOrderJson(text: string, expectedOrderId: string): OrderLookup {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HostedMcpError('parse', 'get_order did not return JSON');
  }
  const o = body as {
    id?: unknown;
    status?: unknown;
    payer?: { payer_id?: unknown };
    payment_source?: { paypal?: { account_id?: unknown } };
    purchase_units?: { payments?: { captures?: { id?: unknown; status?: unknown; amount?: { value?: unknown } }[] } }[];
  };
  if (typeof o.id !== 'string' || o.id !== expectedOrderId) throw new HostedMcpError('parse', 'get_order returned a different order');
  const cap = o.purchase_units?.[0]?.payments?.captures?.[0];
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const value = str(cap?.amount?.value);
  return {
    orderId: o.id,
    status: str(o.status) ?? 'UNKNOWN',
    payerId: str(o.payment_source?.paypal?.account_id) ?? str(o.payer?.payer_id),
    captureId: str(cap?.id),
    captureStatus: str(cap?.status),
    amountCents: value ? Math.round(Number(value) * 100) : null,
  };
}

/** Error text from a transport can echo request headers; drop anything that looks like a bearer token. */
function scrub(message: string): string {
  return message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]').replace(/A21[A-Za-z0-9._-]{20,}/g, '[redacted]').slice(0, 300);
}
