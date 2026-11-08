import 'server-only';
import { PayPalApiError } from '../paypal/client';
import { PipelineError } from '../pipeline/pipeline';
import { LlmFixtureMissingError } from '../llm/replay';
import { DonationError } from '../donations/service';

/** Consistent JSON responses and error mapping for the API routes. */
export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

const STATUS: Record<string, number> = {
  NO_VERDICT: 404,
  NOT_PENDING: 409,
  ALREADY_DECIDED: 409,
  APPROVAL_INCOMPLETE: 422,
  BLOCKED: 409,
  NEEDS_APPROVAL: 409,
  DENIED: 409,
  NOT_AUDITED: 409,
  STATE_CHANGED: 409,
  NO_PAYEE: 503,
  NO_EVENT: 404,
  NOT_SUBMITTED: 409,
};

/** User-facing explanations: what happened and what to do. */
const MESSAGE: Record<string, string> = {
  NEEDS_APPROVAL: 'This plan needs a human approval before payouts can be sent.',
  DENIED: 'This plan was denied. Run a new assessment to try again.',
  BLOCKED: 'The firewall blocked this plan, so nothing can be sent.',
  STATE_CHANGED: 'The ledger changed since this plan was checked. Run a new assessment.',
  NOT_AUDITED: 'This verdict is not in the audit log, so it cannot be acted on.',
  NO_PAYEE: 'A recipient has no sandbox PayPal account configured. Add it to the payee map.',
  ALREADY_DECIDED: 'This plan already has a decision.',
  APPROVAL_INCOMPLETE: 'Enter your name and a reason.',
};

export function fail(err: unknown): Response {
  if (err instanceof PipelineError) {
    return json({ error: err.code, message: MESSAGE[err.code] ?? err.message }, STATUS[err.code] ?? 400);
  }
  if (err instanceof LlmFixtureMissingError) {
    return json({ error: 'NO_RECORDING', message: 'No recorded agent run matches this request. Replay only covers the recorded scenarios.' }, 409);
  }
  if (err instanceof PayPalApiError) {
    return json({ error: 'PAYPAL', message: `PayPal sandbox rejected the request: ${err.message}` }, 502);
  }
  console.error(err);
  return json({ error: 'INTERNAL', message: 'Something went wrong on the server. Check the server log.' }, 500);
}

export async function readJson<T>(req: Request, max = 10_000): Promise<T> {
  const text = await req.text();
  if (text.length > max) throw new PipelineError('APPROVAL_INCOMPLETE', 'request too large');
  return (text ? JSON.parse(text) : {}) as T;
}

/** Public base URL: APP_BASE_URL when set (behind a proxy), else the request's own origin. */
export function baseUrl(req: Request): string {
  return process.env.APP_BASE_URL?.trim() || new URL(req.url).origin;
}

export function donationFail(err: unknown): Response {
  if (err instanceof SyntaxError) return json({ error: 'INVALID_JSON', message: 'Send a JSON body.' }, 400);
  if (err instanceof DonationError) return json({ error: err.code, message: err.message }, err.status);
  return fail(err);
}
