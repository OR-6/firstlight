import { distanceKm } from '@/firewall/geo';
import type { ItemVerdict, RuleResult } from '@/firewall/types';

/**
 * Plain-language wording for firewall results. The firewall's `detail`
 * strings are written for the audit log ("total $680.00 > auto-approve limit
 * $300.00"); these helpers turn them into sentences a reviewer can read
 * ("$680 is over the $300 that can be sent without review."). Pure functions,
 * derived only from data the API already returns.
 */

/** Dollars without cents when they are zero: $680, $80.50. */
export function usdShort(cents: number): string {
  const whole = cents % 100 === 0;
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
}

/** "$680.00" in a detail string becomes "$680". */
const money = (s: string | undefined) => (s ? s.replace(/\.00$/, '') : '');
const km = (s: string | undefined) => (s ? `${Math.round(Number(s))} km` : '');
const NUM_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const count = (n: number) => NUM_WORDS[n] ?? String(n);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const humanFlag = (s: string) => s.replaceAll('_', ' ');
const sentence = (s: string) => {
  const t = s.trim();
  if (!t) return t;
  const c = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(c) ? c : `${c}.`;
};

/** One R10 detail part ("total $680.00 > auto-approve limit $300.00") in plain words. */
function approvalPart(part: string): string | null {
  let m = part.match(/^total (\$[\d.,]+) > auto-approve limit (\$[\d.,]+)/);
  if (m) return `${money(m[1])} is over the ${money(m[2])} that can be sent without review.`;
  m = part.match(/^(\d+) item\(s\) blocked/);
  if (m) {
    const n = Number(m[1]);
    return `${plural(n, 'household')} in the plan can't be paid, so a person checks the rest.`;
  }
  if (part.startsWith('other rules raised warnings')) return 'Other checks raised warnings.';
  m = part.match(/^total (\$[\d.,]+) within auto-approve limit/);
  if (m) return `${money(m[1])} is within what can be sent without review, and nothing was flagged.`;
  return null;
}

/**
 * The rule result as a plain sentence. Falls back to the firewall's own detail
 * (capitalised) for anything it does not recognise, so nothing is ever hidden.
 */
