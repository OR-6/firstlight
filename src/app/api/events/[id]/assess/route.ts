import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { fail, json, readBody, validate } from '@/server/http';
import { exclusive, firstlight } from '@/server/runtime';
import { planView } from '@/server/views';
import { loadReplayEvent } from '@/signals/replay';
import type { UntrustedText } from '@/signals/untrusted';
import { EventId } from '../../event-id';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AssessBody = z.object({
  /** Add the poisoned news items from fixtures/redteam (red-team demo). */
  redteam: z.boolean().optional(),
});

/** Run the agent → sentinel → firewall on an event. Optional poisoned news (red team). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const id = validate(EventId, (await ctx.params).id, 'event id');
    const { redteam } = await readBody(req, AssessBody);
    const bundle = loadReplayEvent(id);
    const extra: UntrustedText[] = redteam
      ? (JSON.parse(readFileSync('fixtures/redteam/poisoned-news.json', 'utf8')) as { items: UntrustedText[] }).items
      : [];
    // exclusive() throws BusyError (429) while another assessment runs.
    const a = await exclusive(() => firstlight().pipeline.assess({ ...bundle, untrusted: [...bundle.untrusted, ...extra] }));
    return json(planView(a.planId));
  } catch (e) {
    return fail(e);
  }
}
