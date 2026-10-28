'use strict';

// The JSON Schema subset of gc.ai.extract (docs/plugins.md "AI requests").
// Only what all four providers understand: type, properties, required,
// items, enum, minimum / maximum, maxLength, maxItems, nullable and
// description. Any other keyword is refused (ERR_INVALID) so a schema works
// with every provider. The answer of a provider is checked here — not by
// the provider — and the plugin gets data that fits, or ERR_AI_INVALID_OUTPUT.

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean']);
const KEYWORDS = new Set(['type', 'properties', 'required', 'items', 'enum', 'minimum', 'maximum', 'maxLength', 'maxItems', 'nullable', 'description']);
const MAX_DEPTH = 8;
const MAX_PROPS = 100;
const MAX_ENUM = 100;
const MAX_SCHEMA_BYTES = 32 * 1024;
const PROP_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

class SchemaError extends Error {
  constructor(message) { super(message); this.code = 'ERR_INVALID'; }
}

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/**
 * Check a plugin's schema against the subset. Throws SchemaError
 * ("schema<path>: problem"). The root must be an object.
 */
function check(schema) {
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(schema)); } catch { throw new SchemaError('schema: not JSON'); }
  if (size > MAX_SCHEMA_BYTES) throw new SchemaError('schema: too large');
  if (!isObj(schema) || schema.type !== 'object') throw new SchemaError('schema: the root must be { type: "object" }');
  walk(schema, '', 0);
  return schema;
}

function walk(s, path, depth) {
  const at = (p) => `schema${path}: ${p}`;
  if (depth > MAX_DEPTH) throw new SchemaError(at('nested too deep'));
  if (!isObj(s)) throw new SchemaError(at('not an object'));
  for (const k of Object.keys(s)) if (!KEYWORDS.has(k)) throw new SchemaError(at(`keyword "${k}" is not supported`));
  if (!TYPES.has(s.type)) throw new SchemaError(at('invalid type'));
  if (s.description != null && (typeof s.description !== 'string' || s.description.length > 1000)) throw new SchemaError(at('invalid description'));
  if (s.nullable != null && typeof s.nullable !== 'boolean') throw new SchemaError(at('invalid nullable'));
  if (s.enum != null) {
    if (!Array.isArray(s.enum) || !s.enum.length || s.enum.length > MAX_ENUM) throw new SchemaError(at('invalid enum'));
    // enum of strings only (Gemini knows no other), on a string
    if (s.type !== 'string' || !s.enum.every((x) => typeof x === 'string' && x.length <= 200)) throw new SchemaError(at('enum needs type "string" and strings'));
  }
  for (const k of ['minimum', 'maximum']) {
    if (s[k] == null) continue;
    if (s.type !== 'number' && s.type !== 'integer') throw new SchemaError(at(`${k} needs a number type`));
    if (!Number.isFinite(s[k])) throw new SchemaError(at(`invalid ${k}`));
  }
  if (s.maxLength != null && (s.type !== 'string' || !Number.isSafeInteger(s.maxLength) || s.maxLength < 0)) throw new SchemaError(at('invalid maxLength'));
  if (s.maxItems != null && (s.type !== 'array' || !Number.isSafeInteger(s.maxItems) || s.maxItems < 0)) throw new SchemaError(at('invalid maxItems'));
  if (s.type === 'object') {
    if (!isObj(s.properties)) throw new SchemaError(at('an object needs properties'));
    const names = Object.keys(s.properties);
    if (!names.length || names.length > MAX_PROPS) throw new SchemaError(at('invalid properties'));
    for (const n of names) {
      if (!PROP_RE.test(n)) throw new SchemaError(at(`invalid property name "${n}"`));
      walk(s.properties[n], `${path}.${n}`, depth + 1);
    }
    if (s.required != null) {
      if (!Array.isArray(s.required) || !s.required.every((r) => typeof r === 'string' && names.includes(r))) throw new SchemaError(at('invalid required'));
    }
  } else {
    if (s.properties != null || s.required != null) throw new SchemaError(at('properties / required only on objects'));
  }
  if (s.type === 'array') {
    if (s.items == null) throw new SchemaError(at('an array needs items'));
    walk(s.items, `${path}[]`, depth + 1);
  } else if (s.items != null) throw new SchemaError(at('items only on arrays'));
}

/**
 * Check `value` against a checked schema. Properties the schema does not
 * know are dropped, an optional property that is null is dropped (strict
 * providers send null for "not given"). → { ok, value, errors: [] }
 */
