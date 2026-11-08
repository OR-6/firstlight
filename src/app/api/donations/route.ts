import { donationFail, json, readText } from '@/server/http';
import { firstlight, tracked } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A person donating from the Donate page. */
export async function POST(req: Request) {
  try {
    const body = JSON.parse((await readText(req, 8_000)) || '{}') as unknown;
    return json(await tracked(() => firstlight().donations.create(body, 'human')), 201);
  } catch (e) {
    return donationFail(e);
  }
}
/** Public feed of recent donations (donor text is returned as data and escaped by the UI). */
export function GET() {
  return json({ donations: firstlight().donations.feed() });
}
