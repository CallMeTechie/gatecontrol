'use strict';

// gc.mail.dav.request, permissions.mail.dav, autoconfig with CalDAV/CardDAV,
// the calendar parts of mails (iMIP) and message.icalEvent (docs/plugins.md
// "Mail", since 1.219.0) — against the tests' own HTTPS, IMAP and SMTP
// servers on loopback, which stand in for public hosts (the certificate of a
// test CA, the ports mapped by the seams of gc.mail). No real provider.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const { testCert, imapServer, smtpServer } = require('./helpers/mailServers');
const PUI = require('../public/js/plugins-ui.js');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

let agent, csrf, runtime, plugins, hostApi, netPolicy, mail, dav, mime, manifest, registry;
let cert, web, webPort, imap, smtp;
const API = '/api/v1/plugins';
const PID = 'dav-test';
const NONE = 'dav-none';
const DAV_HOST = 'dav.test.example';
const BASE = `https://${DAV_HOST}`;
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAIL_PERM = { purpose: { de: 'Deine Postfächer lesen und Mails senden', en: 'Read your mailboxes and send mails' }, maxConnections: 4 };
const DAV_PERM = { purpose: { de: 'Deine Kalender und Adressbücher bei GMX, Web.de oder deinem eigenen Server abgleichen', en: 'Sync your calendars and address books at GMX, Web.de or your own server' } };
const AUTH = { user: 'ada@gmx.de', pass: 'Sup3r-Geheim!' };
const BASIC = Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64');
const BOMB = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024)); // ~64 KB on the wire, 64 MB unpacked

const CAL_DATA = '\nBEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:a1\nSUMMARY:Müller & Söhne <Termin>\nEND:VEVENT\nEND:VCALENDAR\n  ';
const MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/cal/a.ics</href>
    <propstat>
      <prop>
        <getetag>"a1b2"</getetag>
        <C:calendar-data><![CDATA[${CAL_DATA}]]></C:calendar-data>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
  <x:response xmlns:x="DAV:">
    <x:href>https://dav.test.example/cal/b%20c.ics</x:href>
    <x:status>HTTP/1.1 404 Not Found</x:status>
  </x:response>
  <D:response xmlns:D="DAV:">
    <D:href>/cal/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><cal:calendar xmlns:cal="urn:ietf:params:xml:ns:caldav"/></D:resourcetype>
        <D:displayname>Privat &amp; Familie &#x263A;</D:displayname>
        <A:calendar-color xmlns:A="http://apple.com/ns/ical/" symbolic-color="red">#FF0000</A:calendar-color>
        <__proto__ xmlns="">polluted?</__proto__>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
    <D:propstat>
      <D:prop><CS:getctag xmlns:CS="http://calendarserver.org/ns/"/></D:prop>
      <D:status>HTTP/1.1 404 Not Found</D:status>
    </D:propstat>
  </D:response>
  <response><href>/cal/locked.ics</href><status>HTTP/1.1 403 Forbidden</status><error><need-privileges/></error></response>
  <sync-token>http://dav.test.example/ns/sync/1234</sync-token>
</multistatus>`;
const ms = (inner) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${inner}</d:multistatus>`;
const XML_BAD = {
  xxe: '<?xml version="1.0"?><!DOCTYPE d:multistatus [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><d:multistatus xmlns:d="DAV:"><d:response><d:href>&xxe;</d:href></d:response></d:multistatus>',
  laughs: '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]><d:multistatus xmlns:d="DAV:"><d:response><d:href>&lol3;</d:href></d:response></d:multistatus>',
  undeclared: ms('<d:response><d:href>&xxe;</d:href></d:response>'),
  deep: ms('<d:x>'.repeat(70) + '</d:x>'.repeat(70)),
  many: ms('<d:response><d:href>/x</d:href></d:response>'.repeat(10001)),
  broken: ms('<d:response><d:href>/x</d:response>'),
  notMultistatus: '<?xml version="1.0"?><d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>',
};

/** POST /gc of the hello plugin `id`: any gc function by its dotted path → { ok, result } | { ok: false, code, error } */
const gcOf = async (id, fn, ...args) => (await agent.post(`${API}/${id}/api/gc`).set('X-CSRF-Token', csrf).send({ fn, args })).body;
const pluginOf = () => registry.get(PID);
const lookupCount = new Map();
let rebindPrivate = false;
const req = (o, plugin = pluginOf()) => dav.request(plugin, { auth: AUTH, ...o }, { lookup: hostApi._lookup });
const codeOf = async (p) => { try { await p; return 'ok'; } catch (e) { return e.code; } };
const seen = [];
const held = [];
const lastSeen = () => seen[seen.length - 1];
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(20); }
  return false;
}

async function install(id, permissions, extra = {}) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream')
    .send(helloPackage({ overrides: { id, name: { de: id, en: id }, permissions, ...extra } })).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
  assert.equal(await runtime.waitRunning(id), true);
  return r.body;
}