function validate(schema, value) {
  const errors = [];
  const out = fit(schema, value, '$', errors, true);
  return { ok: errors.length === 0, value: errors.length ? undefined : out, errors: errors.slice(0, 20) };
}

function typeOk(type, v) {
  switch (type) {
    case 'object': return isObj(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isSafeInteger(v);
    case 'boolean': return typeof v === 'boolean';
    default: return false;
  }
}

function fit(s, v, path, errors) {
  if (v === null) {
    if (s.nullable === true) return null;
    errors.push(`${path}: must not be null`);
    return undefined;
  }
  if (!typeOk(s.type, v)) { errors.push(`${path}: must be ${s.type}`); return undefined; }
  if (s.enum && !s.enum.includes(v)) errors.push(`${path}: must be one of ${s.enum.slice(0, 10).join(', ')}`);
  if (s.minimum != null && v < s.minimum) errors.push(`${path}: must be ≥ ${s.minimum}`);
  if (s.maximum != null && v > s.maximum) errors.push(`${path}: must be ≤ ${s.maximum}`);
  if (s.maxLength != null && [...v].length > s.maxLength) errors.push(`${path}: longer than ${s.maxLength} characters`);
  if (s.type === 'array') {
    if (s.maxItems != null && v.length > s.maxItems) errors.push(`${path}: more than ${s.maxItems} items`);
    return v.map((x, i) => fit(s.items, x, `${path}[${i}]`, errors));
  }
  if (s.type === 'object') {
    const out = {};
    const required = new Set(s.required || []);
    for (const [name, sub] of Object.entries(s.properties)) {
      const has = Object.prototype.hasOwnProperty.call(v, name);
      if (!has || v[name] === undefined || (v[name] === null && !required.has(name) && sub.nullable !== true)) {
        if (required.has(name)) errors.push(`${path}.${name}: missing`);
        continue;
      }
      out[name] = fit(sub, v[name], `${path}.${name}`, errors);
    }
    return out;
  }
  return v;
}

/**
 * The schema in the strict form of OpenAI / OpenRouter structured outputs:
 * every object closed (additionalProperties false) with every property
 * required — an optional one becomes nullable (validate() drops the null).
 * Only type, properties, required, items, enum and description are passed.
 */
function strict(s) {
  const t = s.nullable || s._optional ? [s.type, 'null'] : s.type;
  const out = { type: t };
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.nullable || s._optional ? [...s.enum, null] : s.enum;
  if (s.type === 'array') out.items = strict(s.items);
  if (s.type === 'object') {
    const req = new Set(s.required || []);
    out.properties = {};
    for (const [n, sub] of Object.entries(s.properties)) out.properties[n] = strict(req.has(n) ? sub : { ...sub, _optional: true });
    out.required = Object.keys(s.properties);
    out.additionalProperties = false;
  }
  return out;
}

/** The schema for Anthropic's tool input_schema: plain JSON Schema (nullable → type with null). */
function plain(s) {
  const out = { type: s.nullable ? [s.type, 'null'] : s.type };
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.nullable ? [...s.enum, null] : s.enum;
  for (const k of ['minimum', 'maximum', 'maxLength', 'maxItems']) if (s[k] != null) out[k] = s[k];
  if (s.type === 'array') out.items = plain(s.items);
  if (s.type === 'object') {
    out.properties = {};
    for (const [n, sub] of Object.entries(s.properties)) out.properties[n] = plain(sub);
    if (s.required && s.required.length) out.required = s.required.slice();
  }
  return out;
}

/** The schema for Gemini's responseSchema (OpenAPI subset: upper-case types, nullable). */
function gemini(s) {
  const out = { type: s.type.toUpperCase() };
  if (s.description) out.description = s.description;
  if (s.nullable) out.nullable = true;
  if (s.enum) { out.enum = s.enum.slice(); out.format = 'enum'; }
  for (const k of ['minimum', 'maximum', 'maxItems']) if (s[k] != null) out[k] = s[k];
  if (s.type === 'array') out.items = gemini(s.items);
  if (s.type === 'object') {
    out.properties = {};
    for (const [n, sub] of Object.entries(s.properties)) out.properties[n] = gemini(sub);
    out.propertyOrdering = Object.keys(s.properties);
    if (s.required && s.required.length) out.required = s.required.slice();
  }
  return out;
}

module.exports = { check, validate, strict, plain, gemini, SchemaError, KEYWORDS, MAX_SCHEMA_BYTES };
