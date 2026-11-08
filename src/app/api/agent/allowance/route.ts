import { donationFail, json, readText } from '@/server/http';
import { firstlight } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * An agent checks its own allowance (same as the get_allowance MCP tool):
 * body {"allowance_token": "alw_…"}. POST, so the token never sits in a URL or access log.
 */
export async function POST(req: Request) {
  try {
    const body = JSON.parse((await readText(req, 2_000)) || '{}') as { allowance_token?: unknown } | null;
    const view = typeof body?.allowance_token === 'string' ? firstlight().donations.allowanceForToken(body.allowance_token) : null;
    return view ? json(view) : json({ error: 'ALLOWANCE_UNKNOWN', message: 'That allowance_token is not valid.' }, 401);
  } catch (e) {
    return donationFail(e);
  }
}