export function plainRule(r: Pick<RuleResult, 'reasonCode' | 'detail'>, opts: { omitWarningsSummary?: boolean } = {}): string {
  const d = r.detail;
  let m: RegExpMatchArray | null;
  switch (r.reasonCode) {
    // R1
    case 'REGISTERED_ELIGIBLE':
      return 'Enrolled and verified before the cut-off.';
    case 'UNKNOWN_RECIPIENT':
      return 'Not enrolled, so this id cannot be paid.';
    case 'RECIPIENT_UNVERIFIED':
      return 'Enrolment was never verified, so this cannot be paid.';
    case 'REGISTERED_TOO_LATE':
      m = d.match(/registered ([\d.]+)h before the event; (\d+)h required/);
      if (m) return `Enrolled only ${Math.round(Number(m[1]))} hours before the earthquake. At least ${m[2]} hours is required.`;
      break;
    // R2
    case 'TIER_WITHIN_BAND':
      m = d.match(/tier (\w) at ([\d.]+) km; max (\w)(?: \(band (\w), \+1 tier for (.+)\))?/);
      if (m)
        return m[5]
          ? `${km(m[2])} from the epicentre. Tier ${m[1]} is allowed: band ${m[4]}, one tier higher for ${m[5]}.`
          : `${km(m[2])} from the epicentre, so tier ${m[1]} is allowed.`;
      break;
    case 'TIER_DOWNGRADED':
      m = d.match(/agent requested tier (\w); ([\d.]+) km allows at most (\w)/);
      if (m) return `The agent asked for tier ${m[1]}, but at ${km(m[2])} the most allowed is tier ${m[3]}, so it was lowered.`;
      break;
    case 'OUTSIDE_MAX_RADIUS':
      m = d.match(/([\d.]+) km from epicentre; max radius (\d+) km/);
      if (m) return `${km(m[1])} from the epicentre, beyond the ${m[2]} km limit for any payment.`;
      break;
    // R3
    case 'AMOUNT_FROM_TIER_TABLE':
      m = d.match(/tier (\w) = (\$[\d.,]+)/);
      if (m) return `Tier ${m[1]} pays ${money(m[2])}, taken from the fixed tier table, not from the agent.`;
      break;
    // R4
    case 'WITHIN_RECIPIENT_CAPS':
      m = d.match(/(\$[\d.,]+) of (\$[\d.,]+) in (\d+)d/);
      if (m) return `${money(m[1])} of the ${money(m[2])} one person can receive in ${m[3]} days.`;
      break;
    case 'RECIPIENT_EVENT_CAP_EXCEEDED':
      m = d.match(/(\$[\d.,]+) already \+ (\$[\d.,]+) > per-event cap (\$[\d.,]+)/);
      if (m) return `Already received ${money(m[1])} for this earthquake. Another ${money(m[2])} would pass the ${money(m[3])} limit per person.`;
      break;
    case 'RECIPIENT_ROLLING_CAP_EXCEEDED':
      m = d.match(/(\$[\d.,]+) in last (\d+)d \+ (\$[\d.,]+) > cap (\$[\d.,]+)/);
      if (m) return `Received ${money(m[1])} in the last ${m[2]} days. Another ${money(m[3])} would pass the ${money(m[4])} limit.`;
      break;
    // R5
    case 'WITHIN_BUDGET':
      m = d.match(/plan (\$[\d.,]+)/);
      if (m) return `${money(m[1])} fits in the pool and in this earthquake's budget.`;
      break;
    case 'BUDGET_SOFT_LIMIT':
      m = d.match(/plan (\$[\d.,]+) > (\d+)% of pool \((\$[\d.,]+)\)/);
      if (m) return `${money(m[1])} is more than ${m[2]}% of the pool (${money(m[3])}), so a person checks it.`;
      break;
    case 'EVENT_CAP_EXCEEDED':
      m = d.match(/(\$[\d.,]+) already paid \+ (\$[\d.,]+) > event cap (\$[\d.,]+)/);
      if (m) return `${money(m[1])} is already paid for this earthquake. Another ${money(m[2])} would pass its ${money(m[3])} budget.`;
      break;
    case 'POOL_INSUFFICIENT':
      m = d.match(/plan (\$[\d.,]+) > pool balance (\$[\d.,]+)/);
      if (m) return `${money(m[1])} is more than the ${money(m[2])} left in the pool.`;
      break;
    // R6
    case 'FIRST_PAYOUT':
      return 'Not paid yet for this earthquake.';
    case 'ALREADY_PAID_FOR_EVENT':
      return 'Already paid for this earthquake. Nobody is paid twice.';
    case 'DUPLICATE_IN_PLAN':
      return 'Listed twice in the plan. Only the first entry counts.';
    case 'ALREADY_PAID_FOR_SAME_DISASTER':
      return 'Already paid for the same earthquake under another event id.';
    // R7
    case 'WITHIN_VELOCITY':
      m = d.match(/(\d+)\/(\d+) batches/);
      if (m) return `${m[1]} of the ${m[2]} payout batches allowed per hour have been sent.`;
      break;
    case 'KILL_SWITCH_ENGAGED':
      return 'The kill switch is on, so nothing can be paid.';
    case 'VELOCITY_EXCEEDED':
      m = d.match(/(\d+) batches in the last hour; limit (\d+)/);
      if (m) return `${plural(Number(m[1]), 'payout batch', 'payout batches')} already sent this hour. The limit is ${m[2]}.`;
      break;
    // R8
    case 'TRIGGER_CORROBORATED':
      m = d.match(/^(M[\d.]+|PAGER \w+) meets threshold; (\d+) independent sources agree/);
      if (m) return `${m[1]} is strong enough to trigger relief, and ${count(Number(m[2]))} independent agencies agree.`;
      break;
    case 'TRIGGER_MAGNITUDE_ONLY':
      m = d.match(/^(M[\d.]+) meets the magnitude bar but PAGER is ([\w ]+?);/);
      return m
        ? `${m[1]} is strong, but USGS expects little impact on people (PAGER ${m[2]}). A person checks before anyone is paid.`
        : 'The quake is strong but USGS expects little impact on people. A person checks before anyone is paid.';
    case 'TRIGGER_THRESHOLD_NOT_MET':
      m = d.match(/^(M[\d.]+) < (M[\d.]+) and PAGER (\w+) below (\w+)/);
      if (m) return `${m[1]} is below ${m[2]}, and the ${m[3] === 'none' ? 'missing' : m[3]} alert is below ${m[4]}, so it does not trigger relief.`;
      break;
    case 'TRIGGER_UNCORROBORATED':
      m = d.match(/only (\d+) of (\d+) required sources agree/);
      if (m) return `Only ${count(Number(m[1]))} of the ${count(Number(m[2]))} agencies needed confirm this earthquake, so a person checks it.`;
      break;
    case 'TRIGGER_CORROBORATION_DEGRADED':
      return 'The second confirmation is not independent of USGS, so a person checks it.';
    case 'EVENT_IN_FUTURE':
      return 'The earthquake time is in the future, so the data cannot be trusted.';
    // R9
    case 'PLAN_CLEAN':
      return 'The plan is well formed and nothing was flagged.';
    case 'PLAN_MALFORMED':
      return "The agent's plan is not in the required format, so nothing can be paid.";
    case 'PLAN_EVENT_MISMATCH':
      return 'The plan names a different earthquake, so nothing can be paid.';
    case 'PLAN_UNKNOWN_FIELDS': {
      const f = extraFields(d);
      return f ? `The agent ${f}. They were ignored, and a person checks the plan.` : 'The plan had extra fields. They were ignored, and a person checks the plan.';
    }
    case 'INJECTION_SUSPECTED':
      return 'The sentinel found text that looks like an attempt to steer the agent, so a person checks the plan.';
    case 'EXCEPTION_REQUESTED':
      m = d.match(/^(\d+)/);
      return `The agent asked for ${m ? plural(Number(m[1]), 'exception') : 'exceptions'}, which a person must review.`;
    case 'AGENT_HOLD':
      return 'The agent decided to hold, so nothing will be paid.';
    case 'AGENT_ESCALATED':
      return 'The agent asked a person to decide.';
    case 'NOTE_OK':
      return d.startsWith('empty note')
        ? 'The agent wrote no draft note. PayPal sends the fixed note in the household’s language either way.'
        : 'The agent’s draft note has no links, numbers or hidden characters. PayPal sends the fixed note either way.';
    case 'NOTE_REPLACED': {
      m = d.match(/^note is (\d+) chars \(max (\d+)\)/);
      if (m) return `The agent’s draft note was ${m[1]} characters (limit ${m[2]}), a sign something is wrong. It is never sent; PayPal sends the fixed note.`;
      m = d.match(/^note (.+); fallback text used/);
      if (m?.[1]) return `The agent’s draft note ${m[1].replace(/, (?=[^,]*$)/, ' and ')}, a sign something is wrong. It is never sent; PayPal sends the fixed note.`;
      break;
    }
    // R12
    case 'ALL_ELIGIBLE_COVERED':
      m = d.match(/^all (\d+) eligible/);
      return m ? `All ${plural(Number(m[1]), 'eligible household')} are in the plan at their full tier.` : 'Nobody eligible is left out or underpaid.';
    case 'ELIGIBLE_OMITTED': {
      m = d.match(/^(\d+) eligible household\(s\) left out of the plan: (.+?)(?:\. They would get (\$[\d,.]+) less in total)?$/);
      if (!m) return 'The plan leaves out households who should be paid. A person decides.';
      return `The plan leaves out ${plural(Number(m[1]), 'household')} who should be paid (${m[2]})${m[3] ? `, ${m[3]} in total` : ''}. A person decides.`;
    }
    case 'TIER_BELOW_BAND': {
      m = d.match(/^(\d+) household.*?(?:They would get (\$[\d,.]+) less in total)?$/);
      const lost = m?.[2] ? ` They would get ${m[2]} less in total.` : '';
      return `The plan pays ${m ? plural(Number(m[1]), 'household') : 'some households'} less than their tier allows.${lost} A person decides.`;
    }
    case 'HOLD_ON_MET_TRIGGER':
      m = d.match(/and (\d+) enrolled household/);
      return `The agent held everything although two agencies confirmed the quake${m ? ` and ${plural(Number(m[1]), 'household')} are owed` : ''}. A person should re-run it.`;
    // R10
    case 'NO_PAYABLE_ITEMS':
      return 'No one in the plan can be paid.';
    case 'AUTO_APPROVABLE':
    case 'OVER_APPROVAL_THRESHOLD':
    case 'ITEMS_BLOCKED':
    case 'WARNINGS_PRESENT': {
      const parts = d
        .split('; ')
        .filter((p) => !(opts.omitWarningsSummary && p.startsWith('other rules raised warnings')))
        .map((p) => approvalPart(p) ?? sentence(p));
      if (parts.length) return parts.join(' ');
      return '';
    }
  }
  return sentence(d);
}