function route(rq, res, body) {
  const u = new URL(rq.url, BASE);
  const p = u.pathname;
  const xml = (status, text, type = 'application/xml; charset=utf-8') => { res.writeHead(status, { 'content-type': type }); res.end(text); };
  if (p === '/cal/' && rq.method === 'PROPFIND') return xml(207, MULTISTATUS);
  if (p === '/cal/' && rq.method === 'REPORT') return xml(207, MULTISTATUS, 'text/xml');
  if (p === '/cal/' && rq.method === 'OPTIONS') { res.writeHead(200, { dav: '1, 2, 3, calendar-access, calendar-auto-schedule', allow: 'OPTIONS, GET, PROPFIND, REPORT' }); res.end(); return; }
  if (p === '/plain207') return xml(207, MULTISTATUS, 'text/plain');
  if (p.startsWith('/bad/')) return xml(207, XML_BAD[p.slice(5)]);
  if (p === '/auth') {
    if (rq.headers.authorization === `Basic ${BASIC}`) return xml(207, ms('<d:response><d:href>/auth</d:href><d:status>HTTP/1.1 200 OK</d:status></d:response>'));
    res.writeHead(401, { 'www-authenticate': 'Basic realm="dav"', 'content-type': 'text/plain' }); res.end('who are you?'); return;
  }
  if (p === '/bearer') { res.writeHead(rq.headers.authorization === 'Bearer abc.DEF-123_~+/=' ? 204 : 401); res.end(); return; }
  if (p === '/ics') {
    if (rq.headers['if-none-match'] === '"v1"') { res.writeHead(304, { etag: '"v1"' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', etag: '"v1"', 'last-modified': 'Fri, 30 Oct 2026 10:00:00 GMT', 'set-cookie': 's=secret; Path=/' });
    res.end('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
    return;
  }
  if (p === '/put' && rq.method === 'PUT') { res.writeHead(rq.headers['if-none-match'] === '*' ? 201 : 412, { etag: '"n1"' }); res.end(); return; }
  if (p === '/put303') { res.writeHead(303, { location: '/ics' }); res.end(); return; }
  if (p === '/redirect-same') { res.writeHead(301, { location: '/cal/' }); res.end(); return; }
  if (p === '/redirect-other') { res.writeHead(302, { location: 'https://other.test.example/cal/' }); res.end('moved'); return; }
  if (p === '/redirect-port') { res.writeHead(307, { location: `https://${DAV_HOST}:8443/cal/` }); res.end(); return; }
  if (p === '/redirect-http') { res.writeHead(301, { location: `http://${DAV_HOST}/cal/` }); res.end(); return; }
  if (p === '/redirect-private') { res.writeHead(302, { location: '/cal/' }); res.end(); return; }
  const loop = /^\/loop\/(\d+)$/.exec(p);
  if (loop) { res.writeHead(302, { location: `/loop/${Number(loop[1]) + 1}` }); res.end(); return; }
  if (p === '/big-declared') { res.writeHead(200, { 'content-type': 'text/calendar', 'content-length': String(6 * 1024 * 1024) }); res.write('BEGIN'); held.push(res); return; }
  if (p === '/big-stream') {
    res.writeHead(200, { 'content-type': 'text/calendar' });
    let sent = 0;
    const chunk = Buffer.alloc(64 * 1024, 65);
    const pump = () => { while (sent < 32 * 1024 * 1024 && !res.destroyed) { sent += chunk.length; if (!res.write(chunk)) { res.once('drain', pump); return; } } res.end(); };
    pump();
    return;
  }
  if (p === '/bomb') { res.writeHead(207, { 'content-type': 'application/xml', 'content-encoding': 'gzip', 'content-length': String(BOMB.length) }); res.end(BOMB); return; }
  if (p === '/gzip') { const z = zlib.gzipSync(Buffer.from(MULTISTATUS)); res.writeHead(207, { 'content-type': 'application/xml', 'content-encoding': 'gzip' }); res.end(z); return; }
  if (p === '/hang') { held.push(res); return; }
  if (p === '/trickle') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    const t = setInterval(() => { if (res.destroyed) clearInterval(t); else res.write('x'); }, 100);
    res.on('close', () => clearInterval(t));
    return;
  }
  if (p === '/hold') { held.push(res); return; }
  if (p === '/echo') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(body); return; }
  res.writeHead(404); res.end();
}

before(async () => {
  cert = testCert([DAV_HOST, 'other.test.example', 'rebind.test.example', 'mail.test.example']);
  web = https.createServer({ key: cert.key, cert: cert.cert }, (rq, res) => {
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: rq.method, url: rq.url, host: rq.headers.host, headers: rq.headers, body });
      route(rq, res, body);
    });
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  webPort = web.address().port;
  const users = { bob: 's3cret-pass' };
  imap = imapServer({ secure: true, cert, users, messages: [] });
  smtp = smtpServer({ secure: true, cert, users });
  imap.port = await imap.start();
  smtp.port = await smtp.start();

  ({ agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  hostApi = require('../src/services/plugins/hostApi');
  netPolicy = require('../src/services/plugins/netPolicy');
  mail = require('../src/services/plugins/mail');
  dav = require('../src/services/plugins/mail/dav');
  mime = require('../src/services/plugins/mail/mime');
  manifest = require('../src/services/plugins/manifest');
  registry = require('../src/services/plugins/registry');
  netPolicy._setTestPrivateForTest({ '127.0.0.1': 'public' });
  netPolicy._setReservedForTest(['10.8.0.0/24']);
  hostApi._lookup = async (h) => {
    lookupCount.set(h, (lookupCount.get(h) || 0) + 1);
    if (h === DAV_HOST || h === 'other.test.example' || h === 'mail.test.example' || h === 'nocert.test.example') return [{ address: '127.0.0.1', family: 4 }];
    // DNS rebinding: public at first, then a private address
    if (h === 'rebind.test.example') return [{ address: rebindPrivate || lookupCount.get(h) > 1 ? '192.168.1.10' : '127.0.0.1', family: 4 }];
    if (h === 'intranet.test.example') return [{ address: '192.168.1.10', family: 4 }];
    if (h === 'mixed.test.example') return [{ address: '127.0.0.1', family: 4 }, { address: '10.0.0.3', family: 4 }];
    if (h === 'wg.test.example') return [{ address: '10.8.0.5', family: 4 }];
    if (h === 'slowdns.test.example') return new Promise(() => {});
    throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  };
  setSeams();
  const perms = clone(helloManifest.permissions);
  await install(PID, { ...perms, mail: { ...MAIL_PERM, dav: DAV_PERM } }, { media: { maxBytes: 26214400, types: ['application/pdf'], quotaDefault: '1GB' } });
  await install(NONE, { ...perms, mail: MAIL_PERM });
});

function setSeams() {
  mail._setSeams({ net: { ports: { 443: webPort, 8443: webPort, 993: imap.port, 465: smtp.port }, ca: cert.cert } });
}

after(async () => {
  for (const r of held.splice(0)) r.destroy();
  hostApi._lookup = null;
  netPolicy._setTestPrivateForTest(null);
  netPolicy._setReservedForTest(null);
  mail._setSeams(null);
  await plugins.stop();
  teardown();
  await imap.stop();
  await smtp.stop();
  web.closeAllConnections();
  await new Promise((r) => web.close(r));
});

beforeEach(() => {
  setSeams();
  lookupCount.clear();
  rebindPrivate = false;
  for (const r of held.splice(0)) r.destroy();
});

// ─── plugin.json, consent ───────────────────────

describe('permissions.mail.dav: manifest, consent, the API only with it', () => {
  const base = () => clone(helloManifest);
  const errs = (fn) => { const m = base(); fn(m); return manifest.validate(m).errors; };

  it('permissions.mail.dav { purpose } (optional); without it the mail permission is as before', () => {
    const m = base();
    m.permissions.mail = { purpose: 'Postfächer lesen' };
    assert.deepEqual(manifest.validate(m).manifest.permissions.mail, { purpose: { de: 'Postfächer lesen', en: 'Postfächer lesen' }, maxConnections: 50 });
    m.permissions.mail = { purpose: 'Postfächer lesen', maxConnections: 100, dav: { purpose: { de: 'Kalender abgleichen', en: 'Sync calendars' } } };
    assert.deepEqual(manifest.validate(m).manifest.permissions.mail, { purpose: { de: 'Postfächer lesen', en: 'Postfächer lesen' }, maxConnections: 100,
      dav: { purpose: { de: 'Kalender abgleichen', en: 'Sync calendars' } } });
    for (const bad of [true, {}, { purpose: '' }, { purpose: 'x', other: 1 }, [], 'x', { purpose: 'x'.repeat(201) }]) {
      assert.deepEqual(errs((x) => { x.permissions.mail = { purpose: 'x', dav: bad }; }), ['permissions.mail.dav: invalid (needs a purpose)'], JSON.stringify(bad));
    }
    assert.deepEqual(errs((x) => { x.permissions.mail = { purpose: 'x', caldav: { purpose: 'y' } }; }), ['permissions.mail: invalid']);
  });

  it('permissions.notify { perHour } up to 1000 (reminders of everybody through one plugin)', () => {
    const v = (n) => manifest.validate({ ...base(), permissions: { ...base().permissions, notify: n } });
    assert.equal(manifest.NOTIFY_PER_HOUR_MAX, 1000);
    assert.equal(v({ perHour: 1000 }).manifest.permissions.notifyPerHour, 1000);
    assert.equal(v({ perHour: 600 }).manifest.permissions.notifyPerHour, 600);
    for (const bad of [{ perHour: 1001 }, { perHour: 0 }]) assert.deepEqual(v(bad).errors, ['permissions.notify: invalid'], JSON.stringify(bad));
  });

  it('install dialog and plugin card: a row of its own, marked as sensitive (DE/EN); an update adding it shows as added', async () => {
    const r = await agent.get(`${API}/${PID}`).expect(200);
    const perm = r.body.plugin ? r.body.plugin.permissions : r.body.permissions;
    assert.ok(perm && perm.mail && perm.mail.dav, JSON.stringify(r.body).slice(0, 400));
    assert.ok([DAV_PERM.purpose.de, DAV_PERM.purpose.en].includes(perm.mail.dav.purpose), perm.mail.dav.purpose);
    const without = clone(perm);
    delete without.mail.dav;
    for (const dict of [de, en]) {
      const t = (k, p) => { let s = dict[k] || k; for (const [a, b] of Object.entries(p || {})) s = s.split('{{' + a + '}}').join(String(b)); return s; };
      const row = PUI.permRows(perm, t).find((x) => x.label === dict['plugins.perm.mail_dav']);
      assert.ok(row, 'dav row');
      assert.match(row.value, dict === de ? /^darf außerdem Kalender und Adressbücher auf Servern im Internet lesen und ändern \(CalDAV\/CardDAV, nur verschlüsselt\)\. Zweck: /
        : /^may also read and change calendars and address books on servers on the internet \(CalDAV\/CardDAV, encrypted only\)\. Purpose: /);
      assert.ok(row.value.endsWith(perm.mail.dav.purpose));
      assert.equal(PUI.permRows(without, t).find((x) => x.label === dict['plugins.perm.mail_dav']), undefined);
      const diff = PUI.permDiff(perm, without, t);
      assert.deepEqual(diff.rows.filter((x) => x.change).map((x) => [x.label, x.change]), [[dict['plugins.perm.mail_dav'], 'added']]);
    }
    assert.ok(PUI.sensitivePerms(perm).includes('plugins.perm.mail_dav'));
    assert.ok(!PUI.sensitivePerms(without).includes('plugins.perm.mail_dav'));
    // a mail plugin without dav keeps exactly its former summary (its updates need no new approval)
    const none = (await agent.get(`${API}/${NONE}`).expect(200)).body;
    const nonePerm = none.plugin ? none.plugin.permissions : none.permissions;
    assert.deepEqual(Object.keys(nonePerm.mail).sort(), ['maxConnections', 'purpose']);
  });

  it('without permissions.mail.dav: no gc.mail.dav in the plugin process, the host refuses with ERR_MAIL_DENIED', async () => {
    const r = await gcOf(NONE, 'mail.dav.request', { url: `${BASE}/cal/` });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'no such function');
    assert.equal(typeof (await gcOf(NONE, 'mail.autoconfig', 'x')).error, 'string', 'gc.mail itself is there');
    const n = seen.length;
    await assert.rejects(() => hostApi.handle(registry.get(NONE), 'mail.dav.request', { url: `${BASE}/cal/`, method: 'PROPFIND' }), (e) => e.code === 'ERR_MAIL_DENIED');
    assert.equal(seen.length, n, 'nothing was asked');
  });

  it('with it: through the plugin process, a PROPFIND answered as multistatus', async () => {
    const r = await gcOf(PID, 'mail.dav.request', { url: `${BASE}/cal/`, method: 'PROPFIND', headers: { depth: '1' }, auth: AUTH,
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.status, 207);
    assert.equal(r.result.body, null);
    assert.equal(r.result.multistatus.responses.length, 4);
    assert.equal(r.result.multistatus.syncToken, 'http://dav.test.example/ns/sync/1234');
    assert.equal(lastSeen().headers.authorization, `Basic ${BASIC}`);
    const bad = await gcOf(PID, 'mail.dav.request', { url: 'http://dav.test.example/cal/' });
    assert.deepEqual([bad.ok, bad.code], [false, 'ERR_NETWORK_DENIED']);
  });
});

// ─── Network ────────────────────────────────────

describe('gc.mail.dav.request: network', () => {
  it('https only, ports 443 and 8443 only → else ERR_NETWORK_DENIED before anything is sent', async () => {
    const n = seen.length;
    for (const url of [`http://${DAV_HOST}/cal/`, `http://${DAV_HOST}:443/cal/`, `https://${DAV_HOST}:80/cal/`, `https://${DAV_HOST}:8080/cal/`,
      `https://${DAV_HOST}:8444/cal/`, `ftp://${DAV_HOST}/cal/`, `webcal://${DAV_HOST}/cal/`, `file:///etc/passwd`]) {
      assert.equal(await codeOf(req({ url })), 'ERR_NETWORK_DENIED', url);
    }
    assert.equal(seen.length, n);
    assert.equal((await req({ url: `https://${DAV_HOST}:8443/cal/`, method: 'PROPFIND' })).status, 207);
    assert.equal(lastSeen().host, `${DAV_HOST}:8443`);
    assert.equal((await req({ url: `https://${DAV_HOST}:443/cal/`, method: 'PROPFIND' })).status, 207);
    assert.equal(lastSeen().host, DAV_HOST, 'the Host header names the host, never the address');
  });

  it('public addresses only: private, loopback, link-local, CGNAT, ULA, WireGuard, mixed → ERR_NETWORK_DENIED', async () => {
    const n = seen.length;
    for (const host of ['intranet.test.example', 'mixed.test.example', 'wg.test.example', '10.0.0.1', '192.168.0.10', '127.0.0.2', '169.254.169.254',
      '100.64.0.1', '[fd00::1]', '[fe80::1]', '[::1]', '0.0.0.0', '224.0.0.1', '[::ffff:192.168.0.1]']) {
      assert.equal(await codeOf(req({ url: `https://${host}/cal/` })), 'ERR_NETWORK_DENIED', host);
    }
    assert.equal(seen.length, n);
    assert.equal(await codeOf(req({ url: 'https://nowhere.test.example/cal/' })), 'ERR_MAIL_NET', 'a name that does not resolve');
  });

  it('DNS pinned: one lookup per request, the connection goes to the checked address', async () => {
    const r = await req({ url: 'https://rebind.test.example/cal/', method: 'PROPFIND' });
    assert.equal(r.status, 207);
    assert.equal(lookupCount.get('rebind.test.example'), 1, 'no second lookup between the check and the connection');
    assert.equal(lastSeen().host, 'rebind.test.example');
  });

  it('DNS rebinding to a private address on a redirect → ERR_NETWORK_DENIED, the private address is never asked', async () => {
    const n = seen.length;
    assert.equal(await codeOf(req({ url: 'https://rebind.test.example/redirect-private', method: 'PROPFIND' })), 'ERR_NETWORK_DENIED');
    assert.equal(seen.length, n + 1, 'only the first, public hop reached a server');
    assert.equal(lookupCount.get('rebind.test.example'), 2, 'every hop is checked again');
    rebindPrivate = true;
    assert.equal(await codeOf(req({ url: 'https://rebind.test.example/cal/' })), 'ERR_NETWORK_DENIED');
    assert.equal(seen.length, n + 1);
  });

  it('TLS: the certificate is always checked against the host name; at least TLS 1.2', async () => {
    const n = seen.length;
    const e = await req({ url: 'https://nocert.test.example/cal/' }).catch((x) => x);
    assert.equal(e.code, 'ERR_MAIL_NET');
    assert.match(e.message, /^TLS: /);
    assert.equal(seen.length, n, 'the request never left the TLS handshake');
    mail._setSeams({ net: { ports: { 443: webPort }, ca: null } });
    const e2 = await req({ url: `${BASE}/cal/` }).catch((x) => x);
    assert.equal(e2.code, 'ERR_MAIL_NET', 'a certificate of an unknown CA');
    assert.match(e2.message, /^TLS: /);
    const o = require('../src/services/plugins/mail/net').tlsOptions(DAV_HOST);
    assert.equal(o.rejectUnauthorized, true);
    assert.equal(o.minVersion, 'TLSv1.2');
  });

  it('DNS and the connection within timeoutMs', async () => {
    const t0 = Date.now();
    const e = await req({ url: 'https://slowdns.test.example/cal/', timeoutMs: 1000 }).catch((x) => x);
    assert.equal(e.code, 'ERR_MAIL_NET');
    assert.ok(Date.now() - t0 < 4000, `${Date.now() - t0} ms`);
  });
});

// ─── Methods, headers, credentials ──────────────

describe('gc.mail.dav.request: methods, headers, credentials', () => {
  it('only GET HEAD OPTIONS PROPFIND REPORT PUT DELETE', async () => {
    const n = seen.length;
    for (const method of ['POST', 'PATCH', 'MKCOL', 'MKCALENDAR', 'MOVE', 'COPY', 'TRACE', 'CONNECT', 'LOCK', 'GET\r\nX: 1', 'PROPPATCH', '', 5]) {
      assert.equal(await codeOf(req({ url: `${BASE}/cal/`, method })), 'ERR_INVALID', String(method));
    }
    assert.equal(seen.length, n);
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'PROPFIND', 'REPORT', 'PUT', 'DELETE', 'propfind']) {
      await req({ url: `${BASE}/echo`, method });
      assert.equal(lastSeen().method, method.toUpperCase());
    }
    const r = await req({ url: `${BASE}/cal/`, method: 'OPTIONS' });
    assert.equal(r.headers.dav, '1, 2, 3, calendar-access, calendar-auto-schedule');
    assert.equal(r.headers.allow, 'OPTIONS, GET, PROPFIND, REPORT');
  });

  it('only the allowed headers; authorization, cookie, host and the rest → ERR_INVALID', async () => {
    const n = seen.length;
    for (const headers of [{ authorization: `Basic ${BASIC}` }, { Authorization: 'Bearer x' }, { cookie: 'a=1' }, { host: 'evil.example' }, { referer: 'x' },
      { 'user-agent': 'x' }, { 'x-http-method-override': 'MKCOL' }, { 'proxy-authorization': 'x' }, { 'content-length': '5' }, { 'transfer-encoding': 'chunked' },
      { depth: '1\r\nAuthorization: Basic eA==' }, { depth: '1\nx' }, { depth: 'x\u0000' }, { depth: {} }, { depth: '1', Depth: '0' }, []]) {
      assert.equal(await codeOf(req({ url: `${BASE}/cal/`, method: 'PROPFIND', headers })), 'ERR_INVALID', JSON.stringify(headers));
    }
    assert.equal(seen.length, n);
    await req({ url: `${BASE}/echo`, method: 'REPORT', body: '<x/>', headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8', 'if-match': '"a"',
      'if-none-match': '"b"', prefer: 'return=minimal', brief: 't', accept: 'application/xml', 'if-modified-since': 'Fri, 30 Oct 2026 10:00:00 GMT' } });
    const h = lastSeen().headers;
    assert.deepEqual([h.depth, h['content-type'], h['if-match'], h['if-none-match'], h.prefer, h.brief, h.accept, h['if-modified-since']],
      ['1', 'application/xml; charset=utf-8', '"a"', '"b"', 'return=minimal', 't', 'application/xml', 'Fri, 30 Oct 2026 10:00:00 GMT']);
    assert.equal(h['user-agent'], 'GateControl-Mail');
    assert.equal(h.cookie, undefined);
    assert.equal(h.referer, undefined);
    assert.equal(h['accept-encoding'], 'identity');
    assert.equal(lastSeen().body, '<x/>');
  });

  it('credentials only as auth: Basic or Bearer built by the host; never in the url; anonymous without', async () => {
    const r = await req({ url: `${BASE}/auth`, method: 'PROPFIND' });
    assert.equal(r.status, 207);
    assert.equal(r.multistatus.responses[0].status, 200);
    assert.equal((await req({ url: `${BASE}/bearer`, auth: { bearer: 'abc.DEF-123_~+/=' } })).status, 204);
    const anon = await dav.request(pluginOf(), { url: `${BASE}/auth`, method: 'PROPFIND' }, { lookup: hostApi._lookup });
    assert.equal(lastSeen().headers.authorization, undefined);
    assert.equal(anon.status, 401, '401 is a status, not an error');
    assert.equal(anon.body, 'who are you?');
    const n = seen.length;
    for (const o of [{ url: `https://ada:pw@${DAV_HOST}/auth` }, { url: `https://ada@${DAV_HOST}/auth` }, { auth: { user: 'a:b', pass: 'x' } },
      { auth: { user: 'a', pass: '' } }, { auth: { user: 'a', pass: 'x\r\nX-Evil: 1' } }, { auth: { user: 'a', pass: 'x', bearer: 'y' } },
      { auth: { bearer: 'a b' } }, { auth: { bearer: 'x\r\n' } }, { auth: { user: 'a' } }, { auth: 'Basic x' }, { auth: { user: 'a', pass: 'x', digest: true } }]) {
      assert.equal(await codeOf(req({ url: `${BASE}/auth`, ...o })), 'ERR_INVALID', JSON.stringify(o));
    }
    assert.equal(seen.length, n);
  });

  it('cookies: none sent, Set-Cookie dropped; only the listed response headers', async () => {
    const r = await req({ url: `${BASE}/ics` });
    assert.equal(r.status, 200);
    assert.equal(r.body, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', 'the body as it came (not parsed: no 207)');
    assert.equal(r.multistatus, null);
    assert.deepEqual(Object.keys(r.headers).sort(), ['content-type', 'etag', 'last-modified']);
    await req({ url: `${BASE}/ics` });
    assert.equal(lastSeen().headers.cookie, undefined);
    const nm = await req({ url: `${BASE}/ics`, headers: { 'if-none-match': '"v1"' } });
    assert.equal(nm.status, 304);
  });

  it('PUT with If-None-Match, 412 as a status, body ≤ 2 MB, no body on GET/HEAD', async () => {
    assert.equal((await req({ url: `${BASE}/put`, method: 'PUT', headers: { 'if-none-match': '*', 'content-type': 'text/calendar' }, body: 'BEGIN:VCALENDAR' })).status, 201);
    const r = await req({ url: `${BASE}/put`, method: 'PUT', headers: { 'if-match': '"old"' }, body: 'x' });
    assert.deepEqual([r.status, r.headers.etag], [412, '"n1"']);
    assert.equal(await codeOf(req({ url: `${BASE}/put`, method: 'PUT', body: 'x'.repeat(2 * 1024 * 1024 + 1) })), 'ERR_MAIL_LIMIT');
    assert.equal(await codeOf(req({ url: `${BASE}/put`, method: 'PUT', body: Buffer.from('x') })), 'ERR_INVALID');
    assert.equal(await codeOf(req({ url: `${BASE}/ics`, method: 'GET', body: 'x' })), 'ERR_INVALID');
    assert.equal(await codeOf(req({ url: `${BASE}/ics`, parse: 'xml' })), 'ERR_INVALID');
    assert.equal(await codeOf(req({ url: `${BASE}/ics`, maxBytes: 0 })), 'ERR_INVALID');
    assert.equal(await codeOf(req({ url: 'not a url' })), 'ERR_INVALID');
    assert.equal(await codeOf(dav.request(pluginOf(), null, {})), 'ERR_INVALID');
  });

  it('the credentials never appear in an error', async () => {
    const errs = [];
    for (const url of [`${BASE}/hang`, 'https://nocert.test.example/cal/', 'https://nowhere.test.example/', 'https://intranet.test.example/', `${BASE}/big-declared`]) {
      errs.push(await req({ url, timeoutMs: 1000, maxBytes: 1024 }).catch((e) => e));
    }
    errs.push(await req({ url: `${BASE}/loop/0` }).catch((e) => e));
    for (const e of errs) {
      assert.ok(e && e.code, String(e));
      const text = JSON.stringify({ message: e.message, ...e });
      for (const secret of [AUTH.pass, BASIC, AUTH.user]) assert.ok(!text.includes(secret), `${e.code}: ${text}`);
    }
  });
});

