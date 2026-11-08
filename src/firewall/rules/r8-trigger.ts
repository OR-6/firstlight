import { distanceKm } from '../geo';
import { pagerAtLeast } from '../tiers';
import type { CorroborationObservation, FirewallContext, RuleResult } from '../types';

/**
 * R8 — the trigger is real.
 *  - event time after `now`                         → BLOCK
 *  - neither magnitude nor PAGER threshold met       → BLOCK
 *  - threshold met, enough independent sources agree → pass
 *  - agreement only via the non-independent fallback → WARN (degraded)
 *  - not enough sources agree                        → WARN (human checks)
 */
export function r8Trigger(ctx: FirewallContext): RuleResult {
  const { event, config } = ctx;
  const t = config.trigger;

  if (event.time > ctx.now) {
    return result('block', 'EVENT_IN_FUTURE', 'event origin time is after the evaluation time');
  }

  const magOk = event.mag >= t.minMagnitude;
  const pagerOk = pagerAtLeast(event.alert, t.minPagerAlert);
  if (!magOk && !pagerOk) {
    return result(
      'block',
      'TRIGGER_THRESHOLD_NOT_MET',
      `M${event.mag} < M${t.minMagnitude} and PAGER ${event.alert ?? 'none'} below ${t.minPagerAlert}`,
    );
  }

  const agreeing = ctx.corroboration.filter((c) => agrees(c, ctx));
  const independent = 1 + agreeing.filter((c) => c.independent).length;
  const any = 1 + agreeing.length;
  const why = `${magOk ? `M${event.mag}` : `PAGER ${event.alert}`} meets threshold`;

  if (independent >= t.minAgreeingSources) {
    return result('pass', 'TRIGGER_CORROBORATED', `${why}; ${independent} independent sources agree`);
  }
  if (any >= t.minAgreeingSources) {
    return result(
      'warn',
      'TRIGGER_CORROBORATION_DEGRADED',
      `${why}; agreement relies on non-independent source(s): ${agreeing.map((c) => c.source).join(', ')}`,
    );
  }
  return result(
    'warn',
    'TRIGGER_UNCORROBORATED',
    `${why}; only ${any} of ${t.minAgreeingSources} required sources agree`,
  );
}

function agrees(c: CorroborationObservation, ctx: FirewallContext): boolean {
  const t = ctx.config.trigger;
  return (
    Math.abs(c.mag - ctx.event.mag) <= t.maxMagDelta &&
    distanceKm(c.epicentre, ctx.event.epicentre) <= t.maxEpicentreDistanceKm &&
    Math.abs(c.time - ctx.event.time) <= t.maxOriginTimeDeltaSec * 1000
  );
}

function result(status: RuleResult['status'], reasonCode: RuleResult['reasonCode'], detail: string): RuleResult {
  return { id: 'R8', scope: 'plan', status, reasonCode, detail };
}
