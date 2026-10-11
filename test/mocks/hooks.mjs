// Loader hook: ganti library jaringan dengan mock, hanya untuk import dari src/
const SRC = new URL('../../src/', import.meta.url).href;
const MOCKS = {
  telegram: 'telegram.mjs',
  'telegram/sessions/index.js': 'telegram.mjs',
  'telegram/events/index.js': 'telegram.mjs',
  'twitter-api-v2': 'twitter.mjs',
  telegraf: 'telegraf.mjs'
};

export async function resolve(specifier, context, next) {
  if (MOCKS[specifier] && context.parentURL?.startsWith(SRC)) {
    return { url: new URL(MOCKS[specifier], import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