// ─── Redirects ──────────────────────────────────

describe('gc.mail.dav.request: redirects', () => {
  it('within the same origin: followed with auth, each hop checked again', async () => {
    const r = await req({ url: `${BASE}/redirect-same`, method: 'PROPFIND', headers: { depth: '0' }, body: '<x/>' });
    assert.equal(r.status, 207);
    assert.equal(r.url, `${BASE}/cal/`);
    const [a, b] = seen.slice(-2);
    assert.deepEqual([a.url, b.url], ['/redirect-same', '/cal/']);
    assert.equal(b.method, 'PROPFIND', 'the method stays');
    assert.equal(b.body, '<x/>');
    assert.equal(b.headers.authorization, `Basic ${BASIC}`);
    assert.equal(lookupCount.get(DAV_HOST), 2);
  });

  it('to another origin (host or port): not followed — the 3xx with headers.location, no credentials sent there', async () => {
    const n = seen.length;
    const r = await req({ url: `${BASE}/redirect-other`, method: 'PROPFIND' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, 'https://other.test.example/cal/');
    assert.equal(r.body, 'moved');
    assert.equal(r.url, `${BASE}/redirect-other`);
    assert.equal(seen.length, n + 1, 'other.test.example was never asked');
    assert.ok(!seen.some((s) => s.host && s.host.startsWith('other.test.example')));
    assert.equal(lookupCount.get('other.test.example'), undefined);
    const p = await req({ url: `${BASE}/redirect-port` });
    assert.deepEqual([p.status, p.headers.location], [307, `https://${DAV_HOST}:8443/cal/`]);
    assert.equal(seen.length, n + 2);
  });

  it('never to http: the 3xx comes back', async () => {
    const n = seen.length;
    const r = await req({ url: `${BASE}/redirect-http` });
    assert.deepEqual([r.status, r.headers.location], [301, `http://${DAV_HOST}/cal/`]);
    assert.equal(seen.length, n + 1);
  });

  it('at most 5 redirects; 303 turns into GET without a body', async () => {
    const n = seen.length;
    const e = await req({ url: `${BASE}/loop/0` }).catch((x) => x);
    assert.equal(e.code, 'ERR_MAIL_NET');
    assert.match(e.message, /redirects/);
    assert.equal(seen.length, n + 6);
    const r = await req({ url: `${BASE}/put303`, method: 'PUT', headers: { 'content-type': 'text/calendar' }, body: 'BEGIN:VCALENDAR' });
    assert.equal(r.status, 200);
    assert.equal(lastSeen().method, 'GET');
    assert.equal(lastSeen().body, '');
    assert.equal(lastSeen().headers['content-type'], undefined);
  });
});

// ─── Size and time ──────────────────────────────

describe('gc.mail.dav.request: size and time', () => {
  it('a declared length over maxBytes is refused at once', async () => {
    const t0 = Date.now();
    const e = await req({ url: `${BASE}/big-declared`, maxBytes: 1024 * 1024 }).catch((x) => x);
    assert.equal(e.code, 'ERR_MAIL_LIMIT');
    assert.ok(Date.now() - t0 < 2000);
  });

  it('a stream over maxBytes is cut off (default 5 MB, at most 20 MB)', async () => {
    let e = await req({ url: `${BASE}/big-stream`, maxBytes: 100 * 1024 }).catch((x) => x);
    assert.equal(e.code, 'ERR_MAIL_LIMIT');
    e = await req({ url: `${BASE}/big-stream` }).catch((x) => x);
    assert.equal(e.code, 'ERR_MAIL_LIMIT');
    assert.match(e.message, /5242880/);
    e = await req({ url: `${BASE}/big-stream`, maxBytes: 100 * 1024 * 1024, timeoutMs: 60000 }).catch((x) => x);
    assert.equal(e.code, 'ERR_MAIL_LIMIT');
    assert.match(e.message, /20971520/);
  });

  it('a compression bomb: counted after unpacking → ERR_MAIL_LIMIT; honest gzip is read', async () => {
    const before = process.memoryUsage().rss;
    const e = await req({ url: `${BASE}/bomb`, method: 'PROPFIND', maxBytes: 100 * 1024 * 1024 }).catch((x) => x);
    assert.equal(e.code, 'ERR_MAIL_LIMIT');
    assert.ok(process.memoryUsage().rss - before < 200 * 1024 * 1024);
    const r = await req({ url: `${BASE}/gzip`, method: 'PROPFIND' });
    assert.equal(r.multistatus.responses.length, 4);
  });

  it('the whole request within timeoutMs (no answer, a trickling body)', async () => {
    for (const p of ['/hang', '/trickle']) {
      const t0 = Date.now();
      const e = await req({ url: `${BASE}${p}`, timeoutMs: 1000 }).catch((x) => x);
      assert.equal(e.code, 'ERR_MAIL_NET', p);
      assert.equal(e.message, 'timeout');
      const took = Date.now() - t0;
      assert.ok(took >= 900 && took < 4000, `${p}: ${took} ms`);
    }
    assert.equal(dav.callTimeout({ timeoutMs: 999999 }), 2 * 60 * 1000 + 60000 + 15000, 'timeoutMs at most 60 s');
  });

  it('8 requests per plugin at a time, more wait; the plugin process ending ends them', async () => {
    const start = seen.length;
    const all = Array.from({ length: 10 }, () => req({ url: `${BASE}/hold`, timeoutMs: 20000 }).catch((e) => e));
    assert.ok(await until(() => held.length === 8), `held ${held.length}`);
    await sleep(100);
    assert.equal(held.length, 8);
    assert.deepEqual(dav.stats(PID), { running: 8, waiting: 2, active: 8 });
    for (const r of held.splice(0)) { r.writeHead(200); r.end('ok'); }
    assert.ok(await until(() => held.length === 2));
    for (const r of held.splice(0)) { r.writeHead(200); r.end('ok'); }
    const results = await Promise.all(all);
    assert.ok(results.every((r) => r.status === 200), JSON.stringify(results));
    assert.equal(seen.length - start, 10);
    // closeAll (the process ended): running and waiting requests end at once
    const more = Array.from({ length: 9 }, () => req({ url: `${BASE}/hold`, timeoutMs: 20000 }).catch((e) => e));
    assert.ok(await until(() => held.length === 8));
    mail.closeAll(PID);
    const ended = await Promise.all(more);
    assert.ok(ended.every((e) => e.code === 'ERR_MAIL_NET'), JSON.stringify(ended.map((e) => e.code)));
    assert.deepEqual(dav.stats(PID), { running: 0, waiting: 0, active: 0 });
  });
});

// ─── XML ────────────────────────────────────────

describe('gc.mail.dav.request: multistatus (saxes, namespace-exact, no DTD)', () => {
  it('prefixes do not matter, CDATA stays as it is, hrefs absolute, statuses, errors, sync-token', async () => {
    const r = await req({ url: `${BASE}/cal/`, method: 'REPORT', body: '<x/>' });
    assert.equal(r.status, 207);
    assert.equal(r.body, null);
    const [a, b, c, d] = r.multistatus.responses;
    assert.equal(a.href, `${BASE}/cal/a.ics`);
    assert.equal(a.status, null);
    assert.equal(a.propstat[0].status, 200);
    assert.equal(a.propstat[0].props['{DAV:}getetag'].text, '"a1b2"');
    assert.equal(a.propstat[0].props['{urn:ietf:params:xml:ns:caldav}calendar-data'].text, CAL_DATA, 'not trimmed, not changed');
    assert.equal(a.error, null);
    assert.deepEqual([b.href, b.status, b.propstat], [`${BASE}/cal/b%20c.ics`, 404, []]);
    assert.equal(c.href, `${BASE}/cal/`);
    const props = c.propstat[0].props;
    assert.deepEqual(props['{DAV:}resourcetype'], { text: null, children: [{ name: '{DAV:}collection', text: null }, { name: '{urn:ietf:params:xml:ns:caldav}calendar', text: null }] });
    assert.equal(props['{DAV:}displayname'].text, 'Privat & Familie ☺');
    assert.deepEqual(props['{http://apple.com/ns/ical/}calendar-color'], { text: '#FF0000', attrs: { 'symbolic-color': 'red' } });
    assert.deepEqual(c.propstat[1], { status: 404, props: { '{http://calendarserver.org/ns/}getctag': { text: null } } });
    assert.ok(Object.prototype.hasOwnProperty.call(props, '__proto__'), 'a property named __proto__ is just a property');
    assert.equal(Object.getPrototypeOf(props), Object.prototype);
    assert.equal({}.text, undefined);
    assert.deepEqual([d.status, d.error], [403, { text: null, children: [{ name: '{DAV:}need-privileges', text: null }] }]);
    assert.equal(r.multistatus.syncToken, 'http://dav.test.example/ns/sync/1234');
    assert.deepEqual(r.headers, { 'content-type': 'text/xml' });
  });

  it('parse: "none", or a 207 that is not XML → the body as text', async () => {
    const n = await req({ url: `${BASE}/cal/`, method: 'PROPFIND', parse: 'none' });
    assert.deepEqual([n.status, n.multistatus, n.body], [207, null, MULTISTATUS]);
    const t = await req({ url: `${BASE}/plain207` });
    assert.deepEqual([t.status, t.multistatus, t.body], [207, null, MULTISTATUS]);
  });

  for (const [name, why] of [['xxe', 'an external entity (XXE)'], ['laughs', 'entity expansion ("billion laughs")'], ['undeclared', 'an entity without a DTD'],
    ['deep', 'deeper than 64 levels'], ['many', 'more than 10 000 responses'], ['broken', 'broken XML'], ['notMultistatus', 'not DAV:multistatus']]) {
    it(`ERR_DAV_XML: ${why}`, async () => {
      const e = await req({ url: `${BASE}/bad/${name}`, method: 'PROPFIND' }).catch((x) => x);
      assert.equal(e.code, 'ERR_DAV_XML', String(e && e.message));
      assert.ok(!/root:|passwd|lollol/.test(e.message), e.message);
    });
  }

  it('exactly 10 000 responses and 64 levels still pass', () => {
    const many = dav.parseMultistatus(ms('<d:response><d:href>/x</d:href></d:response>'.repeat(10000)), BASE);
    assert.equal(many.responses.length, 10000);
    const deep = dav.parseMultistatus(ms(`<d:response><d:href>/x</d:href><d:propstat><d:prop>${'<d:x>'.repeat(60)}${'</d:x>'.repeat(60)}</d:prop></d:propstat></d:response>`), BASE);
    assert.equal(deep.responses.length, 1);
  });
});

// ─── Autoconfig ─────────────────────────────────

describe('gc.mail.autoconfig with CalDAV/CardDAV', () => {
  const ac = () => require('../src/services/plugins/mail/autoconfig');
  const XML = (extra) => `<?xml version="1.0"?><clientConfig version="1.1"><emailProvider id="x"><domain>firma.example</domain>
    <incomingServer type="imap"><hostname>imap.firma.example</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
    <outgoingServer type="smtp"><hostname>smtp.firma.example</hostname><port>465</port><socketType>SSL</socketType></outgoingServer></emailProvider>${extra}</clientConfig>`;
  const CAL = (url, auth = 'http-basic') => `<calendar type="caldav"><username>%EMAILADDRESS%</username><authentication>${auth}</authentication><serverURL>${url}</serverURL></calendar>`;
  const CARD = (url, auth = 'http-basic') => `<addressBook type="carddav"><username>%EMAILADDRESS%</username><authentication>${auth}</authentication><serverURL>${url}</serverURL></addressBook>`;
  const noDns = { resolveSrv: async () => [], resolveMx: async () => [], resolveTxt: async () => [] };

  it('<calendar type="caldav"> / <addressBook type="carddav"> of the ISPDB file (placeholders, https on 443/8443, no OAuth)', async () => {
    let r = await ac().autoconfig('ada@firma.example', { resolver: noDns, fetchXml: async (u) => (u.startsWith('https://autoconfig.thunderbird.net/')
      ? XML(CAL('https://dav.%EMAILDOMAIN%/caldav/%EMAILADDRESS%/') + CARD('https://dav.firma.example:8443/carddav/')) : null) });
    assert.equal(r.source, 'ispdb');
    assert.deepEqual(r.caldav, { url: 'https://dav.firma.example/caldav/ada@firma.example/' });
    assert.deepEqual(r.carddav, { url: 'https://dav.firma.example:8443/carddav/' });
    for (const bad of [CAL('http://dav.firma.example/') + CARD('https://dav.firma.example:8080/'), CAL('https://www.googleapis.com/caldav/v2/', 'OAuth2') + CARD('https://u:p@dav.firma.example/'),
      CAL('javascript:alert(1)') + CARD('ftp://dav.firma.example/')]) {
      r = await ac().autoconfig('ada@firma.example', { resolver: noDns, fetchXml: async (u) => (u.startsWith('https://autoconfig.thunderbird.net/') ? XML(bad) : null) });
      assert.deepEqual([r.source, r.caldav, r.carddav], ['ispdb', null, null], bad);
    }
  });

  it('else DNS SRV _caldavs._tcp / _carddavs._tcp with TXT path= (443 / 8443 only)', async () => {
    const asked = [];
    const resolver = {
      resolveMx: async () => [],
      resolveSrv: async (n) => { asked.push(n); return ({
        '_caldavs._tcp.firma.example': [{ name: 'cal.firma.example.', port: 443, priority: 0, weight: 0 }],
        '_carddavs._tcp.firma.example': [{ name: 'http.firma.example', port: 80, priority: 0, weight: 0 }, { name: 'card.firma.example', port: 8443, priority: 5, weight: 0 }],
      })[n] || []; },
      resolveTxt: async (n) => (n === '_caldavs._tcp.firma.example' ? [['path=/dav/cal/']] : []),
    };
    const r = await ac().autoconfig('ada@firma.example', { resolver, fetchXml: async () => null });
    assert.deepEqual([r.imap, r.smtp, r.source], [null, null, null]);
    assert.deepEqual(r.caldav, { url: 'https://cal.firma.example/dav/cal/' });
    assert.deepEqual(r.carddav, { url: 'https://card.firma.example:8443/.well-known/carddav' });
    assert.ok(asked.includes('_caldavs._tcp.firma.example') && asked.includes('_carddavs._tcp.firma.example'));
    const none = await ac().autoconfig('ada@firma.example', { resolver: { ...resolver, resolveSrv: async (n) => (n.startsWith('_ca') ? [{ name: '.', port: 443, priority: 0, weight: 0 }] : []) },
      fetchXml: async () => null });
    assert.deepEqual([none.caldav, none.carddav], [null, null]);
  });

  it('through the plugin process: the older fields as before, plus caldav and carddav', async () => {
    mail._setSeams({ net: { ports: { 443: webPort }, ca: cert.cert }, resolver: noDns, fetchXml: async (u) => (u === 'https://autoconfig.thunderbird.net/v1.1/gmx.de'
      ? XML(CAL('https://caldav.gmx.net') + CARD('https://carddav.gmx.net/.well-known/carddav')) : null) });
    const r = await gcOf(PID, 'mail.autoconfig', 'ada@gmx.de');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.result, { imap: { host: 'imap.firma.example', port: 993, security: 'tls' }, smtp: { host: 'smtp.firma.example', port: 465, security: 'tls' },
      source: 'ispdb', caldav: { url: 'https://caldav.gmx.net/' }, carddav: { url: 'https://carddav.gmx.net/.well-known/carddav' } });
  });
});

