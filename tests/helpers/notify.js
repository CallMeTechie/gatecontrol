'use strict';

// Fixtures for the notification center tests: people, app devices (token +
// peer + notify_device_prefs row), peer groups, and an SSE reader for the
// push stream.

const crypto = require('node:crypto');
const http = require('node:http');

const db = () => require('../../src/db/connection').getDb();
const tokens = () => require('../../src/services/tokens');

let seq = 0;
function uniq(p) { seq += 1; return `${p}-${process.pid}-${seq}`; }

function makeUser(name, { role = 'user', language = 'de', enabled = 1 } = {}) {
  return Number(db().prepare('INSERT INTO users (username, password_hash, role, enabled, language, display_name) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uniq(name), '!', role, enabled, language, name).lastInsertRowid);
}

let ipSeq = 20;
/** App device of `userId`: peer + client token (+ notify_device_prefs unless app:false). */
function makeDevice(userId, { name = 'phone', app = true, platform = 'android', groupId = null, scopes = ['client'] } = {}) {
  ipSeq += 1;
  const ip = `10.8.0.${ipSeq % 250 + 2}`;
  const peerId = Number(db().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type, user_id, group_id) VALUES (?, ?, ?, 1, 'regular', ?, ?)")
    .run(uniq(name), crypto.randomBytes(16).toString('base64'), ip + '/32', userId, groupId).lastInsertRowid);
  const t = tokens().create({ name: uniq(name), scopes, userId, peerId }, '127.0.0.1');
  if (app) {
    db().prepare("INSERT INTO notify_device_prefs (token_id, enabled, platform, updated_at) VALUES (?, 1, ?, datetime('now'))")
      .run(t.token.id, platform);
  }
  return { tokenId: t.token.id, raw: t.rawToken, peerId, ip };
}

function makeGroup(name) {
  return Number(db().prepare('INSERT INTO peer_groups (name) VALUES (?)').run(uniq(name)).lastInsertRowid);
}

/** Remove every notification row (keeps rules, devices, prefs). */
function clearNotifications() {
  db().prepare('DELETE FROM notification_deliveries').run();
  db().prepare('DELETE FROM notifications').run();
}

function deliveries(notificationId) {
  return db().prepare('SELECT * FROM notification_deliveries WHERE notification_id = ? ORDER BY seq').all(notificationId);
}

function lastNotification() {
  return db().prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 1').get() || null;
}

/**
 * Open GET /api/v1/client/push on a listening server. Resolves after the
 * response head with { status, headers, events, body, waitFor, close }.
 */
function openStream(port, raw, { headers = {}, query = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1', port, path: `/api/v1/client/push${query}`,
      headers: { 'X-API-Token': raw, 'X-Client-Platform': 'android', 'X-Client-Version': '2.0.0', ...headers },
    }, (res) => {
      const events = [];
      const waiters = [];
      let buf = '';
      let body = '';
      let ended = false;
      const check = () => {
        for (const w of [...waiters]) {
          const hit = events.find(w.pred);
          if (hit) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(hit); }
        }
      };
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith(':')) { events.push({ comment: block.slice(1).trim() }); continue; }
          const ev = {};
          for (const line of block.split('\n')) {
            const m = /^(\w+): ?(.*)$/.exec(line);
            if (m) ev[m[1]] = m[1] === 'data' ? JSON.parse(m[2]) : m[2];
          }
          events.push(ev);
        }
        check();
      });
      res.on('end', () => { ended = true; for (const w of waiters) { clearTimeout(w.timer); w.reject(new Error('stream ended')); } waiters.length = 0; });
      resolve({
        status: res.statusCode,
        headers: res.headers,
        events,
        get body() { return body; },
        get ended() { return ended; },
        waitFor(pred, ms = 3000) {
          const hit = events.find(pred);
          if (hit) return Promise.resolve(hit);
          if (ended) return Promise.reject(new Error('stream ended'));
          return new Promise((res2, rej2) => {
            const w = { pred, resolve: res2, reject: rej2 };
            w.timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej2(new Error('timeout waiting for event; got ' + JSON.stringify(events))); }, ms);
            waiters.push(w);
          });
        },
        waitEnd(ms = 3000) {
          if (ended) return Promise.resolve();
          return new Promise((res2, rej2) => {
            const t = setTimeout(() => rej2(new Error('stream did not end')), ms);
            res.on('end', () => { clearTimeout(t); res2(); });
          });
        },
        close() { req.destroy(); },
      });
    });
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { db, makeUser, makeDevice, makeGroup, clearNotifications, deliveries, lastNotification, openStream, sleep, uniq };
