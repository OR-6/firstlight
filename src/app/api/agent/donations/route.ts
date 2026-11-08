import { donationFail, json } from '@/server/http';
import { firstlight } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A donor agent creating a donation over plain HTTP (same as the create_donation MCP tool). */
export async function POST(req: Request) {
  try {
    const body = JSON.parse((await req.text()).slice(0, 4000) || '{}') as unknown;
    return json(await firstlight().donations.create(body, 'agent'), 201);
  } catch (e) {
    return donationFail(e);
  }
}