/**
 * "ignored unknown field(s): $.items[0].amount, $.items[0].receiver" becomes
 * "added payout fields: amount, receiver". Fields inside a payout item are
 * "payout fields"; anything else is a "plan field". Null when there are none.
 */
export function extraFields(detail: string): string | null {
  const list = detail.match(/: (.+)$/)?.[1];
  if (!list) return null;
  const payout = new Set<string>();
  const other = new Set<string>();
  for (const raw of list.split(/,\s*/)) {
    const path = raw.trim();
    if (!path) continue;
    const name = path.match(/([^.[\]$]+)\]?$/)?.[1] ?? path;
    (/\.items\[\d+\]/.test(path) ? payout : other).add(name);
  }
  const parts: string[] = [];
  if (payout.size) parts.push(`added payout ${payout.size === 1 ? 'field' : 'fields'}: ${[...payout].join(', ')}`);
  if (other.size) parts.push(`added plan ${other.size === 1 ? 'field' : 'fields'}: ${[...other].join(', ')}`);
  return parts.length ? parts.join('; ') : null;
}

/**
 * A finding's own title where one rule can return several findings (R9 plan
 * integrity, R12 coverage), so two R9 rows never share a heading. Null means
 * "use the rule's name".
 */
export function findingTitle(reasonCode: string): string | null {
  return FINDING_TITLES[reasonCode] ?? null;
}
const FINDING_TITLES: Record<string, string> = {
  PLAN_CLEAN: 'Plan is well formed',
  PLAN_MALFORMED: 'Plan format',
  PLAN_EVENT_MISMATCH: 'Plan names the right earthquake',
  PLAN_UNKNOWN_FIELDS: 'Extra fields in the plan',
  INJECTION_SUSPECTED: 'Sentinel flag',
  EXCEPTION_REQUESTED: 'Exceptions the agent asked for',
  AGENT_HOLD: 'The agent held',
  AGENT_ESCALATED: 'The agent asked a person',
  NOTE_OK: "The agent's draft note",
  NOTE_REPLACED: "The agent's draft note",
  ELIGIBLE_OMITTED: 'Eligible households left out',
  TIER_BELOW_BAND: 'Households paid below their tier',
  HOLD_ON_MET_TRIGGER: 'Held although the trigger was met',
};