// ─── iMIP ───────────────────────────────────────

const ICS = (method, extra = '') => ['BEGIN:VCALENDAR', 'PRODID:-//Test//EN', 'VERSION:2.0', `METHOD:${method}`, 'BEGIN:VEVENT', 'UID:040000008200E00074C5B7101A82E008',
  'DTSTART;TZID=Europe/Berlin:20261104T130000', 'DTEND;TZID=Europe/Berlin:20261104T140000', 'SUMMARY;LANGUAGE=de-DE:Planung Kalender und Kont',
  ' akte – Müller', 'ORGANIZER;CN=Anna Lang:mailto:anna@firma.example', 'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:bob@example.com', extra,
  'END:VEVENT', 'END:VCALENDAR', ''].filter((l, i, a) => l !== '' || i === a.length - 1).join('\r\n');
const b64 = (s, enc = 'utf8') => Buffer.from(s, enc).toString('base64').replace(/.{76}/g, '$&\r\n');
const head = (subject, type) => ['From: Anna Lang <anna@firma.example>', 'To: bob@example.com', `Subject: ${subject}`, 'Date: Fri, 30 Oct 2026 10:00:00 +0100',
  `Message-ID: <${crypto.randomUUID()}@firma.example>`, 'MIME-Version: 1.0', `Content-Type: ${type}`, ''];
