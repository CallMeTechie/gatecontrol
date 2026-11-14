'use strict';

// The server as an application service of the internal homeserver (Matrix
// application service API v1): the homeserver pushes what happens in the rooms
// of the GateControl people here. It reaches the server by HTTP only, so a
// relay container (bruecken-core-relay, docker-compose.yml) hands its calls to
// the Unix socket this module listens on: /data/bridges/run/core.sock.
//
//   PUT  /_matrix/app/v1/transactions/{txnId}   the events (answer 200 {} = taken; anything else = send again)
//   POST /_matrix/app/v1/ping                   {}
//   everything else                             404 M_UNRECOGNIZED
//
// The homeserver proves itself with the hs_token of the registration — as a
// bearer token and (Tuwunel, for older services) as ?access_token=. It is
// compared in constant time; without it nothing is read. Nothing listens on a
// network: the socket lies in a folder only root reaches.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const logger = require('../../utils/logger');

const MAX_BODY = 8 * 1024 * 1024;
const TXN_PATH = /^\/_matrix\/app\/v1\/transactions\/([^/?]{1,200})$/;

function socketOf(dir) { return path.join(dir, 'run', 'core.sock'); }

function sameToken(given, want) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(String(want)).digest();
  return crypto.timingSafeEqual(a, b);
}

function answer(res, status, json) {
  const b = JSON.stringify(json);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), Connection: 'close' });
  res.end(b);
}

/**
 * Listen on `socket`. → { close(), socket }
 * @param {{ socket:string, hsToken:string, onTransaction:(txnId:string, body:object)=>Promise<void> }} opts
 */
function listen(opts) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let url;
      try { url = new URL(req.url, 'http://core'); } catch { answer(res, 400, { errcode: 'M_UNRECOGNIZED', error: 'bad request' }); return; }
      const auth = String(req.headers.authorization || '');
      const given = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('access_token');
      if (!given || !sameToken(given, opts.hsToken)) { req.resume(); answer(res, given ? 403 : 401, { errcode: 'M_FORBIDDEN', error: 'bad token' }); return; }
      const m = TXN_PATH.exec(url.pathname);
      const isPing = req.method === 'POST' && url.pathname === '/_matrix/app/v1/ping';
      if (!isPing && !(m && req.method === 'PUT')) { req.resume(); answer(res, 404, { errcode: 'M_UNRECOGNIZED', error: 'unknown endpoint' }); return; }
      const chunks = [];
      let size = 0;
      let over = false;
      req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { over = true; chunks.length = 0; } else if (!over) chunks.push(c); });
      req.on('error', () => { /* the homeserver sends it again */ });
      req.on('end', async () => {
        if (over) { answer(res, 413, { errcode: 'M_TOO_LARGE', error: 'too large' }); return; }
        if (isPing) { answer(res, 200, {}); return; }
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { body = null; }
        if (!body || typeof body !== 'object' || Array.isArray(body)) { answer(res, 400, { errcode: 'M_BAD_JSON', error: 'not JSON' }); return; }
        let txnId;
        try { txnId = decodeURIComponent(m[1]); } catch { txnId = m[1]; }
        try {
          await opts.onTransaction(txnId, body);
          answer(res, 200, {});
        } catch (err) {
          // not taken: the homeserver keeps the transaction and sends it again
          logger.warn({ err: err && err.message }, 'bridges: a transaction of the homeserver was not taken');
          answer(res, 500, { errcode: 'M_UNKNOWN', error: 'try again' });
        }
      });
    });
    server.requestTimeout = 60000;
    server.headersTimeout = 20000;
    server.keepAliveTimeout = 1000;
    server.on('error', reject);
    try { fs.mkdirSync(path.dirname(opts.socket), { recursive: true, mode: 0o700 }); } catch { /* listen() tells */ }
    // a socket file left by the process before this one
    try { if (fs.lstatSync(opts.socket).isSocket()) fs.unlinkSync(opts.socket); } catch { /* none */ }
    server.listen(opts.socket, () => {
      try { fs.chmodSync(opts.socket, 0o600); } catch { /* the folder is 0700 */ }
      server.removeListener('error', reject);
      server.on('error', (err) => logger.warn({ err: err.message }, 'bridges: listener error'));
      resolve({
        socket: opts.socket,
        close: () => new Promise((done) => {
          server.close(() => { try { fs.unlinkSync(opts.socket); } catch { /* gone */ } done(); });
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        }),
      });
    });
  });
}

module.exports = { listen, socketOf, sameToken };
