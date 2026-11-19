'use strict';

// A SyntaxError of JSON.parse quotes the text it choked on (V8: `Unexpected
// non-whitespace character after JSON at position 30 (line 1 column 31)`,
// `Unexpected token 'x', "{"a":1}x" is not valid JSON`) — data a log must not
// carry (a session, a token, a sender's body). What is safe to log: that it
// was JSON, and where it broke.

/** Is `err` a SyntaxError of JSON.parse (not one of body-parser, which has a status)? */
function isJsonSyntaxError(err) {
  return err instanceof SyntaxError && /JSON/.test(String(err.message || '')) && !err.status && !err.statusCode;
}

/** "… at position 30 …" → 30, else null. */
function position(err) {
  const m = /position (\d+)/.exec(String((err && err.message) || ''));
  return m ? Number(m[1]) : null;
}

/** What a log line may say about it: { name, position } — never the message. */
function describe(err) {
  return { name: (err && err.name) || 'SyntaxError', position: position(err) };
}

module.exports = { isJsonSyntaxError, position, describe };
