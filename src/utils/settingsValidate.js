'use strict';

// Range checks for numeric settings. An out-of-range or non-integer value is
// a 400 with one translated message per field — never silently ignored:
//   { ok: false, error: <summary>, fields: { <body key>: <message> } }
// The settings page shows `fields` next to the inputs.

/**
 * `spec`: { key: [min, max] }. Only keys present in `body` (not undefined)
 * are checked. → { values: { key: int }, fields: { key: message } }
 */
function checkRanges(req, body, spec) {
  const values = {};
  const fields = {};
  for (const [key, [min, max]] of Object.entries(spec)) {
    const raw = body ? body[key] : undefined;
    if (raw === undefined) continue;
    const s = typeof raw === 'number' ? String(raw) : String(raw == null ? '' : raw).trim();
    const n = /^-?\d+$/.test(s) ? Number(s) : NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      fields[key] = req.t('error.settings.range', { min: String(min), max: String(max) });
    } else {
      values[key] = n;
    }
  }
  return { values, fields };
}

function hasErrors(fields) { return Object.keys(fields).length > 0; }

function sendFieldErrors(req, res, fields) {
  return res.status(400).json({ ok: false, error: req.t('error.settings.invalid_input'), fields });
}

module.exports = { checkRanges, hasErrors, sendFieldErrors };
