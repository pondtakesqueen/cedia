import type { ModelSpec, Provider } from '../types.ts';
import { anthropicProvider } from './anthropic.ts';
import { chatProvider } from './chat.ts';
import { fauxProvider, type FauxStep } from './faux.ts';
import { responsesProvider } from './responses.ts';

export function providerFor(model: ModelSpec, opts: { fauxScript?: FauxStep[] } = {}): Provider {
  switch (model.wire) {
    case 'anthropic-messages':
      return anthropicProvider();
    case 'chat-completions':
      return chatProvider();
    case 'openai-responses':
      return responsesProvider();
    case 'faux':
      return fauxProvider(opts.fauxScript ?? []);
  }
}
