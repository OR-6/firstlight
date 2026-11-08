import { z } from 'zod';
import { fail, json, readBody } from '@/server/http';
import { SCENARIOS, runScenario, type ScenarioId } from '@/redteam/scenarios';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RunBody = z.object({
  scenario: z.enum(SCENARIOS.map((s) => s.id) as [ScenarioId, ...ScenarioId[]], {
    error: `Pick one of the listed attacks: ${SCENARIOS.map((s) => s.id).join(', ')}.`,
  }),
});

/** Run one console scenario against an isolated copy of Firstlight. Nothing is sent to PayPal. */
export async function POST(req: Request) {
  try {
    const { scenario } = await readBody(req, RunBody);
    return json(await runScenario(scenario));
  } catch (e) {
    return fail(e);
  }
}
export function GET() {
  return json({ scenarios: SCENARIOS });
}
