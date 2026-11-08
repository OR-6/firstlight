import 'server-only';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { firewallConfigFromEnv } from '../firewall/config';
import type { FirewallConfig } from '../firewall/types';
import type { AuditEntry } from '../ledger/audit';
import { openDb, type Db } from '../ledger/db';
import type { LlmClient } from '../llm/client';
import { selectLlm, type LlmMode } from '../llm/select';
import { PayPalClient, loadPayPalConfig } from '../paypal/client';
import { PayPalOrders, type DonationOrders } from '../paypal/orders';
import { DonationService } from '../donations/service';
import { Pipeline } from '../pipeline/pipeline';
import { loadPayees, type PayeeMap } from '../registry/payees';
import { loadRegistry, type RegistryProfile } from '../registry/registry';
import { BusyError, NotConfiguredError, baseUrl } from './http';

/**
 * One Firstlight instance per server process (survives dev hot-reload via
 * globalThis). Holds the database, the pipeline, and an event bus that the
 * SSE stream relays to dashboards.
 *
 * Everything in this file is per process: the assessment lock, the per-plan
 * execute lock, the hourly payout cap and the reset cooldown live in memory.
 * That is correct for the single-instance deployment Firstlight runs as
 * (render.yaml, one SQLite file). Running several instances would need these
 * moved into the database; PayPal idempotency keys still stop double payouts.
 */
export const DEMO_POOL_CENTS = 5_000_00;

export type LiveEvent = { kind: 'audit'; entry: Pick<AuditEntry, 'seq' | 'type' | 'hash' | 'tsMs'> } | { kind: 'reset' };

export type Runtime = {
  db: Db;
  pipeline: Pipeline;
  registry: RegistryProfile[];
  config: FirewallConfig;
  llm: LlmClient;
  llmMode: LlmMode;
  bus: EventEmitter;
  paypal: () => PayPalClient;
  payees: () => PayeeMap;
  pollers: Map<number, NodeJS.Timeout>;
  donations: DonationService;
};

const g = globalThis as unknown as { __firstlight?: Runtime; __firstlightBus?: EventEmitter };

function dbPath(): string {
  return process.env.FIRSTLIGHT_DB ?? 'data/firstlight.db';
}

function build(): Runtime {
  const path = dbPath();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = openDb(path);
  const bus = (g.__firstlightBus ??= new EventEmitter().setMaxListeners(200));
  const llmMode: LlmMode = process.env.DEMO_MODE === 'live' ? 'live' : 'replay';
  const llm = selectLlm(llmMode);
  const registry = loadRegistry();
  const config = firewallConfigFromEnv(process.env);
  const pipeline = new Pipeline({
    db,
    llm,
    sentinelLlm: llm,
    registry,
    config,
    agentModel: process.env.LLM_MODEL || undefined,
    onAudit: (e) => bus.emit('live', { kind: 'audit', entry: { seq: e.seq, type: e.type, hash: e.hash, tsMs: e.tsMs } } satisfies LiveEvent),
  });
  pipeline.ledger.seedCredit('demo-pool-seed', DEMO_POOL_CENTS);

  let paypal: PayPalClient | null = null;
  let payees: PayeeMap | null = null;
  let orders: DonationOrders | null = null;
  const donations = new DonationService({
    db,
    audit: pipeline.audit,
    ledger: pipeline.ledger,
    orders: () => (orders ??= configured('PAYPAL_NOT_CONFIGURED', () => new PayPalOrders())),
    baseUrl: () => baseUrl(),
  });
  return {
    donations,
    db,
    pipeline,
    registry,
    config,
    llm,
    llmMode,
    bus,
    pollers: new Map(),
    paypal: () => (paypal ??= configured('PAYPAL_NOT_CONFIGURED', () => new PayPalClient(loadPayPalConfig()))),
    payees: () => (payees ??= configured('PAYEES_NOT_CONFIGURED', () => loadPayees(process.env, new Set(registry.map((r) => r.recipientId))))),
  };
}

const NOT_CONFIGURED: Record<NotConfiguredError['code'], string> = {
  PAYPAL_NOT_CONFIGURED:
    'PayPal sandbox credentials not configured. Add your sandbox app client id and secret to .env (see .env.example) to send sandbox payouts. Assessing, approving, the red team and the audit check work without them.',
  PAYEES_NOT_CONFIGURED:
    'No sandbox payee map configured, or it is invalid. Set PAYEES_JSON or create config/payees.sandbox.json (see config/payees.sandbox.example.json).',
};

