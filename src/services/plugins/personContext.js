'use strict';

// Which person is talking to a plugin right now (since phase 3a).
//
// Some host APIs may only act for the person who is using the plugin at this
// moment — e.g. gc.homeNetwork.presence.setConsent: only the person
// themselves switches the presence over the home network on, never the
// plugin for somebody else, never an administrator for a family member.
// The plugin API routes (routes/api/plugins.js forwarder: admin page, portal,
// app) run the forwarded request inside run(); a host call of that plugin
// while it is in flight sees the person with has().
//
// Only requests of a signed-in person count: the portal without sign-in
// (device trust only) and kiosk devices do not (routes decide via `eligible`).

const active = new Map(); // pluginId → Map(userId → { read, write })

function entry(pluginId, userId) {
  let m = active.get(pluginId);
  if (!m) { m = new Map(); active.set(pluginId, m); }
  let e = m.get(userId);
  if (!e) { e = { read: 0, write: 0 }; m.set(userId, e); }
  return e;
}

function release(pluginId, userId, kind) {
  const m = active.get(pluginId);
  const e = m && m.get(userId);
  if (!e) return;
  e[kind] = Math.max(0, e[kind] - 1);
  if (!e.read && !e.write) m.delete(userId);
  if (!m.size) active.delete(pluginId);
}

/**
 * Run `fn` while `userId` is the person in a request to `pluginId`.
 * `write`: the request changes something (POST/PUT/PATCH/DELETE).
 */
async function run(pluginId, userId, write, fn) {
  if (typeof pluginId !== 'string' || !Number.isSafeInteger(userId) || userId <= 0) return fn();
  const kind = write ? 'write' : 'read';
  entry(pluginId, userId)[kind]++;
  try { return await fn(); } finally { release(pluginId, userId, kind); }
}

/** Is a request of `userId` to `pluginId` in flight (with `write`: a changing one)? */
function has(pluginId, userId, { write = false } = {}) {
  const m = active.get(pluginId);
  const e = m && m.get(userId);
  if (!e) return false;
  return write ? e.write > 0 : (e.read + e.write) > 0;
}

function _resetForTest() { active.clear(); }

module.exports = { run, has, _resetForTest };
