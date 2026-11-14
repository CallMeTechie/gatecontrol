'use strict';

// The internal homeserver, as far as the server itself talks to it: over its
// Unix socket in /data/bridges/hs/run/hs.sock, as the application service
// "gatecontrol" (config.js). Today one call: make the internal account of a
// GateControl person before their first link, so the bridge can invite it.
// Matrix client-server API: POST /_matrix/client/v3/register with
// type m.login.application_service (inhibit_login — no device, no token).

const http = require('node:http');
const path = require('node:path');

const TIMEOUT_MS = 10000;
const MAX_BODY = 64 * 1024;
const SOCKET_RE = /^\/[A-Za-z0-9._/-]{1,90}\/hs\/run\/hs\.sock$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const LOCAL_RE = /^gc_[0-9]{1,16}$/;

function socketOf(dir) { return path.join(dir, 'hs', 'run', 'hs.sock'); }

function post(socket, token, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const r = http.request({
      socketPath: socket, agent: false, method: 'POST', path: urlPath, timeout: TIMEOUT_MS,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_BODY) { r.destroy(new Error('answer too large')); return; } chunks.push(c); });
      res.on('error', reject);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('timeout', () => r.destroy(new Error('the homeserver did not answer in time')));
    r.on('error', reject);
    r.end(data);
  });
}

/**
 * Make sure the internal account exists. → 'created' | 'exists'; throws when the homeserver does not answer or refuses.
 * @param {{socket:string, token:string}} target
 * @param {string} localpart gc_<user id>
 */
async function ensureUser(target, localpart) {
  if (!SOCKET_RE.test(String(target.socket || '')) || String(target.socket).includes('..') || !TOKEN_RE.test(String(target.token || '')) || !LOCAL_RE.test(String(localpart || ''))) {
    throw new Error('invalid homeserver request');
  }
  const r = await post(target.socket, target.token, '/_matrix/client/v3/register', { type: 'm.login.application_service', username: localpart, inhibit_login: true });
  if (r.status >= 200 && r.status < 300) return 'created';
  if (r.json && r.json.errcode === 'M_USER_IN_USE') return 'exists';
  throw new Error(`homeserver answered ${r.status}${r.json && typeof r.json.errcode === 'string' ? ' ' + r.json.errcode.replace(/[^A-Z_.]/g, '').slice(0, 40) : ''}`);
}

module.exports = { ensureUser, socketOf };
