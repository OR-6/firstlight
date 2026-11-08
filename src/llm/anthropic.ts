import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient, LlmRequest, LlmResponse } from './client';

/**
 * Live Anthropic Messages API. The SDK reads ANTHROPIC_API_KEY itself; no
 * other module touches it. Beta namespace because the agent opts into
 * server-side refusal fallbacks.
 */
export class AnthropicLlm implements LlmClient {
  readonly mode = 'live' as const;
  private readonly client: Anthropic;

  constructor(opts: { apiKey?: string; timeoutMs?: number } = {}) {
    this.client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 120_000, maxRetries: 2 });
  }

  create(req: LlmRequest): Promise<LlmResponse> {
    return this.client.beta.messages.create(req);
  }
}
