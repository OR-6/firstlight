import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { LlmClient, LlmRequest, LlmResponse } from './client';

/**
 * A stand-in "model" driven by code. Used by tests and by the red-team
 * "compromised agent" mode, where the script obeys every injected
 * instruction. It is clearly labelled `scripted` wherever it is used.
 */
export type ScriptStep = (req: LlmRequest, turn: number) => BetaContentBlock[] | LlmResponse;

export class ScriptedLlm implements LlmClient {
  readonly mode = 'scripted' as const;
  readonly requests: LlmRequest[] = [];
  private turn = 0;

  constructor(private readonly steps: ScriptStep | ScriptStep[]) {}

  async create(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone(req));
    const step = Array.isArray(this.steps) ? this.steps[this.turn] : this.steps;
    if (!step) throw new Error(`ScriptedLlm: no step for turn ${this.turn}`);
    const out = step(req, this.turn++);
    return Array.isArray(out) ? message(req.model, out) : out;
  }
}

let seq = 0;

export function message(model: string, content: BetaContentBlock[], stop?: LlmResponse['stop_reason']): LlmResponse {
  const stop_reason = stop ?? (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
  return {
    id: `msg_scripted_${++seq}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as LlmResponse;
}

export function toolUse(name: string, input: unknown, id = `toolu_scripted_${++seq}`): BetaContentBlock {
  return { type: 'tool_use', id, name, input } as BetaContentBlock;
}

export function text(t: string): BetaContentBlock {
  return { type: 'text', text: t, citations: null } as BetaContentBlock;
}
