/** /api/redteam/report runs the suite on its first GET, caches it, and POST runs it again. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/api/redteam/report/route';
import type { SuiteReport } from '@/redteam/scenarios';

beforeAll(() => {
  vi.stubEnv('FIRSTLIGHT_DB', ':memory:');
  vi.stubEnv('DEMO_MODE', 'replay');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

describe('red-team report cache', () => {
  it('runs once for concurrent first requests, then serves the cached result until a re-run', async () => {
    const [a, b] = await Promise.all([GET(), GET()]);
    expect(a.status).toBe(200);
    const ra = (await a.json()) as SuiteReport;
    const rb = (await b.json()) as SuiteReport;
    expect(ra.payloads).toBe(27);
    expect(ra.firewall.unauthorisedCents).toBe(0);
    expect(rb.generatedAt).toBe(ra.generatedAt);

    const again = (await (await GET()).json()) as SuiteReport;
    expect(again.generatedAt).toBe(ra.generatedAt);

    await new Promise((r) => setTimeout(r, 5));
    const rerun = (await (await POST()).json()) as SuiteReport;
    expect(Date.parse(rerun.generatedAt)).toBeGreaterThan(Date.parse(ra.generatedAt));
    const after = (await (await GET()).json()) as SuiteReport;
    expect(after.generatedAt).toBe(rerun.generatedAt);
  }, 60_000);
});
