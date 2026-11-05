'use strict';

// Where a request to a plugin comes from (phase 3b, gc.homeCache.lanHint).
//
// The home cache hands out a LAN address only to a client that is in the
// home network of a gateway (services/homeNetwork.js: the request's address,
// the token's peer, the device's own LAN addresses). A plugin answers its
// requests in its own process and never sees the address; the forwarder
// (routes/api/plugins.js) registers the request here and hands the plugin
// an opaque `req.homeRef`, which the plugin passes back with
// gc.homeCache.lanHint(sha256, req). A ref is valid only while that request
// is in flight and only for that plugin.

const crypto = require('node:crypto');

const refs = new Map(); // ref → { pluginId, ip, peerId, local, userId }

/** Run `fn(ref)` with a ref for this request (only plugins with permissions.homeCache get one). */
async function run(pluginId, ctx, fn) {
  const ref = crypto.randomBytes(16).toString('hex');
  refs.set(ref, { pluginId, ip: ctx.ip || null, peerId: ctx.peerId == null ? null : ctx.peerId, local: ctx.local || null, userId: ctx.userId == null ? null : ctx.userId });
  try { return await fn(ref); } finally { refs.delete(ref); }
}

/** The request behind `ref`, only for the plugin it was made for — else null. */
function get(pluginId, ref) {
  if (typeof ref !== 'string' || !/^[0-9a-f]{32}$/.test(ref)) return null;
  const e = refs.get(ref);
  return e && e.pluginId === pluginId ? e : null;
}

function _resetForTest() { refs.clear(); }

module.exports = { run, get, _resetForTest };
