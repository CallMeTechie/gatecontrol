'use strict';

// „Sichere Suche“ per DNS (Vertrag Phase 3b §1.1 `safeSearch`): Die Anbieter
// stellen dafür eigene Namen bereit; der Filter antwortet mit einem CNAME
// dorthin und hängt dessen Adressen an.
//   Google     → forcesafesearch.google.com (alle Länderdomains www.google.xx)
//   YouTube    → restrict.youtube.com (strenger eingeschränkter Modus)
//   Bing       → strict.bing.com
//   DuckDuckGo → safe.duckduckgo.com

const GOOGLE_RE = /^(www\.)?google\.((com?\.)?[a-z]{2}|com)$/;
const GOOGLE_NOT = new Set(['google.dev', 'google.app', 'google.org', 'google.net', 'www.google.dev', 'www.google.app', 'www.google.org', 'www.google.net']);

const FIXED = new Map([
  ['www.youtube.com', 'restrict.youtube.com'],
  ['youtube.com', 'restrict.youtube.com'],
  ['m.youtube.com', 'restrict.youtube.com'],
  ['youtubei.googleapis.com', 'restrict.youtube.com'],
  ['youtube.googleapis.com', 'restrict.youtube.com'],
  ['www.youtube-nocookie.com', 'restrict.youtube.com'],
  ['www.bing.com', 'strict.bing.com'],
  ['bing.com', 'strict.bing.com'],
  ['duckduckgo.com', 'safe.duckduckgo.com'],
  ['www.duckduckgo.com', 'safe.duckduckgo.com'],
  ['start.duckduckgo.com', 'safe.duckduckgo.com'],
]);

/** Name → Ziel der sicheren Suche oder null. */
function safeSearchTarget(name) {
  const fixed = FIXED.get(name);
  if (fixed) return fixed;
  if (GOOGLE_RE.test(name) && !GOOGLE_NOT.has(name)) return 'forcesafesearch.google.com';
  return null;
}

module.exports = { safeSearchTarget };
