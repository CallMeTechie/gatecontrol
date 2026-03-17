'use strict';

function stripFields(obj, fields) {
  if (!obj) return obj;
  const copy = { ...obj };
  for (const f of fields) delete copy[f];
  return copy;
}

module.exports = stripFields;