const INVITES = {
  // Outlook / Exchange: multipart/alternative, the calendar base64 with method= in the Content-Type
  outlook: [...head('Planung', 'multipart/alternative; boundary="_000_"'), '--_000_', 'Content-Type: text/plain; charset="utf-8"', 'Content-Transfer-Encoding: base64', '',
    b64('Hallo Bob'), '--_000_', 'Content-Type: text/html; charset="utf-8"', '', '<p>Hallo Bob</p>', '--_000_',
    'Content-Type: text/calendar; charset="utf-8"; method=REQUEST', 'Content-Transfer-Encoding: base64', '', b64(ICS('REQUEST')), '--_000_--', ''].join('\r\n'),
  // Google: the calendar in the alternative (7bit) and again as invite.ics attachment (application/ics)
  google: [...head('Einladung: Planung', 'multipart/mixed; boundary="m"'), '--m', 'Content-Type: multipart/alternative; boundary="a"', '', '--a',
    'Content-Type: text/plain; charset="UTF-8"', '', 'Einladung', '--a', 'Content-Type: text/calendar; charset="UTF-8"; method=REQUEST', 'Content-Transfer-Encoding: 7bit', '',
    ICS('REQUEST'), '--a--', '--m', 'Content-Type: application/ics; name="invite.ics"', 'Content-Disposition: attachment; filename="invite.ics"',
    'Content-Transfer-Encoding: base64', '', b64(ICS('REQUEST')), '--m--', ''].join('\r\n'),
  // GMX / Web.de: the calendar as attachment invite.ics, quoted-printable, a cancellation
  gmx: [...head('Abgesagt: Planung', 'multipart/mixed; boundary="b"'), '--b', 'Content-Type: text/plain; charset=UTF-8', '', 'Abgesagt', '--b',
    'Content-Type: text/calendar; charset=UTF-8; method=CANCEL; name=invite.ics', 'Content-Transfer-Encoding: quoted-printable', 'Content-Disposition: attachment; filename=invite.ics', '',
    ICS('CANCEL').replace(/ü/g, '=C3=BC').replace(/–/g, '=E2=80=93'), '--b--', ''].join('\r\n'),
};

