import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';

/**
 * Provider seam (SPEC §4). The agent and sentinel only ever see this
 * interface, so replay mode and the scripted "compromised agent" can stand in
 * for the live API without code changes.
 */
export type LlmRequest = MessageCreateParamsNonStreaming;
export type LlmResponse = BetaMessage;

export interface LlmClient {
  readonly mode: 'live' | 'replay' | 'record' | 'scripted';
  create(req: LlmRequest): Promise<LlmResponse>;
}

/** Default model for the agent; overridable with LLM_MODEL. */
export const DEFAULT_AGENT_MODEL = 'claude-opus-5-5';
/** SPEC §5.3: the sentinel is a second, cheap pass. */
export const DEFAULT_SENTINEL_MODEL = 'claude-haiku-5-5';
