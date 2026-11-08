import { donationFail, json, readText } from '@/server/http';
import { firstlight } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * "Your allowances" on /agents: body {"manage_keys": ["alm_…", …]} (up to 50).
 * Returns one entry per key, in order, null where a key matches nothing.
 * POST, so the keys never sit in a URL or access log.
 */
export async function POST(req: Request) {
  try {
    const body = JSON.parse((await readText(req, 8_000)) || '{}') as { manage_keys?: unknown } | null;
    return json({ allowances: firstlight().donations.allowancesForManageKeys(body?.manage_keys) });
  } catch (e) {
    return donationFail(e);
  }
}
