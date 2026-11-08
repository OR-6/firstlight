import { z } from 'zod';
import { HexHash, fail, json, queryOf, readBody, validate } from '@/server/http';
import { firstlight } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `upTo`: verify only the prefix ending at this entry hash (donor receipts, SPEC §5.6b). */
const VerifyInput = z.object({ upTo: HexHash.optional() });

function verify(upTo: string | undefined): Response {
  return json(firstlight().pipeline.audit.verify(upTo));
}

/** Recompute the hash chain. ?upTo=<hash> verifies a prefix. */
export function GET(req: Request) {
  try {
    return verify(validate(VerifyInput, queryOf(req), 'query').upTo);
  } catch (e) {
    return fail(e);
  }
}

/** Same check; `upTo` may come in the query string or the JSON body ({} checks the whole chain). */
export async function POST(req: Request) {
  try {
    const fromQuery = validate(VerifyInput, queryOf(req), 'query').upTo;
    const fromBody = (await readBody(req, VerifyInput)).upTo;
    return verify(fromBody ?? fromQuery);
  } catch (e) {
    return fail(e);
  }
}
