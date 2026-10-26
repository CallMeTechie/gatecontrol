'use strict';

const { Readable } = require('node:stream');

/**
 * Bytes start…end (inclusive) of a readable that delivers the whole object
 * — for servers that answer a Range request with 200 and everything.
 */
function slice(stream, start, end) {
  async function* gen() {
    let pos = 0;
    try {
      for await (const c of stream) {
        const from = Math.max(0, start - pos);
        const to = Math.min(c.length, end - pos + 1);
        pos += c.length;
        if (to > from) yield c.subarray(from, to);
        if (pos > end) break;
      }
    } finally { stream.destroy(); }
  }
  return Readable.from(gen(), { objectMode: false });
}

module.exports = { slice };
