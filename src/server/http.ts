import 'server-only';
import { requestOrigin } from '../lib/origin';
import { PayPalApiError } from '../paypal/client';
import { PipelineError } from '../pipeline/pipeline';
import { LlmFixtureMissingError } from '../llm/replay';
import { DonationError } from '../donations/service';
import { ReplayEventNotFound } from '../signals/replay';

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
  PAYPAL_BALANCE_LOW: 409,
  NO_ITEM: 404,
  NOT_UNCLAIMED: 409,
  NO_PAYPAL_ITEM: 409,
  IN_PROGRESS: 409,
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
  PAYPAL_BALANCE_LOW: "The PayPal sandbox account's available balance is below this batch's total, so nothing was sent. Add sandbox funds and try again.",
  NO_ITEM: 'No payout item with that id.',
  NOT_UNCLAIMED: 'Only unclaimed payouts can be cancelled. Check the status with PayPal first.',
  NO_PAYPAL_ITEM: "PayPal hasn't reported this item's id yet. Check the status now, then try again.",
  IN_PROGRESS: 'This item is already being cancelled.',
};

export function fail(err: unknown): Response {
  if (err instanceof ReplayEventNotFound) return json({ error: 'NOT_FOUND', message: 'No earthquake with that id.' }, 404);
  if (err instanceof RequestError) return json({ error: err.code, message: err.message }, err.status);
  if (err instanceof SyntaxError) return json({ error: 'INVALID_JSON', message: 'Send a valid JSON body.' }, 400);
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

export class RequestError extends Error {
  constructor(
    readonly code: 'REQUEST_TOO_LARGE' | 'INVALID_JSON' | 'NOT_FOUND',
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Read the body as text, refusing more than `maxBytes` without buffering the rest. */
export async function readText(req: Request, maxBytes: number): Promise<string> {
  const tooLarge = () => new RequestError('REQUEST_TOO_LARGE', `Request body is over ${maxBytes} bytes.`, 413);
  if (Number(req.headers.get('content-length') ?? 0) > maxBytes) throw tooLarge();
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function readJson<T>(req: Request, max = 10_000): Promise<T> {
  const text = await readText(req, max);
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new RequestError('INVALID_JSON', 'Send a valid JSON body.', 400);
  }
}

/**
 * Public base URL for links and redirects. Behind a proxy (Render) the
 * request's own URL is the internal address (http://localhost:10000), so
 * never build user-facing URLs from req.url alone.
 * Order: APP_BASE_URL, then the proxy's forwarded host, then Host, then req.url.
 */
export function baseUrl(req: Request): string {
  const configured = process.env.APP_BASE_URL?.trim() || process.env.RENDER_EXTERNAL_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');
  return requestOrigin(req.headers, req.url);
}


export function donationFail(err: unknown): Response {
  if (err instanceof SyntaxError) return json({ error: 'INVALID_JSON', message: 'Send a JSON body.' }, 400);
  if (err instanceof DonationError) return json({ error: err.code, message: err.message }, err.status);
  return fail(err);
}
