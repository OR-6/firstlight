import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { describe, expect, it } from 'vitest';
import { canonical, GENESIS, hashOf, verifyChain, type PublicAuditEntry } from '../scripts/verify-chain';
import { llmsTxt, manifest } from '../src/agentapi/catalog';
import { buildMcpServer } from '../src/agentapi/mcp';
import { canonicalJson } from '../src/lib/canonical';
import { entryHash, GENESIS_HASH } from '../src/ledger/audit';
import { donationSetup } from './helpers/donation-fixture';

async function connect() {
  const ctx = donationSetup();
  const server = buildMcpServer({ db: ctx.db, donations: ctx.svc });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'contract-test', version: '1' });
  await client.connect(b);
  return { ...ctx, client };
}

type JsonSchema = { type?: string; properties?: Record<string, Record<string, unknown>>; required?: string[]; additionalProperties?: unknown };

describe('MCP contract', () => {
  it('create_donation advertises the limits the server enforces', async () => {
    const { client } = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'create_donation')!;
    const s = tool.inputSchema as JsonSchema;
    expect(s.additionalProperties).toBe(false);
    expect(s.required?.slice().sort()).toEqual(['allowance_token', 'amount_usd']);
    expect(Object.keys(s.properties!).sort()).toEqual(['allowance_token', 'amount_usd', 'idempotency_key', 'message']);
    expect(s.properties!.amount_usd).toMatchObject({ type: 'number', minimum: 1, maximum: 100, multipleOf: 0.01 });
    expect(s.properties!.message).toMatchObject({ type: 'string', maxLength: 280 });
    expect(s.properties!.idempotency_key).toMatchObject({ type: 'string', minLength: 8, maxLength: 64, pattern: '^[A-Za-z0-9_-]{8,64}$' });
    expect(s.properties!.allowance_token).toMatchObject({ type: 'string', pattern: '^alw_[A-Za-z0-9_-]{32}$' });
  });

  it('every tool has snake_case arguments, an output schema, and returns matching structuredContent', async () => {
    const { client, allowance } = await connect();
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.outputSchema, t.name).toBeDefined();
      for (const k of Object.keys((t.inputSchema as JsonSchema).properties ?? {})) {
        if (!(t.name === 'get_receipt' && k === 'receiptId')) expect(k, `${t.name}.${k}`).toMatch(/^[a-z]+(_[a-z]+)*$/);
      }
    }
    const token = allowance('contract-agent', 30).allowanceToken;
    const created = (await client.callTool({ name: 'create_donation', arguments: { amount_usd: 12.34, allowance_token: token, idempotency_key: 'contract-0001' } })) as { structuredContent?: Record<string, unknown>; isError?: boolean };
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent).toMatchObject({ amountUsd: '12.34', status: 'AWAITING_APPROVAL', allowance: { label: 'contract-agent', remainingUsd: '17.66' } });
    const receiptId = created.structuredContent!.receiptId as string;
    for (const args of [{ receipt_id: receiptId }, { receiptId }]) {
      const r = (await client.callTool({ name: 'get_receipt', arguments: args })) as { structuredContent?: Record<string, unknown> };
      expect(r.structuredContent).toMatchObject({ receiptId, donorRef: 'contract-agent', whatThisProves: expect.stringMatching(/does not show where each dollar went/) });
    }
    const allowanceView = (await client.callTool({ name: 'get_allowance', arguments: { allowance_token: token } })) as { structuredContent?: Record<string, unknown> };
    expect(allowanceView.structuredContent).toMatchObject({ capUsd: '30.00', committedUsd: '12.34', remainingUsd: '17.66', status: 'active' });
    for (const name of ['get_pool_status', 'list_active_events']) {
      const r = (await client.callTool({ name, arguments: {} })) as { structuredContent?: unknown; isError?: boolean };
      expect(r.isError, name).toBeFalsy();
      expect(r.structuredContent, name).toBeDefined();
    }
  });

  it('a self-asserted donor_ref is refused by the schema', async () => {
    const { client, allowance } = await connect();
    const r = (await client.callTool({ name: 'create_donation', arguments: { amount_usd: 5, allowance_token: allowance().allowanceToken, donor_ref: 'Red Cross' } })) as { isError?: boolean };
    expect(r.isError).toBe(true);
  });

  it('does not advertise tool list-change notifications', async () => {
    const { client } = await connect();
    expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: false });
  });
});

