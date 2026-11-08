import { readFileSync } from 'node:fs';
import { fail, json, readJson } from '@/server/http';
import { exclusive, firstlight } from '@/server/runtime';
import { planView } from '@/server/views';
import { loadReplayEvent } from '@/signals/replay';
import type { UntrustedText } from '@/signals/untrusted';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Run the agent → sentinel → firewall on an event. Optional poisoned news (red team). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { redteam } = await readJson<{ redteam?: boolean }>(req);
    const bundle = loadReplayEvent(id);
    const extra: UntrustedText[] = redteam
      ? (JSON.parse(readFileSync('fixtures/redteam/poisoned-news.json', 'utf8')) as { items: UntrustedText[] }).items
      : [];
    const a = await exclusive(() => firstlight().pipeline.assess({ ...bundle, untrusted: [...bundle.untrusted, ...extra] }));
    return json(planView(a.planId));
  } catch (e) {
    if ((e as Error).message === 'BUSY') return json({ error: 'BUSY', message: 'An assessment is already running. Try again in a moment.' }, 429);
    return fail(e);
  }
}
