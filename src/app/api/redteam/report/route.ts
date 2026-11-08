import { fail, json } from '@/server/http';
import { ReplayLlm } from '@/llm/replay';
import { runSuite, type SuiteReport } from '@/redteam/scenarios';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let cached: SuiteReport | null = null;

/** Full corpus. Classifier-model sentinel results come from recordings (no API calls). */
export async function POST() {
  try {
    cached = await runSuite(new ReplayLlm());
    return json(cached);
  } catch (e) {
    return fail(e);
  }
}
export function GET() {
  return cached ? json(cached) : json({ error: 'NOT_RUN', message: 'Run the suite to see results.' }, 404);
}
