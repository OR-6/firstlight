import { donationFail, json, readText } from '@/server/http';
import { firstlight } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A person creates an allowance for one agent: {label, cap_usd, expires_in_hours}.
 * The response carries the token once (allowanceToken); only its sha256 is stored.
 */
export async function POST(req: Request) {
  try {
    const body = JSON.parse((await readText(req, 4_000)) || '{}') as unknown;
    return json(firstlight().donations.createAllowance(body), 201);
  } catch (e) {
    return donationFail(e);
  }
}
