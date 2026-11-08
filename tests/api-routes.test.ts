/**
 * The API routes' input boundary, called as plain functions (they take a Request),
 * against a real in-memory runtime with no PayPal credentials and replayed LLM output.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST as approve } from '@/app/api/plans/[id]/approve/route';
import { POST as deny } from '@/app/api/plans/[id]/deny/route';
import { POST as execute } from '@/app/api/plans/[id]/execute/route';
import { GET as getPlan } from '@/app/api/plans/[id]/route';
import { POST as assess } from '@/app/api/events/[id]/assess/route';
import { GET as getEvent } from '@/app/api/events/[id]/route';
import { POST as replay } from '@/app/api/events/replay/route';
import { POST as runRedteam } from '@/app/api/redteam/run/route';
import { GET as getAudit } from '@/app/api/audit/route';
import { GET as verifyGet, POST as verifyPost } from '@/app/api/audit/verify/route';
import { POST as reset } from '@/app/api/demo/reset/route';
import { BusyError, baseUrl, fail } from '@/server/http';
import { exclusive, refundExecutionSlot, takeExecutionSlot } from '@/server/runtime';

const EVENT = 'us6000u18k';

beforeAll(() => {
  vi.stubEnv('FIRSTLIGHT_DB', ':memory:');
  vi.stubEnv('DEMO_MODE', 'replay');
  vi.stubEnv('PAYPAL_ENV', '');
  vi.stubEnv('PAYPAL_CLIENT_ID', '');
  vi.stubEnv('PAYPAL_CLIENT_SECRET', '');
  vi.stubEnv('PAYEES_JSON', '');
  vi.stubEnv('PAYEES_FILE', 'config/does-not-exist.json');
  vi.stubEnv('APP_BASE_URL', '');
  vi.stubEnv('RENDER_EXTERNAL_URL', '');
  vi.stubEnv('RESET_COOLDOWN_MS', '0');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

function post(path: string, body?: string, contentType = 'application/json'): Request {
  return new Request(`http://localhost${path}`, { method: 'POST', body, headers: body === undefined ? {} : { 'Content-Type': contentType } });
}
const get = (path: string) => new Request(`http://localhost${path}`);
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

async function expectError(res: Response, status: number, error: string, message?: RegExp) {
  const body = (await res.json()) as { error: string; message: string };
  expect({ status: res.status, error: body.error }).toEqual({ status, error });
  if (message) expect(body.message).toMatch(message);
  return body;
}

let planId: number;

describe('assess', () => {
  it('rejects a non-boolean redteam flag with 422', async () => {
    await expectError(await assess(post('/x', '{"redteam":"yes"}'), params({ id: EVENT })), 422, 'INVALID_REQUEST', /redteam/);
  });
  it('rejects malformed JSON with 400', async () => {
    await expectError(await assess(post('/x', '{redteam'), params({ id: EVENT })), 400, 'INVALID_JSON');
  });
  it('rejects a malformed event id with 422 and an unknown one with 404', async () => {
    await expectError(await assess(post('/x', '{}'), params({ id: '../etc/passwd' })), 422, 'INVALID_REQUEST', /event id/);
    await expectError(await assess(post('/x', '{}'), params({ id: 'nope123' })), 404, 'NOT_FOUND');
  });
  it('assesses the replayed event with zero keys', async () => {
    const res = await assess(post('/x', '{}'), params({ id: EVENT }));
    expect(res.status).toBe(200);
    const plan = (await res.json()) as { id: number };
    planId = plan.id;
    expect(Number.isSafeInteger(planId)).toBe(true);
  });
});

describe('approve / deny', () => {
  it('rejects a non-string approver with 422 instead of crashing', async () => {
    const body = await expectError(await approve(post('/x', '{"approver":5,"reason":"x"}'), params({ id: String(planId) })), 422, 'INVALID_REQUEST');
    expect(body.message).toMatch(/^approver: /);
  });
  it('rejects a non-object body, an over-long reason and a bad id with 422', async () => {
    await expectError(await deny(post('/x', '[1,2]'), params({ id: String(planId) })), 422, 'INVALID_REQUEST', /^body: /);
    await expectError(await deny(post('/x', JSON.stringify({ approver: 'a', reason: 'r'.repeat(1001) })), params({ id: String(planId) })), 422, 'INVALID_REQUEST', /reason/);
    await expectError(await approve(post('/x', '{}'), params({ id: 'abc' })), 422, 'INVALID_REQUEST', /plan id/);
    await expectError(await approve(post('/x', '{}'), params({ id: '0' })), 422, 'INVALID_REQUEST');
  });
  it('still answers APPROVAL_INCOMPLETE for blank fields', async () => {
    await expectError(await approve(post('/x', '{"approver":" ","reason":""}'), params({ id: String(planId) })), 422, 'APPROVAL_INCOMPLETE', /name and a reason/);
  });
  it('records a valid approval', async () => {
    const res = await approve(post('/x', '{"approver":"Ana","reason":"Checked the registry"}'), params({ id: String(planId) }));
    expect(res.status).toBe(200);
  });
});

describe('execute with no PayPal credentials', () => {
  it('says the sandbox credentials are not configured, and refunds the hourly slot', async () => {
    vi.stubEnv('EXECUTE_LIMIT_PER_HOUR', '1');
    // Twice: if the first refusal had kept its slot, the second would be RATE_LIMITED.
    for (let i = 0; i < 2; i++) {
      await expectError(await execute(post('/x'), params({ id: String(planId) })), 503, 'PAYPAL_NOT_CONFIGURED', /PayPal sandbox credentials not configured/);
    }
    vi.stubEnv('EXECUTE_LIMIT_PER_HOUR', '6');
  });
  it('rejects a bad id with 422 and an unknown one with 404', async () => {
    await expectError(await execute(post('/x'), params({ id: '1.5' })), 422, 'INVALID_REQUEST');
    await expectError(await execute(post('/x'), params({ id: '999999' })), 404, 'NOT_FOUND');
  });
});

describe('plan and event reads', () => {
  it('validates ids', async () => {
    expect((await getPlan(get('/x'), params({ id: String(planId) }))).status).toBe(200);
    await expectError(await getPlan(get('/x'), params({ id: '-1' })), 422, 'INVALID_REQUEST');
    expect((await getEvent(get('/x'), params({ id: EVENT }))).status).toBe(200);
    await expectError(await getEvent(get('/x'), params({ id: 'a b' })), 422, 'INVALID_REQUEST');
  });
  it('replay defaults the event and validates eventId', async () => {
    expect((await replay(post('/x'))).status).toBe(200);
    await expectError(await replay(post('/x', '{"eventId":42}')), 422, 'INVALID_REQUEST', /eventId/);
  });
});

describe('red team', () => {
  it('rejects a missing or unknown scenario with 422 naming the choices', async () => {
    await expectError(await runRedteam(post('/x', '{}')), 422, 'INVALID_REQUEST', /poisoned-news/);
    await expectError(await runRedteam(post('/x', '{"scenario":"rm -rf"}')), 422, 'INVALID_REQUEST', /Pick one of the listed attacks/);
  });
  it('runs a scenario with zero keys', async () => {
    const res = await runRedteam(post('/x', '{"scenario":"compromised-agent"}'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { unauthorisedCents: number }).unauthorisedCents).toBe(0);
  });
});

describe('audit', () => {
  it('verifies the chain by GET, POST {} and POST {upTo}', async () => {
    const all = (await (await verifyPost(post('/x', '{}'))).json()) as { ok: boolean; count: number };
    expect(all.ok).toBe(true);
    const { entries } = (await (await getAudit(get('/api/audit?limit=1000'))).json()) as { entries: { hash: string }[] };
    const oldest = entries.at(-1)!.hash;
    const viaQuery = (await (await verifyGet(get(`/x?upTo=${oldest}`))).json()) as { ok: boolean; count: number };
    const viaBody = (await (await verifyPost(post('/x', JSON.stringify({ upTo: oldest })))).json()) as { ok: boolean; count: number };
    expect(viaQuery).toEqual(viaBody);
    expect(viaQuery.count).toBe(1);
  });
  it('rejects a malformed upTo or limit with 422', async () => {
    await expectError(await verifyGet(get('/x?upTo=zz')), 422, 'INVALID_REQUEST', /^upTo: .*hex/);
    await expectError(await verifyPost(post('/x', '{"upTo":7}')), 422, 'INVALID_REQUEST', /upTo/);
    await expectError(await getAudit(get('/x?limit=abc')), 422, 'INVALID_REQUEST', /limit/);
    await expectError(await getAudit(get('/x?limit=5000')), 422, 'INVALID_REQUEST', /limit/);
  });
});

describe('demo reset', () => {
  it('accepts no body or {}, and rejects anything else with 422', async () => {
    await expectError(await reset(post('/x', '{"wipe":true}')), 422, 'INVALID_REQUEST');
    await expectError(await reset(post('/x', 'not json')), 400, 'INVALID_JSON');
    expect((await reset(post('/x', '{}'))).status).toBe(200);
    expect((await reset(post('/x'))).status).toBe(200);
  });
});

describe('runtime locks and slots', () => {
  it('exclusive() throws a typed BusyError while an assessment runs, mapped to 429', async () => {
    let release!: () => void;
    const first = exclusive(() => new Promise<void>((r) => (release = r)));
    const second = exclusive(async () => 'never');
    await expect(second).rejects.toBeInstanceOf(BusyError);
    const err = await second.catch((e: unknown) => e);
    expect(fail(err).status).toBe(429);
    release();
    await first;
    await expect(exclusive(async () => 'ok')).resolves.toBe('ok');
  });
  it('gives distinct integer tokens in the same millisecond and refunds exactly one', () => {
    vi.stubEnv('EXECUTE_LIMIT_PER_HOUR', '2');
    const now = Date.now() + 10 * 3_600_000; // past every earlier slot
    const a = takeExecutionSlot(now);
    const b = takeExecutionSlot(now);
    expect(Number.isInteger(a) && Number.isInteger(b) && a !== b).toBe(true);
    expect(takeExecutionSlot(now)).toBeNull();
    refundExecutionSlot(a!);
    refundExecutionSlot(a!); // a second refund of the same token frees nothing more
    expect(takeExecutionSlot(now)).not.toBeNull();
    expect(takeExecutionSlot(now)).toBeNull();
    vi.stubEnv('EXECUTE_LIMIT_PER_HOUR', '6');
  });
});

describe('baseUrl', () => {
  it('prefers APP_BASE_URL, then the forwarded host, then localhost:3000 with no request', () => {
    const req = new Request('http://localhost:10000/x', { headers: { 'x-forwarded-host': 'demo.example.org', 'x-forwarded-proto': 'https' } });
    expect(baseUrl(req)).toBe('https://demo.example.org');
    expect(baseUrl()).toBe('http://localhost:3000');
    vi.stubEnv('APP_BASE_URL', 'https://firstlight.test/');
    expect(baseUrl(req)).toBe('https://firstlight.test');
    expect(baseUrl()).toBe('https://firstlight.test');
    vi.stubEnv('APP_BASE_URL', '');
  });
});
