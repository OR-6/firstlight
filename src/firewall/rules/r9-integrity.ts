import type { ParsedPlan } from '../plan';
import type { FirewallConfig, FirewallContext, RuleResult } from '../types';

/**
 * R9 (plan level) — plan integrity and human-review flags. May return several
 * findings; each is its own trace entry so the UI can list every reason.
 *  - malformed plan, or plan for a different event   → BLOCK
 *  - agent decided `hold`                             → BLOCK (nothing to pay)
 *  - unknown fields, sentinel flag, exception request,
 *    agent decided `escalate`                         → WARN (human approval)
 * Unknown *payees* are blocked per item by R1.
 */
export function r9PlanIntegrity(parsed: ParsedPlan, ctx: FirewallContext): RuleResult[] {
  if (!parsed.ok) {
    return [r('block', 'PLAN_MALFORMED', `plan failed schema validation: ${parsed.errors.slice(0, 5).join('; ')}`)];
  }
  const { plan, unknownFields } = parsed;
  const out: RuleResult[] = [];

  if (plan.eventId !== ctx.event.id) {
    out.push(r('block', 'PLAN_EVENT_MISMATCH', `plan is for ${JSON.stringify(plan.eventId)}, context is ${ctx.event.id}`));
  }
  if (plan.decision === 'hold') {
    out.push(r('block', 'AGENT_HOLD', 'agent decided to hold; nothing will be paid'));
  }
  if (plan.decision === 'escalate') {
    out.push(r('warn', 'AGENT_ESCALATED', 'agent asked for a human decision'));
  }
  if (unknownFields.length > 0) {
    out.push(r('warn', 'PLAN_UNKNOWN_FIELDS', `ignored unknown field(s): ${unknownFields.slice(0, 10).join(', ')}`));
  }
  if (ctx.sentinel.injectionSuspected) {
    const f = ctx.sentinel.findings.slice(0, 5).join('; ');
    out.push(r('warn', 'INJECTION_SUSPECTED', `sentinel flagged untrusted input${f ? `: ${f}` : ''}`));
  }
  if (plan.exceptionRequests.length > 0) {
    out.push(
      r('warn', 'EXCEPTION_REQUESTED', `${plan.exceptionRequests.length} exception request(s) need manual review`),
    );
  }
  if (out.length === 0) out.push(r('pass', 'PLAN_CLEAN', 'schema-valid, no flags'));
  return out;
}

function r(status: RuleResult['status'], reasonCode: RuleResult['reasonCode'], detail: string): RuleResult {
  return { id: 'R9', scope: 'plan', status, reasonCode, detail };
}

// Note hygiene ---------------------------------------------------------------

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u; // control chars, zero-width, bidi overrides
// Domain labels are bounded ({1,63}, as in DNS) so the pattern stays linear; an
// unbounded `+` here backtracked quadratically on long notes (found by fuzzing).
const URL_LIKE = /(https?:\/\/|www\.|[\p{L}\p{N}-]{1,63}\.(com|net|org|io|co|ly|me|xyz|app|info|biz|link|top|ru|cn|tk|gg|sh)\b)/iu;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/u;
const PHONE_LIKE = /(?:\+?\p{Nd}[\s().-]?){7,}/u;

/**
 * R9 (item level) — the payout note is the one agent-written string that
 * reaches a recipient. A compromised agent could use it to phish ("call this
 * number to unlock your funds"), so notes that are too long or contain links,
 * addresses, phone numbers or invisible characters are replaced with a fixed
 * fallback and the plan goes to a human.
 */
export function r9Note(rawNote: string, config: FirewallConfig): { result: RuleResult; note: string } {
  const note = rawNote.trim();
  if (note.length === 0) {
    return { note: config.fallbackNote, result: itemR('pass', 'NOTE_OK', 'empty note; fallback text used') };
  }
  const chars = [...note].length;
  if (chars > config.maxNoteChars) {
    // Reject before running any pattern over attacker-sized input.
    return {
      note: config.fallbackNote,
      result: itemR('warn', 'NOTE_REPLACED', `note is ${chars} chars (max ${config.maxNoteChars}); fallback text used`),
    };
  }
  // NFKC folds full-width and compatibility characters (＠, ｗｗｗ) so they can't dodge the checks.
  const folded = note.normalize('NFKC');
  const problems: string[] = [];
  if (CONTROL_OR_FORMAT.test(note)) problems.push('contains control or invisible characters');
  if (URL_LIKE.test(folded)) problems.push('contains a link or domain');
  if (EMAIL_LIKE.test(folded)) problems.push('contains an email address');
  if (PHONE_LIKE.test(folded)) problems.push('contains a phone-number-like sequence');
  if (problems.length > 0) {
    return { note: config.fallbackNote, result: itemR('warn', 'NOTE_REPLACED', `note ${problems.join(', ')}; fallback text used`) };
  }
  return { note, result: itemR('pass', 'NOTE_OK', `${[...note].length} chars`) };
}

function itemR(status: RuleResult['status'], reasonCode: RuleResult['reasonCode'], detail: string): RuleResult {
  return { id: 'R9', scope: 'item', status, reasonCode, detail };
}
