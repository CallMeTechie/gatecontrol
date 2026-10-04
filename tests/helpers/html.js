'use strict';

// Test helper: the page HTML without its <script>…</script> blocks, so a
// check for raw i18n keys does not trip over the JSON string tables. Plain
// indexOf slicing on a lower-case copy (case-insensitive); an unterminated
// block drops the rest of the document. Only for asserting on our own pages
// — this is not a sanitiser.
function withoutScripts(html) {
  const src = String(html == null ? '' : html);
  const lower = src.toLowerCase();
  let out = '';
  let pos = 0;
  for (;;) {
    const start = lower.indexOf('<script', pos);
    if (start < 0) { out += src.slice(pos); break; }
    out += src.slice(pos, start);
    const end = lower.indexOf('</script', start);
    if (end < 0) break;
    const close = lower.indexOf('>', end);
    if (close < 0) break;
    pos = close + 1;
  }
  return out;
}

module.exports = { withoutScripts };
