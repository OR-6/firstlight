import type { FirewallContext, RuleResult } from '../types';

const HOUR_MS = 3_600_000;

/** R7 — global kill switch and a cap on payout batches per rolling hour. */
export function r7Velocity(ctx: FirewallContext): RuleResult {
  if (ctx.config.killSwitch) {
    return { id: 'R7', scope: 'plan', status: 'block', reasonCode: 'KILL_SWITCH_ENGAGED', detail: 'global kill switch is on' };
  }
  const recent = ctx.ledger.batchTimes.filter((t) => t > ctx.now - HOUR_MS && t <= ctx.now).length;
  if (recent >= ctx.config.maxBatchesPerHour) {
    return {
      id: 'R7',
      scope: 'plan',
      status: 'block',
      reasonCode: 'VELOCITY_EXCEEDED',
      detail: `${recent} batches in the last hour; limit ${ctx.config.maxBatchesPerHour}`,
    };
  }
  return {
    id: 'R7',
    scope: 'plan',
    status: 'pass',
    reasonCode: 'WITHIN_VELOCITY',
    detail: `${recent}/${ctx.config.maxBatchesPerHour} batches in the last hour`,
  };
}
