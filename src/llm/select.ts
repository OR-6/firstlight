import { AnthropicLlm } from './anthropic';
import type { LlmClient } from './client';
import { RecordingLlm, ReplayLlm } from './replay';

export type LlmMode = 'live' | 'record' | 'replay';

/**
 * replay (default, no key needed): serve recorded fixtures.
 * record: call the live API and save fixtures (needs ANTHROPIC_API_KEY).
 * live:   call the live API without saving.
 */
export function selectLlm(mode: LlmMode, fixturesDir = 'fixtures/llm'): LlmClient {
  switch (mode) {
    case 'replay':
      return new ReplayLlm(fixturesDir);
    case 'record':
      return new RecordingLlm(new AnthropicLlm(), fixturesDir);
    case 'live':
      return new AnthropicLlm();
  }
}
