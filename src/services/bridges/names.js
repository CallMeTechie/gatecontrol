'use strict';

// The name of a contact or chat as a bridge gives it — before it leaves this server (docs/feature-messenger-bridges.md,
// "Names"). A bridge falls back to the phone number when it knows no name: mautrix-whatsapp v0.2610.0
// (pkg/connector/config.go formatDisplayname, example-config.yaml) used `{{or .BusinessName .PushName .Phone
// .RedactedPhone "Unknown user"}} (WA)` until GateControl wrote its own template (config.js, no number, no suffix) —
// a ghost keeps such a name until the bridge syncs it again, and the DM room's name follows the ghost
// (private_chat_portal_meta). So every name is checked here, whatever the template:
//
//   * the suffix the old template added (" (WA)") goes — the apps mark the chat with the network themselves
//   * a name that is only a number (digits with + ( ) - . / spaces, the bridge's "∙" of a redacted number, at least
//     five digits) is no name: null. The plugin then shows the name from the person's address book, or a neutral label
//   * "Unknown user" (the template's last fallback) is no name either

const SUFFIX = { whatsapp: ' (WA)' };
const NUMBER_RE = /^[\s+()\-./∙•·0-9]+$/;
const UNKNOWN = new Set(['unknown user']);

/** One line: no control characters, single spaces, at most `max` characters. */
function line(v, max) {
  return (typeof v === 'string' ? v.slice(0, max * 4) : '').replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Does this look like a phone number (full or redacted) rather than a name? */
function isNumber(s) {
  const t = String(s || '');
  const digits = (t.match(/[0-9]/g) || []).length;
  // a redacted number keeps only its first and last digits ("+4∙∙∙∙∙∙∙∙∙00")
  return NUMBER_RE.test(t) && (digits >= 5 || (digits >= 1 && /[\u2219\u2022]/.test(t)));
}

/** A bridge's name → what may leave this server: the name, or null (none, or only a number). */
function nameOut(v, max = 120) {
  let n = line(v, max * 2);
  for (const s of Object.values(SUFFIX)) if (n.endsWith(s)) n = n.slice(0, -s.length).trim();
  if (!n || isNumber(n) || UNKNOWN.has(n.toLowerCase())) return null;
  return n.slice(0, max);
}

module.exports = { nameOut, isNumber, line };