// The curl commands on /agents, run against the same transport /mcp uses.
describe('MCP over Streamable HTTP (the /agents curl snippets)', () => {
  async function post(body: unknown) {
    const ctx = donationSetup();
    const server = buildMcpServer({ db: ctx.db, donations: ctx.svc });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const res = await transport.handleRequest(
      new Request('https://firstlight.test/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify(body),
      }),
    );
    const json = (await res.json()) as { result?: Record<string, unknown> };
    await server.close();
    return { status: res.status, json };
  }

  it('initialize', async () => {
    const r = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '1' } } });
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ serverInfo: { name: 'firstlight' }, capabilities: { tools: { listChanged: false } } });
  });

  it('tools/list works without a session (stateless server)', async () => {
    const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(r.status).toBe(200);
    expect((r.json.result!.tools as { name: string }[]).map((t) => t.name)).toContain('create_donation');
  });
});

// ── receipts verifiable without trusting the server ───────────────────────

describe('audit chain, as documented in the manifest', () => {
  it('documents the formula and genesis hash the server actually uses', () => {
    const chain = manifest('https://firstlight.test').receiptFormat.auditChain;
    expect(chain.genesisPrevHash).toBe(GENESIS_HASH);
    expect(GENESIS).toBe(GENESIS_HASH);
    expect(chain.entryHash).toMatch(/sha256 of the UTF-8 string prevHash \+ canonicalJson\(\{"seq": seq, "ts": tsMs, "type": type, "payload": payload\}\)/);
    expect(manifest('https://firstlight.test').receiptFormat.whatItProves).toMatch(/does not show where each dollar went/);
    expect(llmsTxt('https://firstlight.test')).toMatch(/does not show where each dollar went/);
  });

  it('the standalone verifier (no server code) agrees with the server on a real chain', async () => {
    const ctx = donationSetup();
    const a = ctx.allowance('verifier', 50);
    const d = await ctx.svc.create({ amount_usd: 5, allowance_token: a.allowanceToken, message: 'Für Panamá — “gracias” 🌎' }, 'agent');
    await ctx.svc.capture(d.receiptId);
    // What GET /api/audit returns: newest first.
    const entries: PublicAuditEntry[] = ctx.pipeline.audit
      .entries()
      .reverse()
      .map((e) => ({ seq: e.seq, tsMs: e.tsMs, type: e.type, hash: e.hash, prevHash: e.prevHash, payload: JSON.parse(JSON.stringify(e.payload)) }));
    for (const e of entries) expect(hashOf(e.prevHash, e)).toBe(entryHash(e.prevHash, e));
    for (const e of entries) expect(canonical(e.payload)).toBe(canonicalJson(e.payload));

    const target = ctx.svc.receipt(d.receiptId)!.audit.captured!;
    expect(verifyChain(entries, target.hash)).toEqual({ ok: true, checked: target.seq, fromGenesis: true, target });

    // Tampering with any earlier entry is caught.
    const tampered = entries.map((e) => (e.type === 'allowance.created' ? { ...e, payload: { ...(e.payload as object), capCents: 999_999 } } : e));
    expect(verifyChain(tampered, target.hash)).toMatchObject({ ok: false, reason: expect.stringMatching(/hash does not match/) });
    // A gap is caught.
    expect(verifyChain(entries.filter((e) => e.seq !== 2), target.hash)).toMatchObject({ ok: false, reason: expect.stringMatching(/gap/) });
    // A page that doesn't reach back to seq 1 is checked from its oldest entry and says so.
    expect(verifyChain(entries.filter((e) => e.seq >= 2), target.hash)).toMatchObject({ ok: true, fromGenesis: false });
  });
});
