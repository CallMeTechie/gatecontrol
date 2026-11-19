'use strict';

// "Innen immer intern" for every record type, behind a REAL dnsmasq: a conf as
// entrypoint.sh writes it (addn-hosts + servers-file), the hosts file and the
// servers file of services/dns.js next to it — asked over the network like a
// VPN device does. The upstream answers every question with a PUBLIC record
// (A, AAAA, HTTPS, SVCB, MX), so a leak shows as an answer.
//
// Needs dnsmasq. Without it the file is skipped — unless
// GC_TEST_DNSMASQ=required (CI installs dnsmasq-base).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dgram = require('node:dgram');
const { spawn, spawnSync } = require('node:child_process');

const { setup, teardown } = require('./helpers/setup');

const REQUIRED = process.env.GC_TEST_DNSMASQ === 'required';
const hasDnsmasq = spawnSync('dnsmasq', ['--version']).status === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-vpn-dns-types-'));
const confPath = path.join(dir, 'dnsmasq.conf');
process.env.GC_DNSMASQ_CONF = confPath;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const T = { A: 1, MX: 15, AAAA: 28, SVCB: 64, HTTPS: 65 };
const PUBLIC_A = [203, 0, 113, 7];

function freePort() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function encodeName(name) {
  return Buffer.concat([...name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
}
function questionEnd(msg) {
  let i = 12;
  while (msg[i]) i += msg[i] + 1;
  return i + 1;
}
function nameOf(msg) {
  const labels = [];
  for (let i = 12; msg[i]; i += msg[i] + 1) labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString());
  return labels.join('.').toLowerCase();
}

// the public answer of the "internet" for every type
function publicRdata(qtype) {
  if (qtype === T.A) return Buffer.from(PUBLIC_A);
  if (qtype === T.AAAA) return Buffer.from('20010db8000000000000000000000007', 'hex');
  if (qtype === T.MX) return Buffer.concat([Buffer.from([0, 10]), encodeName('mx.example.com')]);
  return Buffer.from([0, 1, 0]); // HTTPS / SVCB: priority 1, target "."
}

describe('internal names behind a real dnsmasq: every record type', { skip: !hasDnsmasq && !REQUIRED ? 'dnsmasq not installed' : false }, () => {
  let db; let dns; let config; let port; let upstream; let child = null; let savedBase; let savedEnv;
  const forwarded = []; // `<name>/<type>` of every question that left dnsmasq
  let stopping = false;

  function start() {
    const c = spawn('dnsmasq', ['--keep-in-foreground', `--user=${os.userInfo().username}`, '--pid-file=', `--conf-file=${confPath}`], { stdio: 'ignore' });
    c.once('exit', () => { if (!stopping && child === c) start(); });
    child = c;
  }

  // one question → { rcode, types: [answer types] }
  function ask(name, qtype) {
    const q = Buffer.concat([Buffer.from([0x47, 0x11, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]), encodeName(name), Buffer.from([qtype >> 8, qtype & 255, 0, 1])]);
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket('udp4');
      const t = setTimeout(() => { s.close(); reject(new Error(`timeout ${name}/${qtype}`)); }, 2000);
      s.on('message', (m) => {
        clearTimeout(t);
        s.close();
        const an = m.readUInt16BE(6);
        const types = [];
        let i = q.length;
        for (let n = 0; n < an; n++) {
          if ((m[i] & 0xc0) === 0xc0) i += 2; else { while (m[i]) i += m[i] + 1; i++; }
          types.push(m.readUInt16BE(i));
          i += 10 + m.readUInt16BE(i + 8);
        }
        resolve({ rcode: m[3] & 0xf, types });
      });
      s.send(q, port, '127.0.0.1');
    });
  }

  async function answering() {
    for (let i = 0; i < 100; i++) {
      try { if ((await ask(`gateway.${config.dns.domain}`, T.A)).types.length) return; } catch { /* not yet */ }
      await sleep(50);
    }
    throw new Error('dnsmasq does not answer');
  }

  before(async () => {
    assert.ok(hasDnsmasq, 'GC_TEST_DNSMASQ=required but dnsmasq is not installed');
    await setup();
    db = require('../src/db/connection').getDb();
    dns = require('../src/services/dns');
    config = require('../config/default');
    savedBase = config.app.baseUrl;
    savedEnv = process.env.GC_BASE_URL;
    config.app.baseUrl = 'https://gc.example.org';
    process.env.GC_BASE_URL = config.app.baseUrl;
    fs.mkdirSync(path.dirname(config.dns.hostsFile), { recursive: true });
    port = await freePort();
    const upPort = await freePort();
    upstream = dgram.createSocket('udp4');
    upstream.on('message', (msg, r) => {
      const end = questionEnd(msg);
      const qtype = msg.readUInt16BE(end);
      forwarded.push(`${nameOf(msg)}/${qtype}`);
      const head = Buffer.from(msg.subarray(0, 12));
      head[2] = 0x81; head[3] = 0x80;
      head.writeUInt16BE(1, 4); head.writeUInt16BE(1, 6); head.writeUInt16BE(0, 8); head.writeUInt16BE(0, 10);
      const rd = publicRdata(qtype);
      const rr = Buffer.alloc(12);
      rr.writeUInt16BE(0xc00c, 0); rr.writeUInt16BE(qtype, 2); rr.writeUInt16BE(1, 4); rr.writeUInt32BE(60, 6); rr.writeUInt16BE(rd.length, 10);
      upstream.send(Buffer.concat([head, msg.subarray(12, end + 4), rr, rd]), r.port, r.address);
    });
    await new Promise((r) => upstream.bind(upPort, '127.0.0.1', r));

    db.prepare('DELETE FROM peers').run();
    db.prepare('DELETE FROM routes').run();
    db.prepare("INSERT INTO peers (name, public_key, allowed_ips, hostname, hostname_source) VALUES ('buero', 'pk-buero', '10.8.0.10/32', 'laptop-buero', 'admin')").run();
    const route = db.prepare("INSERT INTO routes (domain, target_ip, target_port, enabled, route_type) VALUES (?, '10.0.0.1', 8080, 1, 'http')");
    route.run('app.example.com');
    route.run('example.net');
    route.run('x.example.net');

    // the lines of entrypoint.sh (interface lines replaced by a local port)
    const gw = config.wireguard.gatewayIp;
    const zone = config.dns.domain;
    fs.writeFileSync(confPath, [
      '# Auto-generated by entrypoint.sh — do not edit manually.',
      `port=${port}`, 'listen-address=127.0.0.1', 'bind-interfaces',
      'no-resolv', 'no-hosts', 'cache-size=1000',
      `local=/${zone}/`, `domain=${zone}`, 'domain-needed', 'bogus-priv',
      `addn-hosts=${config.dns.hostsFile}`,
      `servers-file=${config.dns.serversFile}`,
      `host-record=gateway.${zone},${gw}`, `host-record=server.${zone},${gw}`, `host-record=gc-server.${zone},${gw}`,
      `server=127.0.0.1#${upPort}`,
      'host-record=gc.example.org,' + gw,
      '',
    ].join('\n'));
    dns.rebuildNow();
    start();
    await answering();
  });

  after(() => {
    stopping = true;
    if (child) child.kill('SIGKILL');
    if (upstream) upstream.close();
    if (config) { config.app.baseUrl = savedBase; process.env.GC_BASE_URL = savedEnv; }
    teardown();
  });

  const INTERNAL = ['app.example.com', 'example.net', 'x.example.net', 'gc.example.org'];

  it('A: the VPN gateway, never the public address', async () => {
    forwarded.length = 0;
    for (const n of INTERNAL) assert.deepEqual(await ask(n, T.A), { rcode: 0, types: [T.A] }, n);
    assert.deepEqual(forwarded, [], 'answered from the hosts file');
  });

  it('AAAA, HTTPS, SVCB, MX: an empty answer (NODATA) — nothing goes to the internet', async () => {
    forwarded.length = 0;
    for (const n of INTERNAL) {
      for (const t of [T.AAAA, T.HTTPS, T.SVCB, T.MX]) assert.deepEqual(await ask(n, t), { rcode: 0, types: [] }, `${n}/${t}`);
    }
    assert.deepEqual(forwarded, []);
  });

  it('names below an internal name and other names go upstream as before, every type', async () => {
    forwarded.length = 0;
    for (const n of ['www.app.example.com', 'y.example.net', 'z.x.example.net', 'mail.example.org']) {
      for (const t of [T.A, T.AAAA, T.HTTPS]) assert.deepEqual(await ask(n, t), { rcode: 0, types: [t] }, `${n}/${t}`);
    }
    assert.equal(forwarded.length, 12);
  });

  it('a new route: internal for every type after the rebuild + SIGHUP, no restart', async () => {
    assert.deepEqual((await ask('neu.example.com', T.AAAA)).types, [T.AAAA], 'not a route yet: public');
    db.prepare("INSERT INTO routes (domain, target_ip, target_port, enabled, route_type) VALUES ('neu.example.com', '10.0.0.1', 8080, 1, 'http')").run();
    dns.rebuildNow();
    child.kill('SIGHUP');
    let got = null;
    for (let i = 0; i < 100; i++) {
      got = await ask('neu.example.com', T.AAAA);
      if (!got.types.length) break;
      await sleep(50);
    }
    assert.deepEqual(got, { rcode: 0, types: [] });
    assert.deepEqual(await ask('neu.example.com', T.A), { rcode: 0, types: [T.A] });
  });

  it('device names: unchanged (their zone is local=, no servers-file lines)', async () => {
    assert.deepEqual(await ask(`laptop-buero.${config.dns.domain}`, T.A), { rcode: 0, types: [T.A] });
    assert.deepEqual(await ask(`laptop-buero.${config.dns.domain}`, T.AAAA), { rcode: 0, types: [] });
    assert.equal((await ask(`gibt-es-nicht.${config.dns.domain}`, T.AAAA)).rcode, 3);
  });
});
