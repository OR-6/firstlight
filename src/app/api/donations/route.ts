import { donationFail, json } from '@/server/http';
import { firstlight } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A person donating from the Donate page. */
export async function POST(req: Request) {
  try {
    const body = JSON.parse((await req.text()).slice(0, 4000) || '{}') as unknown;
    return json(await firstlight().donations.create(body, 'human'), 201);
  } catch (e) {
    return donationFail(e);
  }
}
/** Public feed of recent donations (donor text is returned as data and escaped by the UI). */
export function GET() {
  return json({ donations: firstlight().donations.feed() });
}
