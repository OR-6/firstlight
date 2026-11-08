import { donationFail, json, readText } from '@/server/http';
import { firstlight } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Revoke an allowance: body {"allowance_token": "alw_…"}. The id alone is not
 * enough (it is public in the audit log); the token must match too.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const id = (await ctx.params).id;
    const body = JSON.parse((await readText(req, 2_000)) || '{}') as { allowance_token?: unknown } | null;
    return json(firstlight().donations.revokeAllowance(id, body?.allowance_token));
  } catch (e) {
    return donationFail(e);
  }
}