/** Vulnerability flags as words: "mobility impaired, sole caregiver". */
export function flagText(flags: readonly string[]): string {
  return flags.map(humanFlag).join(', ');
}

/** Language of the note PayPal sends: the household's template, or the English fallback for an unpaid item. */
export function noteLang(item: Pick<ItemVerdict, 'amountCents'>, locale: string): string | undefined {
  return item.amountCents > 0 ? locale || undefined : 'en';
}

/** Language of the agent's draft: English when the firewall replaced it with the fallback text. */
export function draftLang(item: Pick<ItemVerdict, 'ruleTrace'>, locale: string): string | undefined {
  const note = item.ruleTrace.find((r) => r.id === 'R9' && r.scope === 'item');
  if (note && (note.reasonCode === 'NOTE_REPLACED' || note.detail.startsWith('empty note'))) return 'en';
  return locale || undefined;
}

/** Why the firewall reached this verdict for one recipient, most important first. */
export function verdictReasons(item: Pick<ItemVerdict, 'verdict' | 'ruleTrace'>): string[] {
  const want = item.verdict === 'BLOCK' ? 'block' : item.verdict === 'REQUIRE_APPROVAL' ? 'warn' : null;
  if (!want) return ['Every check passed, so this can be sent without review.'];
  const hits = item.ruleTrace.filter((r) => r.status === want);
  // A blocked item inside a plan that also needs approval: show the block first.
  const ordered = want === 'warn' ? [...hits.filter((r) => r.id === 'R10'), ...hits.filter((r) => r.id !== 'R10')] : hits;
  const omit = ordered.length > 1;
  const out = ordered.map((r) => plainRule(r, { omitWarningsSummary: omit })).filter(Boolean);
  return [...new Set(out)];
}

