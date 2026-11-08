import type { BetaContentBlock, BetaMessageParam, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { LlmClient, LlmRequest } from '../llm/client';
import { DEFAULT_AGENT_MODEL } from '../llm/client';
import { AGENT_SYSTEM_PROMPT, REPAIR_NO_PLAN, assessmentRequest } from './prompts';
import { AGENT_TOOLS, parsePlan } from './schemas';
import { runReadOnlyTool, type AgentWorld } from './tools';

/**
 * The assessment agent (SPEC §5.3): a manual tool-use loop, at most 6 model
 * turns, schema-validated output with ONE repair retry.
 *
 * Output is the raw plan exactly as the model submitted it. The firewall
 * parses and checks it again; the agent's own validation is only for the
 * repair prompt, never a trust boundary.
 */
export const MAX_TURNS = 6;

export type AgentStep =
  | { kind: 'tool'; turn: number; name: string; input: unknown; isError: boolean }
  | { kind: 'text'; turn: number; text: string }
  | { kind: 'repair'; turn: number; reason: string };

export type AgentResult =
  | { ok: true; rawPlan: unknown; turns: number; model: string; servedBy: string; steps: AgentStep[] }
  | { ok: false; reason: string; turns: number; model: string; steps: AgentStep[] };

export type AgentOptions = { model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' };

export async function runAgent(world: AgentWorld, llm: LlmClient, opts: AgentOptions = {}): Promise<AgentResult> {
  const model = opts.model || DEFAULT_AGENT_MODEL;
  const steps: AgentStep[] = [];
  const messages: BetaMessageParam[] = [{ role: 'user', content: assessmentRequest(world.event.id) }];
  let repairUsed = false;
  const fail = (reason: string, turns: number): AgentResult => ({ ok: false, reason, turns, model, steps });

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const req: LlmRequest = {
      model,
      max_tokens: 16_000,
      system: AGENT_SYSTEM_PROMPT,
      tools: AGENT_TOOLS,
      messages,
      // Opus 5.5 rejects `temperature`; effort is the knob. Thinking is always on.
      output_config: { effort: opts.effort ?? 'high' },
      // Server-side refusal fallback, routed by refusal category.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    };
    const res = await llm.create(req);

    if (res.stop_reason === 'refusal') return fail(`model refused (${res.stop_details?.category ?? 'no category'})`, turn);
    if (res.stop_reason === 'max_tokens') return fail('model hit max_tokens', turn);

    // Append-only history: pass the assistant content back unchanged (thinking blocks included).
    messages.push({ role: 'assistant', content: res.content });
    if (res.stop_reason === 'pause_turn') continue;

    for (const b of res.content) {
      if (b.type === 'text' && b.text.trim()) steps.push({ kind: 'text', turn, text: b.text.slice(0, 2000) });
    }
    const toolUses = res.content.filter((b): b is Extract<BetaContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');

    if (toolUses.length === 0) {
      if (repairUsed) return fail('model ended without calling submit_plan', turn);
      repairUsed = true;
      steps.push({ kind: 'repair', turn, reason: 'no submit_plan call' });
      messages.push({ role: 'user', content: REPAIR_NO_PLAN });
      continue;
    }

    const results: BetaToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      if (tu.name === 'submit_plan') {
        const parsed = parsePlan(tu.input);
        steps.push({ kind: 'tool', turn, name: tu.name, input: tu.input, isError: !parsed.ok });
        if (parsed.ok) {
          return { ok: true, rawPlan: tu.input, turns: turn, model, servedBy: res.model, steps };
        }
        if (repairUsed) return fail(`plan failed validation after repair: ${parsed.errors.slice(0, 3).join('; ')}`, turn);
        repairUsed = true;
        steps.push({ kind: 'repair', turn, reason: 'invalid plan' });
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          is_error: true,
          content: `Plan rejected by schema validation: ${parsed.errors.slice(0, 10).join('; ')}. Fix it and call submit_plan again.`,
        });
        continue;
      }
      const out = runReadOnlyTool(world, tu.name, tu.input);
      steps.push({ kind: 'tool', turn, name: tu.name, input: tu.input, isError: out.isError });
      results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: out.isError || undefined, content: out.content });
    }
    // All results for one turn go back in a single user message.
    messages.push({ role: 'user', content: results });
  }
  return fail(`no plan after ${MAX_TURNS} turns`, MAX_TURNS);
}
