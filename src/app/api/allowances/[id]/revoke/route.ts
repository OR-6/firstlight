import { donationFail, json, readText } from '@/server/http';
import { firstlight } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Revoke an allowance: body {"manage_key": "alm_…"}. The id alone is not
 * enough (it is public in the audit log), and the agent's alw_… token can't
 * revoke (sending one gets MANAGE_KEY_REQUIRED): only the person's manage key can.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const id = (await ctx.params).id;
    const body = JSON.parse((await readText(req, 2_000)) || '{}') as { manage_key?: unknown; allowance_token?: unknown } | null;
    return json(firstlight().donations.revokeAllowance(id, body?.manage_key ?? body?.allowance_token));
  } catch (e) {
    return donationFail(e);
  }
}
