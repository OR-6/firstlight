import { fail, json, readJson } from '@/server/http';
import { SCENARIOS, runScenario, type ScenarioId } from '@/redteam/scenarios';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Run one console scenario against an isolated copy of Firstlight. Nothing is sent to PayPal. */
export async function POST(req: Request) {
  try {
    const { scenario } = await readJson<{ scenario?: string }>(req);
    if (!SCENARIOS.some((s) => s.id === scenario)) return json({ error: 'UNKNOWN_SCENARIO', message: 'Pick one of the listed attacks.' }, 400);
    return json(await runScenario(scenario as ScenarioId));
  } catch (e) {
    return fail(e);
  }
}
export function GET() {
  return json({ scenarios: SCENARIOS });
}
