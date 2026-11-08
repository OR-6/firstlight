/**
 * What judges read: the Agents page's plan-check snippet and consent chain,
 * the two labelled clocks on recorded sandbox runs, and the Postman
 * collection's shape (two folders, tests on every read-only request).
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AgentsPage from '@/app/agents/page';
import type { RecordedCheck } from '@/paypal/recorded';
import { SandboxEvidence, paypalClock } from '@/ui/SandboxEvidence';

const decode = (html: string) => html.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

describe('Agents page', () => {
  const html = decode(renderToStaticMarkup(<AgentsPage />));

  it('has a copy-paste check_payout_plan call with one household and an attacker address', () => {
    expect(html).toContain('Check a plan against the firewall');
    const snippet = html.match(/curl -s [^<]*check_payout_plan[^<]*/)?.[0] ?? '';
    expect(snippet).toContain('"recipientId":"rcp_01"');
    expect(snippet).toContain('"recipientId":"attacker@example.com"');
    // The JSON body inside the single quotes parses as a tools/call request.
    const body = JSON.parse(snippet.slice(snippet.indexOf("-d '") + 4, snippet.lastIndexOf("'"))) as { method: string; params: { name: string; arguments: { items: unknown[] } } };
    expect(body).toMatchObject({ method: 'tools/call', params: { name: 'check_payout_plan' } });
    expect(body.params.arguments.items).toHaveLength(2);
  });

  it('shows the four-step consent chain and scopes check_payout_plan to enrolled households', () => {
    for (const step of ['Person sets an allowance', 'Agent asks within the cap', 'Person approves on PayPal', 'Receipt confirmed by PayPal']) expect(html).toContain(step);
    expect(html).toContain('get_order');
    expect(html).toContain("a payout plan for this programme's enrolled households");
    expect(html).not.toMatch(/any payout plan/i);
  });
});

describe('recorded sandbox runs: two labelled clocks', () => {
  it('labels our polling clock and never claims a bare "SUCCESS in about 25 s"', () => {
    const html = decode(renderToStaticMarkup(<SandboxEvidence />));
    expect(html).toContain('All 7 items SUCCESS about 25 s after sending (our polling)');
    expect(html).toContain('All 7 items SUCCESS about 26 s and the batch SUCCESS about 33 s after sending (our polling)');
    expect(html).toContain('about 22 s after sending');
    expect(html).not.toMatch(/SUCCESS in about 25 s|Batch SUCCESS at about 25 s/);
  });

  it("states PayPal's clock from its own created and completed times", () => {
    const base = { paypalBatchId: '9GE626X9SA3NE', state: 'matches' as const, checkedMs: 0, batchStatus: 'SUCCESS', itemCount: 7, itemStatuses: { SUCCESS: 7 }, totalCents: 68_000, feesCents: 0, differences: [] };
    const at = (createdMs: number, completedMs: number | null): RecordedCheck => ({ ...base, createdMs, completedMs });
    expect(paypalClock(at(1_794_152_321_000, 1_794_152_355_000))).toBe("PayPal completed the batch 34 s after creating it (PayPal's record)");
    expect(paypalClock(at(1, null))).toBe("PayPal has not completed the batch yet (PayPal's record)");
    expect(paypalClock({ paypalBatchId: 'X', state: 'unavailable', checkedMs: 0, detail: 'down' })).toBeNull();
    expect(paypalClock(undefined)).toBeNull();
  });
});

type PmItem = { name: string; item?: PmItem[]; request?: { method: string; url: { raw: string; host: string[]; path: string[] }; body?: { raw: string } }; event?: { listen: string; script: { exec: string[] } }[] };

describe('Postman collection', () => {
  const c = JSON.parse(readFileSync('docs/postman/firstlight.postman_collection.json', 'utf8')) as { info: { schema: string }; variable: { key: string }[]; item: PmItem[] };
  const [readOnly, changes] = c.item;

  it('is a v2.1 collection with a read-only folder and a state-changing one', () => {
    expect(c.info.schema).toBe('https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
    expect(c.item.map((f) => f.name)).toEqual(['Read-only (safe to run top to bottom)', 'Changes state / sends sandbox money']);
    expect(c.variable.map((v) => v.key)).toEqual(['baseUrl', 'planId', 'receiptId']);
    for (const r of [...readOnly!.item!, ...changes!.item!]) {
      expect(r.request!.url.raw.startsWith('{{baseUrl}}/')).toBe(true);
      expect(r.request!.url.host).toEqual(['{{baseUrl}}']);
      if (r.request!.body) expect(() => JSON.parse(r.request!.body!.raw.replace(/\{\{\w+\}\}/g, 'x'))).not.toThrow();
    }
  });

  it('every read-only request has a status test and a field test; nothing in it changes state', () => {
    const SAFE_POSTS = ['/mcp', '/api/redteam/run', '/api/redteam/report', '/api/webhooks/paypal'];
    for (const r of readOnly!.item!) {
      const script = (r.event ?? []).filter((e) => e.listen === 'test').flatMap((e) => e.script.exec).join('\n');
      expect(script, r.name).toMatch(/to\.have\.status\((200|400|404)\)/);
      expect(script.match(/pm\.test\(/g)?.length ?? 0, r.name).toBeGreaterThanOrEqual(2);
      const path = r.request!.url.raw.replace('{{baseUrl}}', '').split('?')[0]!;
      if (r.request!.method !== 'GET') expect(SAFE_POSTS, r.name).toContain(path);
      if (path === '/mcp') expect(JSON.parse(r.request!.body!.raw).params?.name ?? 'none').not.toBe('create_donation');
    }
    const names = readOnly!.item!.map((r) => r.name);
    for (const n of ['MCP check_payout_plan (plan with an attacker address)', 'MCP get_allowance with a fake token', 'Recorded sandbox runs, read back from PayPal', 'Active relief events', 'Unsigned PayPal webhook (refused)'])
      expect(names).toContain(n);
  });

  it('captures planId from the assessment and keeps money-moving requests out of the read-only folder', () => {
    const assess = changes!.item!.find((r) => r.request!.url.raw.endsWith('/assess'))!;
    expect(assess.event![0]!.script.exec.join('\n')).toContain("pm.collectionVariables.set('planId'");
    expect(changes!.item!.map((r) => r.request!.url.raw)).toEqual(expect.arrayContaining(['{{baseUrl}}/api/plans/{{planId}}/execute', '{{baseUrl}}/api/plans/{{planId}}/approve']));
    expect(readOnly!.item!.some((r) => /execute|approve|deny|assess|floor/.test(r.request!.url.raw))).toBe(false);
  });
});