/**
 * Build a PayPal-side dependency, turning a missing or bad setup into a typed
 * 503. The original message goes to the server log only: it can quote config
 * text (a JSON parse error echoes part of the payee file).
 */
function configured<T>(code: NotConfiguredError['code'], make: () => T): T {
  try {
    return make();
  } catch (e) {
    console.error(`${code}: ${(e as Error).message}`);
    throw new NotConfiguredError(code, NOT_CONFIGURED[code]);
  }
}

export function firstlight(): Runtime {
  return (g.__firstlight ??= build());
}

/**
 * Wipe the demo database and start over (fresh ledger, audit log, plans).
 * PayPal idempotency keys include a per-database id, so payouts after a reset
 * are new payouts in the sandbox, not resends.
 */
export function resetDemo(): Runtime {
  const rt = g.__firstlight;
  if (rt) {
    for (const t of rt.pollers.values()) clearInterval(t);
    rt.db.close();
  }
  const path = dbPath();
  if (path !== ':memory:') {
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(path + suffix)) rmSync(path + suffix);
  }
  g.__firstlight = build();
  g.__firstlight.bus.emit('live', { kind: 'reset' } satisfies LiveEvent);
  return g.__firstlight;
}

let assessing = false;

/** One assessment at a time per process (live mode spends API credit). Throws BusyError if one is running. */
export async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (assessing) throw new BusyError('An assessment is already running. Try again in a moment.');
  assessing = true;
  try {
    return await fn();
  } finally {
    assessing = false;
  }
}

/** Payout slots taken in the last hour, oldest first. `token` identifies a slot for refunds. */
const executions: { token: number; atMs: number }[] = [];
let nextToken = 1;

/** Give back exactly the slot this request took, when it was refused before anything reached PayPal. */
export function refundExecutionSlot(token: number): void {
  const i = executions.findIndex((s) => s.token === token);
  if (i >= 0) executions.splice(i, 1);
}

const executing = new Set<number>();

/** One execute per plan at a time in this process (PayPal idempotency is the backstop, not the plan). */
export async function withPlanLock<T>(planId: number, fn: () => Promise<T>): Promise<T | 'BUSY'> {
  if (executing.has(planId)) return 'BUSY';
  executing.add(planId);
  try {
    return await fn();
  } finally {
    executing.delete(planId);
  }
}

let inflight = 0;
let lastReset = 0;

/** Track work that awaits PayPal, so a demo reset can't close the database under it. */
export async function tracked<T>(fn: () => Promise<T>): Promise<T> {
  inflight++;
  try {
    return await fn();
  } finally {
    inflight--;
  }
}

/** Why a reset must wait, or null if it may go ahead. */
export function resetBlocker(now = Date.now()): string | null {
  if (inflight > 0 || assessing) return 'Something is still running (an assessment, payout or donation). Try again in a few seconds.';
  const cooldown = Number(process.env.RESET_COOLDOWN_MS ?? 60_000);
  if (now - lastReset < cooldown) return 'The demo was reset less than a minute ago. Try again shortly.';
  return null;
}

export function markReset(now = Date.now()): void {
  lastReset = now;
}

/**
 * Public-demo guard: real sandbox payout batches per rolling hour, across all
 * visitors and demo resets (the firewall's own R7 limit resets with the DB).
 * Takes a slot and returns its token (pass it to refundExecutionSlot), or null
 * when the hourly cap is reached.
 */
export function takeExecutionSlot(now = Date.now()): number | null {
  const limit = Number(process.env.EXECUTE_LIMIT_PER_HOUR ?? 6);
  while (executions.length && executions[0]!.atMs < now - 3_600_000) executions.shift();
  if (executions.length >= limit) return null;
  const token = nextToken++;
  executions.push({ token, atMs: now });
  return token;
}

/** Poll a submitted batch every 2 s until it settles (fallback when no webhook reaches us). */
export function startPolling(batchId: number): void {
  const rt = firstlight();
  if (rt.pollers.has(batchId)) return;
  let ticks = 0;
  const t = setInterval(async () => {
    ticks++;
    try {
      const s = await rt.pipeline.poll(batchId, rt.paypal());
      if (s.terminal || ticks > 150) {
        clearInterval(t);
        rt.pollers.delete(batchId);
      }
    } catch {
      if (ticks > 150) {
        clearInterval(t);
        rt.pollers.delete(batchId);
      }
    }
  }, 2000);
  rt.pollers.set(batchId, t);
}