describe('iMIP: the calendar parts of a mail', () => {
  const parse = (raw) => mime.parse(Readable.from([Buffer.from(raw)]), { plugin: { id: PID }, mode: 'meta' });

  it('Outlook, Google and GMX invitations → calendar: [{ partId, method, text }]; still in attachments', async () => {
    const o = await parse(INVITES.outlook);
    assert.equal(o.calendar.length, 1);
    assert.equal(o.calendar[0].method, 'REQUEST');
    assert.equal(o.calendar[0].partId, '3');
    assert.equal(o.calendar[0].text, ICS('REQUEST'), 'decoded, UTF-8, unchanged');
    assert.equal(o.text, 'Hallo Bob');
    assert.ok(o.attachments.some((a) => a.contentType === 'text/calendar'));
    const g = await parse(INVITES.google);
    assert.deepEqual(g.calendar.map((c) => [c.partId, c.method]), [['1.2', 'REQUEST'], ['2', 'REQUEST']]);
    assert.ok(g.calendar.every((c) => c.text === ICS('REQUEST')));
    assert.deepEqual(g.attachments.map((a) => a.contentType), ['text/calendar', 'application/ics']);
    const x = await parse(INVITES.gmx);
    assert.deepEqual(x.calendar.map((c) => c.method), ['CANCEL']);
    assert.ok(x.calendar[0].text.includes('akte – Müller'));
    const none = await parse(head('Hallo', 'text/plain; charset=utf-8').concat(['Hallo', '']).join('\r\n'));
    assert.deepEqual(none.calendar, []);
  });

  it('charset, METHOD from the file or the Content-Type, ≤ 512 KB each, at most 3, only iCalendar files', async () => {
    const part = (type, body, enc = 'base64', name = null) => ['--b', `Content-Type: ${type}`, `Content-Transfer-Encoding: ${enc}`,
      ...(name ? [`Content-Disposition: attachment; filename="${name}"`] : []), '', body];
    const raw = (...parts) => [...head('x', 'multipart/mixed; boundary="b"'), ...parts.flat(), '--b--', ''].join('\r\n');
    let m = await parse(raw(part('text/calendar; charset=iso-8859-1', b64(ICS('REPLY'), 'latin1').replace('–', '-'))));
    assert.equal(m.calendar[0].method, 'REPLY');
    assert.ok(m.calendar[0].text.includes('Müller'), 'latin-1 decoded');
    m = await parse(raw(part('text/calendar; method=CANCEL', b64(ICS('X').replace('METHOD:X\r\n', '')))));
    assert.equal(m.calendar[0].method, 'CANCEL', 'from the Content-Type when the file has no METHOD');
    m = await parse(raw(part('text/calendar', b64(ICS('X-UNKNOWN')))));
    assert.equal(m.calendar[0].method, null);
    m = await parse(raw(part('application/octet-stream', b64(ICS('COUNTER')), 'base64', 'termin.ICS'), part('application/octet-stream', b64('not a calendar'), 'base64', 'x.ics')));
    assert.deepEqual(m.calendar.map((c) => c.method), ['COUNTER'], 'an .ics attachment counts, a file that is no iCalendar not');
    const big = ICS('REQUEST', `DESCRIPTION:${'x'.repeat(520 * 1024)}`);
    m = await parse(raw(part('text/calendar', b64(big)), part('text/calendar', b64(ICS('PUBLISH'))), part('text/calendar', b64(ICS('REQUEST'))),
      part('text/calendar', b64(ICS('DECLINECOUNTER'))), part('text/calendar', b64(ICS('REPLY')))));
    assert.deepEqual(m.calendar.map((c) => c.method), ['PUBLISH', 'REQUEST', 'DECLINECOUNTER'], 'the large one is missing, then the first 3');
    assert.equal(m.attachments.length, 5, 'all of them stay attachments');
  });

  it('s.message() over IMAP has them too', async () => {
    imap.state.mailboxes.INBOX.messages.push({ uid: 1, flags: [], raw: INVITES.outlook });
    const s = await mail.imapConnect(pluginOf(), { host: 'mail.test.example', port: 993, security: 'tls', auth: { user: 'bob', pass: 's3cret-pass' } }, { emit() {} }, { lookup: hostApi._lookup });
    try {
      await mail.imapCall(pluginOf(), { id: s.id, op: 'open', args: ['INBOX'] });
      const msg = await mail.imapCall(pluginOf(), { id: s.id, op: 'message', args: [1] });
      assert.deepEqual(msg.calendar.map((c) => c.method), ['REQUEST']);
      assert.equal(msg.calendar[0].text, ICS('REQUEST'));
    } finally { mail.imapClose(pluginOf(), { id: s.id }); }
  });
});

