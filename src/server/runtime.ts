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
import { Pipeline } from '../pipeline/pipeline';
import { loadPayees, type PayeeMap } from '../registry/payees';
import { loadRegistry, type RegistryProfile } from '../registry/registry';

/**
 * One Firstlight instance per server process (survives dev hot-reload via
 * globalThis). Holds the database, the pipeline, and an event bus that the
 * SSE stream relays to dashboards.
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
  return {
    db,
    pipeline,
    registry,
    config,
    llm,
    llmMode,
    bus,
    pollers: new Map(),
    paypal: () => (paypal ??= new PayPalClient(loadPayPalConfig())),
    payees: () => (payees ??= loadPayees(process.env, new Set(registry.map((r) => r.recipientId)))),
  };
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

/** One assessment at a time per server (live mode spends API credit). */
export async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (assessing) throw new Error('BUSY');
  assessing = true;
  try {
    return await fn();
  } finally {
    assessing = false;
  }
}

const executions: number[] = [];

/**
 * Public-demo guard: real sandbox payout batches per rolling hour, across all
 * visitors and demo resets (the firewall's own R7 limit resets with the DB).
 */
export function takeExecutionSlot(now = Date.now()): boolean {
  const limit = Number(process.env.EXECUTE_LIMIT_PER_HOUR ?? 6);
  while (executions.length && executions[0]! < now - 3_600_000) executions.shift();
  if (executions.length >= limit) return false;
  executions.push(now);
  return true;
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