/** "Panama" from "10 km WSW of Pitaloza Arriba, Panama". */
export function regionOf(place: string | null | undefined): string {
  const parts = (place ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return parts.at(-1) ?? '';
}

type EventLike = { mag: number; place: string | null };
type PlanLike = { id: number; verdict: { totalCents: number; items: { verdict: string }[] } | null };

/** "M7.7 Panama earthquake: 7 households, $680". */
export function planTitle(plan: PlanLike, event: EventLike | null | undefined): string {
  const region = event ? regionOf(event.place) : '';
  const head = event ? `M${event.mag.toFixed(1)} ${region ? `${region} ` : ''}earthquake` : `Plan ${plan.id}`;
  const v = plan.verdict;
  if (!v) return `${head}: no plan`;
  const payable = v.items.filter((i) => i.verdict !== 'BLOCK').length;
  if (payable === 0) return `${head}: nobody can be paid`;
  return `${head}: ${plural(payable, 'household')}, ${usdShort(v.totalCents)}`;
}

type DecisionPlan = {
  verdict: { overall: string; totalCents: number; items: { verdict: string }[] } | null;
  approval: { decision: string } | null;
  batch: unknown;
};

/**
 * The phone's sticky decision bar: "$680 to 7 households, needs a person" while a
 * plan waits on approval, "…, ready to send" once it may be sent. Null when
 * nothing waits on a person.
 */
export function decisionBarText(plan: DecisionPlan): string | null {
  const v = plan.verdict;
  if (!v || plan.batch) return null;
  const needsDecision = v.overall === 'REQUIRE_APPROVAL' && !plan.approval;
  const canSend = v.overall === 'ALLOW' || (v.overall === 'REQUIRE_APPROVAL' && plan.approval?.decision === 'approve');
  if (!needsDecision && !canSend) return null;
  const payable = v.items.filter((i) => i.verdict !== 'BLOCK').length;
  return `${usdShort(v.totalCents)} to ${plural(payable, 'household')}, ${needsDecision ? 'needs a person' : 'ready to send'}`;
}

/** How many enrolled households live within `km` of the epicentre (the firewall's outer payout band). */
export function householdsWithin(recipients: readonly { home: { lat: number; lon: number } }[], epicentre: { lat: number; lon: number }, km: number): number {
  return recipients.filter((r) => distanceKm(epicentre, r.home) <= km).length;
}

/** "7 enrolled households within 300 km will appear here": the empty plan table on Mission control. */
export function ghostPlanCaption(n: number, km: number): string {
  if (n === 0) return `No enrolled households within ${km} km. An assessment would pay nobody.`;
  return `${plural(n, 'enrolled household')} within ${km} km will appear here, with the firewall's check for each.`;
}

/** The phone menu button's accessible name: "Menu, 1 approval waiting" while plans wait on a person. */
export function menuButtonLabel(open: boolean, pending: number): string {
  if (open) return 'Close menu';
  if (pending <= 0) return 'Menu';
  return `Menu, ${plural(pending, 'approval')} waiting`;
}

/** The red-team suite in one line: "27 of 27 attacks stopped: $0 reached anyone not owed". */
export function suiteHeadline(s: { payloads: number; firewall: { unauthorisedCents: number; payloadsWithUnauthorisedPayout: number } }): string {
  const bad = s.firewall.payloadsWithUnauthorisedPayout;
  if (bad === 0) return `${s.payloads} of ${s.payloads} attacks stopped: $0 reached anyone not owed`;
  return `${bad} of ${s.payloads} attacks paid someone not owed: ${usdShort(s.firewall.unauthorisedCents)} in total`;
}

type SummaryPlan = {
  status: string;
  decision: string | null;
  agent: { reason: string | null };
  corroboration: { mode: string };
  verdict: { planRules: RuleResult[]; items: { recipientId: string; verdict: string; distanceKm: number | null }[] } | null;
  recipients: { recipientId: string; town: string; home: { lat: number; lon: number } }[];
};
type SummaryEvent = { mag: number; epicentre: { lat: number; lon: number } };

/**
 * One line above the agent's rationale: what it decided, how many enrolled
 * households made it into the payable plan, and who was left out and why.
 * "Trigger: M7.7 confirmed by two agencies. 7 of 8 households in the plan. 1 left out: Yaviza (343 km)."
 */
export function planSummary(plan: SummaryPlan, event: SummaryEvent | null | undefined): string {
  if (plan.status === 'agent_failed') return `The agent did not produce a plan.${plan.agent.reason ? ` ${sentence(plan.agent.reason)}` : ''}`;
  const v = plan.verdict;
  const r8 = v?.planRules.find((r) => r.id === 'R8');
  const mag = event ? `M${event.mag.toFixed(1)}` : (r8?.detail.match(/^(M[\d.]+)/)?.[1] ?? 'The earthquake');
  let trigger: string;
  if (r8?.reasonCode === 'TRIGGER_CORROBORATED') {
    const n = Number(r8.detail.match(/(\d+) independent/)?.[1] ?? 2);
    trigger = `${mag} confirmed by ${count(n)} agencies`;
  } else if (r8?.reasonCode === 'TRIGGER_CORROBORATION_DEGRADED' || plan.corroboration.mode === 'fallback') trigger = `${mag} confirmed by USGS only`;
  else if (r8?.reasonCode === 'TRIGGER_THRESHOLD_NOT_MET') trigger = `${mag} is below the trigger threshold`;
  else if (r8?.reasonCode === 'TRIGGER_UNCORROBORATED' || plan.corroboration.mode === 'none') trigger = `${mag} not confirmed by a second agency`;
  else trigger = mag;
  const decision = plan.decision === 'trigger' ? 'Trigger' : plan.decision === 'escalate' ? 'Escalate to a person' : plan.decision === 'hold' ? 'Hold' : 'Decision';
  const parts = [`${decision}: ${trigger}.`];
  if (!v) return parts.join(' ');

  const enrolled = plan.recipients.length;
  const byId = new Map(v.items.map((i) => [i.recipientId, i]));
  const payable = new Set(v.items.filter((i) => i.verdict !== 'BLOCK').map((i) => i.recipientId));
  const enrolledPayable = plan.recipients.filter((r) => payable.has(r.recipientId)).length;
  parts.push(`${enrolledPayable} of ${plural(enrolled, 'household')} in the plan.`);

  const left = plan.recipients
    .filter((r) => !payable.has(r.recipientId))
    .map((r) => {
      const item = byId.get(r.recipientId);
      const d = item?.distanceKm ?? (event ? haversineKm(event.epicentre, r.home) : null);
      return d != null ? `${r.town} (${Math.round(d)} km)` : r.town;
    });
  if (left.length) parts.push(`${left.length} left out: ${left.join(', ')}.`);
  return parts.join(' ');
}

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}
