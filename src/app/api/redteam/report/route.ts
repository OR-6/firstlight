import { fail, json } from '@/server/http';
import { ReplayLlm } from '@/llm/replay';
import { runSuite, type SuiteReport } from '@/redteam/scenarios';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The last full-suite result, kept in memory (one instance) so the page can show it on load. */
let cached: SuiteReport | null = null;
/** A run in progress: callers that arrive meanwhile wait for it instead of starting another. */
let inFlight: Promise<SuiteReport> | null = null;

function run(): Promise<SuiteReport> {
  inFlight ??= runSuite(new ReplayLlm())
    .then((r) => (cached = r))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Run the full corpus again. Classifier-model sentinel results come from recordings (no API calls). */
export async function POST() {
  try {
    return json(await run());
  } catch (e) {
    return fail(e);
  }
}

/** The last result; the first request after a start runs the suite (a few seconds) and caches it. */
export async function GET() {
  try {
    return json(cached ?? (await run()));
  } catch (e) {
    return fail(e);
  }
}
