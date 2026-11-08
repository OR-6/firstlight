import 'server-only';
import { z } from 'zod';
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
  if (err instanceof ReplayEventNotFound) return json({ error: 'NOT_FOUND', message: 'No earthquake with that id.' }, 404);
  if (err instanceof RequestError) return json({ error: err.code, message: err.message }, err.status);
  if (err instanceof BusyError) return json({ error: 'BUSY', message: err.message }, 429);
  if (err instanceof NotConfiguredError) return json({ error: err.code, message: err.message }, 503);
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
    readonly code: 'REQUEST_TOO_LARGE' | 'INVALID_JSON' | 'INVALID_REQUEST' | 'NOT_FOUND',
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

/** Parse the body as JSON (an empty body is `{}`). Malformed JSON is a 400. */
async function readJson(req: Request, max: number): Promise<unknown> {
  const text = await readText(req, max);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new RequestError('INVALID_JSON', 'Send a valid JSON body.', 400);
  }
}

/** One readable line from a zod error, e.g. "approver: Invalid input: expected string, received number". */
function describeIssues(err: z.ZodError, where: string): string {
  return err.issues
    .slice(0, 3)
    .map((i) => `${i.path.length ? i.path.join('.') : where}: ${i.message}`)
    .join('; ');
}

/** Check untrusted input against a schema; a mismatch is a 422 that says what was wrong. */
export function validate<S extends z.ZodType>(schema: S, value: unknown, where = 'body'): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new RequestError('INVALID_REQUEST', describeIssues(r.error, where), 422);
  return r.data;
}

/** Read, parse and validate a JSON body: 413 if too large, 400 if not JSON, 422 if the wrong shape. */
export async function readBody<S extends z.ZodType>(req: Request, schema: S, max = 10_000): Promise<z.output<S>> {
  return validate(schema, await readJson(req, max));
}

/** Query-string parameters as a plain object, for validate(). Repeated keys keep the last value. */
export function queryOf(req: Request): Record<string, string> {
  return Object.fromEntries(new URL(req.url).searchParams);
}

/** A database row id in a path segment: a positive whole number. */
export const RowId = z
  .string()
  .regex(/^[1-9][0-9]{0,14}$/, 'must be a positive whole number')
  .transform(Number);

/** The `[id]` segment of /api/plans/[id]/..., validated. */
export async function planIdParam(ctx: { params: Promise<{ id: string }> }): Promise<number> {
  return validate(RowId, (await ctx.params).id, 'plan id');
}

/** A 64-character lowercase hex hash (audit entries). */
export const HexHash = z.string().regex(/^[0-9a-f]{64}$/, 'must be a 64-character lowercase hex hash');

/**
 * Public base URL for links and redirects; the one place this is decided.
 * Behind a proxy (Render) the request's own URL is the internal address
 * (http://localhost:10000), so never build user-facing URLs from req.url alone.
 * Order: APP_BASE_URL, then RENDER_EXTERNAL_URL (Render injects it), then the
 * request's forwarded host / Host / URL, then http://localhost:3000 when there
 * is no request to go on (background work such as donation return links).
 */
export function baseUrl(req?: Request): string {
  const configured = process.env.APP_BASE_URL?.trim() || process.env.RENDER_EXTERNAL_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');
  return req ? requestOrigin(req.headers, req.url) : 'http://localhost:3000';
}

/** Another request already holds the lock this one needs (see runtime.exclusive). */
export class BusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusyError';
  }
}

/** A payout needs configuration this server doesn't have (zero-key / replay-only setups). */
export class NotConfiguredError extends Error {
  constructor(
    readonly code: 'PAYPAL_NOT_CONFIGURED' | 'PAYEES_NOT_CONFIGURED',
    message: string,
  ) {
    super(message);
    this.name = 'NotConfiguredError';
  }
}

export function donationFail(err: unknown): Response {
  if (err instanceof SyntaxError) return json({ error: 'INVALID_JSON', message: 'Send a JSON body.' }, 400);
  if (err instanceof DonationError) return json({ error: err.code, message: err.message }, err.status);
  return fail(err);
}