describe('iMIP: message.icalEvent', () => {
  const msg = (icalEvent) => ({ from: 'bob@example.com', to: ['anna@firma.example'], subject: 'Zugesagt: Planung', text: 'Bis dann', icalEvent });

  it('compose: text/calendar with method= as alternative plus invite.ics; parse finds it again', async () => {
    const { raw } = await mime.compose({ id: PID }, msg({ method: 'REPLY', content: ICS('REPLY') }));
    const text = raw.toString('utf8');
    assert.match(text, /Content-Type: multipart\/alternative/);
    assert.match(text, /Content-Type: text\/calendar; charset=utf-8; method=REPLY/);
    assert.match(text, /Content-Type: application\/ics; name=invite\.ics/);
    assert.match(text, /Content-Disposition: attachment; filename=invite\.ics/);
    const back = await mime.parse(Readable.from([raw]), { plugin: { id: PID }, mode: 'meta' });
    assert.deepEqual(back.calendar.map((c) => c.method), ['REPLY', 'REPLY']);
    assert.equal(back.calendar[0].text.replace(/\r\n/g, '\n'), ICS('REPLY').replace(/\r\n/g, '\n'));
    const named = (await mime.compose({ id: PID }, msg({ method: 'request', content: ICS('REQUEST'), filename: 'termin.ics' }))).raw.toString('utf8');
    assert.match(named, /method=REQUEST/);
    assert.match(named, /filename=termin\.ics/);
  });

  it('checked: method, METHOD in the file, BEGIN:VCALENDAR, ≤ 512 KB, filename, no path or URL', async () => {
    const code = (ev) => mime.compose({ id: PID }, msg(ev)).then(() => 'ok', (e) => e.code);
    assert.equal(await code({ method: 'PUBLISH', content: ICS('PUBLISH') }), 'ERR_INVALID');
    assert.equal(await code({ method: 'REQUEST', content: ICS('CANCEL') }), 'ERR_INVALID');
    assert.equal(await code({ method: 'REQUEST', content: ICS('REQUEST').replace('METHOD:REQUEST\r\n', '') }), 'ERR_INVALID');
    assert.equal(await code({ method: 'REQUEST', content: ICS('REQUEST').replace('METHOD:REQUEST', 'METHOD:REQUEST\r\nMETHOD:CANCEL') }), 'ERR_INVALID');
    assert.equal(await code({ method: 'REQUEST', content: 'X' + ICS('REQUEST') }), 'ERR_INVALID');
    assert.equal(await code({ method: 'REQUEST', content: ICS('REQUEST', `DESCRIPTION:${'x'.repeat(512 * 1024)}`) }), 'ERR_INVALID');
    assert.equal(await code({ method: 'REQUEST', content: ICS('REQUEST'), filename: 'invite.exe' }), 'ERR_INVALID');
    assert.equal(await code({ method: 'REQUEST', content: ICS('REQUEST'), filename: '../x.ics' }), 'ERR_INVALID');
    assert.equal(await code({ method: 'REQUEST', path: '/etc/passwd' }), 'ERR_INVALID');
    assert.equal(await code({ method: 'REQUEST', content: ICS('REQUEST'), href: 'https://example.com/x.ics' }), 'ERR_INVALID');
    assert.equal(await code({ method: 'REQUEST', content: { path: '/etc/passwd' } }), 'ERR_INVALID');
    assert.equal(await code('BEGIN:VCALENDAR'), 'ERR_INVALID');
    assert.equal(await code({ method: 'COUNTER', content: ICS('COUNTER') }), 'ok');
    assert.equal(await code({ method: 'DECLINECOUNTER', content: ICS('DECLINECOUNTER') }), 'ok');
  });

  it('gc.mail.smtp.send with icalEvent through the plugin process', async () => {
    const r = await gcOf(PID, 'mail.smtp.send', { host: 'mail.test.example', port: 465, security: 'tls', auth: { user: 'bob', pass: 's3cret-pass' },
      message: msg({ method: 'REPLY', content: ICS('REPLY') }) });
    assert.equal(r.ok, true, JSON.stringify(r));
    const got = smtp.state.mails[smtp.state.mails.length - 1];
    assert.deepEqual(got.to, ['anna@firma.example']);
    assert.match(got.raw, /text\/calendar; charset=utf-8; method=REPLY/);
    assert.match(got.raw, /filename=invite\.ics/);
  });
});
