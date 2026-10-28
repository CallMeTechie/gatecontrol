'use strict';

// The four provider adapters (one module each, the same interface:
// listModels(key) and complete(request)) and what GateControl knows about
// each without asking it: the capabilities (OpenRouter names them per model
// in its list) and a conservative default price, used until the
// administrator enters the prices of the chosen model — such costs are
// marked "estimated" in the log.

const ADAPTERS = Object.freeze({
  openai: require('./openai'),
  anthropic: require('./anthropic'),
  gemini: require('./gemini'),
  openrouter: require('./openrouter'),
});

const IDS = Object.freeze(Object.keys(ADAPTERS));

const NAMES = Object.freeze({ openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google Gemini', openrouter: 'OpenRouter' });

// Capabilities per provider (safety net besides the model list)
const CAPABILITIES = Object.freeze({
  openai: Object.freeze(['text', 'vision', 'audio']),
  anthropic: Object.freeze(['text', 'vision']),
  gemini: Object.freeze(['text', 'vision', 'audio', 'video']),
  openrouter: Object.freeze(['text']),
});

// US dollars per million tokens when no price of the model is known —
// on the high side, so a budget is never overrun by an estimate.
const DEFAULT_PRICES = Object.freeze({
  openai: Object.freeze({ input: 15, output: 60 }),
  anthropic: Object.freeze({ input: 15, output: 75 }),
  gemini: Object.freeze({ input: 2.5, output: 15 }),
  openrouter: Object.freeze({ input: 15, output: 75 }),
});

function adapter(id) {
  if (!Object.prototype.hasOwnProperty.call(ADAPTERS, id)) throw new Error('unknown provider');
  return ADAPTERS[id];
}

module.exports = { ADAPTERS, IDS, NAMES, CAPABILITIES, DEFAULT_PRICES, adapter };
