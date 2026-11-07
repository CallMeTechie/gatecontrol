'use strict';

// Drucken & Scannen, server side (phase 3c, step 1 — services/homePrint.js,
// docs/plugins.md "Print & scan"): features.print in the config pull and the
// card "Funktionen" (switch, "Gateway zu alt", the memory part), the gateway's
// device report (checked, only its own rows), the print queue (ETag, the file
// only for an open job of that gateway, the states, expiry after 24 h),
// gc.print in a real plugin process (devices once per uuid, PDF/picture
// conversion and the printer's formats, page count, test page, cancel), scans
// (pages from the gateway become the plugin's media with a preview, a PDF of
// the pages) and the PDF helpers.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const supertest = require('supertest');
const { printPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let app, agent, csrf, db, gw, gw2, gateways, runtime, plugins, hp, annaId;
const P = 'print-demo';
const ID = 'u:f0d8a1b2000010008000' + '00aabbccddee';
const BRO = 'h:0123456789abcdef';
const mgmt = [];

const gwReq = (method, p, g = gw) => supertest(app)[method]('/api/v1/gateway' + p).set('Authorization', 'Bearer ' + g.apiToken);
const admin = (method, p, g = gw) => agent[method]('/api/v1/gateways/' + g.peer.id + p).set('X-CSRF-Token', csrf);

async function installPkg(buf) {
  const r = await agent.post('/api/v1/plugins/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  const res = await agent.post('/api/v1/plugins/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return r.body;
}

async function api(p, body) {
  const r = await agent.post(`/api/v1/plugins/${P}/api${p}`).set('X-CSRF-Token', csrf).send(body || {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

function device(extra = {}) {
  return {
    id: ID, name: 'HP OfficeJet 8020 [A1B2C3]', model: 'HP OfficeJet 8020 series', ip: '192.168.1.57', location: 'Wohnzimmer', source: 'mdns', online: true, seenAt: Date.now(), problem: null,
    printer: { state: 'idle', reasons: [], color: true, duplex: true, formats: ['application/pdf', 'image/jpeg', 'image/urf'], copiesMax: 99,
      markers: [{ name: 'Black', color: '#000000', type: 'ink-cartridge', level: 70, low: false }, { name: 'Magenta', color: '#ff00ff', type: 'ink-cartridge', level: 8, low: true }] },
    scanner: { state: 'idle', platen: true, feeder: true, duplex: false, color: ['bw', 'gray', 'color'], resolutions: [75, 200, 300, 600], formats: ['image/jpeg', 'application/pdf'], adf: 'empty' },
    ...extra,
  };
}

/** A small real JPEG (sharp) of w × h pixels. */
const jpeg = (w = 80, h = 120, color = '#336699') => require('sharp')({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  require('../src/services/license')._overrideForTest({ gateway_peers: 10 });
  gateways = require('../src/services/gateways');
  gateways.notifyConfigChanged = async () => {};
  gateways.mgmtCall = async (peerId, p, body) => { mgmt.push({ peerId, path: p, body }); return { status: 202, body: { accepted: true } }; };
  gw = await gateways.createGateway({ name: 'DS918 Gateway' });
  gw2 = await gateways.createGateway({ name: 'Pi Keller' });
  db = require('../src/db/connection').getDb();
  hp = require('../src/services/homePrint');
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  const users = require('../src/services/users');
  annaId = (await users.create({ username: 'anna', password: 'AnnaPass123!xy', role: 'user', displayName: 'Anna' })).id;
  const tel = (caps, version) => JSON.stringify({ telemetry: { gateway_version: version, capabilities: caps, hardware: { model: 'Synology DS918+', mem_total: 16 * 1024 ** 3 } } });
  db.prepare('UPDATE gateway_meta SET last_health = ?, alive = 1, last_seen_at = ? WHERE peer_id = ?').run(tel(['netwatch', 'inetq', 'presence', 'ups', 'dns', 'cache', 'print'], '1.24.0'), Date.now(), gw.peer.id);
  db.prepare('UPDATE gateway_meta SET last_health = ?, alive = 1, last_seen_at = ? WHERE peer_id = ?').run(tel(['netwatch', 'inetq', 'presence', 'ups', 'dns', 'cache'], '1.23.0'), Date.now(), gw2.peer.id);
});

after(async () => { await plugins.stop(); teardown(); });

describe('features.print and the card "Funktionen"', () => {
  it('off by default; on with manual addresses (RFC 1918 only) → config pull, memory part, group "Geräte im Heimnetz"', async () => {
    let c = (await gwReq('get', '/config').expect(200)).body;
    assert.deepEqual(c.features.print, { enabled: false, manual: [] });
    let v = (await admin('get', '/features').expect(200)).body.gateway;
    assert.equal(v.support.print, true);
    assert.equal(v.print.enabled, false);
    assert.equal(v.print.plugin.installed, false);
    assert.ok(!v.memory.parts.some((p) => p.key === 'print'));
    const bad = await admin('put', '/features').send({ print: { manual: ['8.8.8.8'] } });
    assert.equal(bad.status, 400);
    v = (await admin('put', '/features').send({ print: { enabled: true, manual: ['192.168.1.70'] } }).expect(200)).body.gateway;
    assert.equal(v.print.enabled, true);
    assert.deepEqual(v.features.print, { enabled: true, manual: ['192.168.1.70'], convert: true });
    assert.deepEqual(v.memory.parts.find((p) => p.key === 'print'), { key: 'print', mb: 20 });
    c = (await gwReq('get', '/config').expect(200)).body;
    assert.deepEqual(c.features.print, { enabled: true, manual: ['192.168.1.70'] });
    assert.equal(c.config_hash, gateways.computeConfigHash(gw.peer.id));
    const kit = require('../public/js/gateway-pool-kit');
    assert.equal(kit.groupOf('print'), 'devices');
    assert.deepEqual(kit.featureStates(v).find((x) => x.key === 'print'), { key: 'print', on: true });
    assert.equal(kit.memoryOf(v, 'print'), 20);
  });

  it('a gateway without the capability `print`: support false ("Gateway zu alt – ab 1.24.0")', async () => {
    const v = (await admin('get', '/features', gw2).expect(200)).body.gateway;
    assert.equal(v.support.print, false);
    assert.equal(v.support.minGatewayPrint, '1.24.0');
    assert.equal(v.print.minGateway, '1.24.0');
  });
});

describe('the gateway reports its devices', () => {
  it('stored checked; another gateway\'s rows stay; rows it no longer names go', async () => {
    await gwReq('post', '/print/devices').send({ scannedAt: Date.now(), devices: [
      device(),
      { ...device(), id: BRO, name: 'Brother HL-L2350DW', ip: '192.168.1.61', scanner: null, printer: { ...device().printer, color: false, formats: ['image/urf', 'image/jpeg'] } },
      { ...device(), id: 'u:bad', ip: '192.168.1.62' },          // invalid id
      { ...device(), id: 'h:1111111111111111', ip: '8.8.8.8' },  // not in a private LAN
      { ...device(), id: 'h:2222222222222222', printer: null, scanner: null },
    ] }).expect(200);
    const rows = db.prepare('SELECT device_id, data FROM print_devices WHERE peer_id = ? ORDER BY device_id').all(gw.peer.id);
    assert.deepEqual(rows.map((r) => r.device_id), [BRO, ID]);
    const d = JSON.parse(rows[1].data);
    assert.equal(d.printer.markers[1].color, '#FF00FF');
    assert.equal(d.printer.markers[1].low, true);
    // the same printer seen by the second gateway (offline there)
    await gwReq('post', '/print/devices', gw2).send({ devices: [{ ...device(), online: false }] }).expect(200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM print_devices').get().n, 3);
    await gwReq('post', '/print/devices').send({ devices: 'x' }).expect(400);
    const v = (await admin('get', '/features').expect(200)).body.gateway;
    assert.equal(v.print.count, 2);
    assert.deepEqual(v.print.devices.map((x) => [x.name, x.printer, x.scanner]).sort(), [['Brother HL-L2350DW', true, false], ['HP OfficeJet 8020 [A1B2C3]', true, true]]);
  });

  it('without the switch on, its devices are not offered', async () => {
    const ids = hp.devices().map((x) => x.id).sort();
    assert.deepEqual(ids, [BRO, ID], 'the second gateway has print off: its row is not used');
    assert.equal(hp.devices().find((x) => x.id === ID).gatewayId, gw.peer.id);
  });
});

describe('the last search of a gateway, "Neu suchen" and addresses by hand', () => {
  const search = (extra = {}) => ({
    at: Date.now(), interfaces: 1, responses: 14, responders: 3, services: 3, devices: 1,
    dropped: { other_subnet: 1, bogus: 7, no_ipv4: -1 }, hosts: [{ ip: '192.168.20.5', reason: 'other_subnet', name: 'HP OfficeJet Pro 8720 [5A3B2C]' }, { ip: 'x', reason: 'other_subnet' }],
    manual: [{ ip: '192.168.1.70', found: false, error: 'unreachable' }, { ip: '8.8.8.8', found: true }], errors: ['mdns_port_busy', '<script>'],
    ...extra,
  });

  it('an older gateway reports no search: null (the row says "update"); the heartbeat\'s search is used until a report comes', async () => {
    let v = (await admin('get', '/features').expect(200)).body.gateway;
    assert.equal(v.print.search, null);
    assert.equal(v.print.searchKnown, false);
    assert.equal(v.print.manualMax, 16);
    const h = JSON.parse(db.prepare('SELECT last_health FROM gateway_meta WHERE peer_id = ?').get(gw.peer.id).last_health);
    // a newer gateway before its first search: `search: null` → known, nothing to show yet
    h.telemetry.features = { print: { enabled: true, search: null } };
    db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(JSON.stringify(h), gw.peer.id);
    v = (await admin('get', '/features').expect(200)).body.gateway;
    assert.deepEqual([v.print.search, v.print.searchKnown], [null, true]);
    h.telemetry.features = { print: { enabled: true, search: search({ at: 1000, responses: 2 }) } };
    db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(JSON.stringify(h), gw.peer.id);
    v = (await admin('get', '/features').expect(200)).body.gateway;
    assert.equal(v.print.search.responses, 2);
  });

  it('the device report carries the search: checked and cut, newer than the heartbeat\'s', async () => {
    await gwReq('post', '/print/devices').send({ scannedAt: Date.now(), devices: [device(), { ...device(), id: BRO, name: 'Brother HL-L2350DW', ip: '192.168.1.61', source: 'manual', scanner: null, printer: { ...device().printer, color: false, formats: ['image/urf', 'image/jpeg'] } }], search: search() }).expect(200);
    const v = (await admin('get', '/features').expect(200)).body.gateway;
    const s = v.print.search;
    assert.equal(s.responses, 14);
    assert.deepEqual(s.dropped, { other_subnet: 1 });
    assert.deepEqual(s.hosts, [{ ip: '192.168.20.5', reason: 'other_subnet', name: 'HP OfficeJet Pro 8720 [5A3B2C]', private: true }]);
    assert.deepEqual(s.manual, [{ ip: '192.168.1.70', found: false, error: 'unreachable' }]);
    assert.deepEqual(s.errors, ['mdns_port_busy']);
    // the admin view of the devices: address and how they were found
    assert.deepEqual(v.print.devices.map((d) => [d.ip, d.source]).sort(), [['192.168.1.57', 'mdns'], ['192.168.1.61', 'manual']]);
    assert.equal(hp.cleanSearch('x'), null);
    assert.equal(hp.cleanSearch([]), null);
  });

  it('addresses by hand: private IPv4 only, at most 16 → features.print.manual in the config pull', async () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => `10.0.40.${i + 1}`);
    assert.equal((await admin('put', '/features').send({ print: { manual: [...sixteen, '10.0.40.99'] } })).status, 400);
    const pub = await admin('put', '/features').send({ print: { manual: ['192.168.1.70', '100.64.0.1'] } });
    assert.equal(pub.status, 400);
    assert.equal(pub.body.code, 'invalid_host');
    assert.equal((await admin('put', '/features').send({ print: { manual: ['192.168.20.5', 'drucker.local'] } })).status, 400);
    let v = (await admin('put', '/features').send({ print: { manual: [' 192.168.20.5 ', '192.168.20.5', ...sixteen.slice(0, 14)] } }).expect(200)).body.gateway;
    assert.equal(v.print.manual.length, 15);
    assert.equal(v.print.manual[0], '192.168.20.5');
    let c = (await gwReq('get', '/config').expect(200)).body;
    assert.deepEqual(c.features.print.manual, v.print.manual);
    v = (await admin('put', '/features').send({ print: { manual: ['192.168.1.70'] } }).expect(200)).body.gateway;
    c = (await gwReq('get', '/config').expect(200)).body;
    assert.deepEqual(c.features.print, { enabled: true, manual: ['192.168.1.70'] });
  });

  it('"Neu suchen": the gateway is asked; switched off, unreachable or too old → clear errors', async () => {
    mgmt.length = 0;
    const r = (await admin('post', '/print/discover').send({}).expect(200)).body;
    assert.deepEqual([r.ok, r.busy], [true, false]);
    assert.deepEqual(mgmt.map((m) => [m.peerId, m.path]), [[gw.peer.id, '/api/print/discover']]);
    const orig = gateways.mgmtCall;
    try {
      gateways.mgmtCall = async () => ({ status: 409, body: { error: 'search_running' } });
      assert.equal((await admin('post', '/print/discover').send({}).expect(200)).body.busy, true);
      gateways.mgmtCall = async () => null;
      assert.equal((await admin('post', '/print/discover').send({}).expect(502)).body.code, 'gateway_unreachable');
      gateways.mgmtCall = async () => ({ status: 404, body: null });
      assert.equal((await admin('post', '/print/discover').send({}).expect(409)).body.code, 'gateway_unsupported');
    } finally { gateways.mgmtCall = orig; }
    // the second gateway has the function off
    assert.equal((await admin('post', '/print/discover', gw2).send({}).expect(409)).body.code, 'unavailable');
  });
});

describe('gc.print in a plugin process', () => {
  let pdfMedia;
  let jpgMedia;
  let jobId;

  it('the permission: in the install dialog, gc.print only with it', async () => {
    const ins = await installPkg(printPackage());
    assert.equal(ins.plugin.permissions.print, true);
    assert.equal(await runtime.waitRunning(P), true);
    assert.deepEqual(await api('/has'), { ok: true, print: true });
    const hostApi = require('../src/services/plugins/hostApi');
    await assert.rejects(hostApi.handle({ id: 'nope', manifest: { permissions: {} } }, 'print.devices', {}), (e) => e.code === 'ERR_PRINT_DENIED');
    const manifest = require('../src/services/plugins/manifest');
    const base = { id: 'x-y', name: 'X', version: '1.0.0', publisher: 'T', description: 'd', gatecontrol: '>=1.0.0', entry: 'server/index.js' };
    assert.equal(manifest.validate({ ...base, permissions: { print: true } }).manifest.permissions.print, true);
    assert.equal(manifest.validate({ ...base, permissions: { print: 'yes' } }).ok, false);
  });

  it('devices: each once, with ink and the gateway, never an endpoint', async () => {
    const r = await api('/devices');
    assert.equal(r.ok, true, JSON.stringify(r));
    const hpd = r.result.find((x) => x.id === ID);
    assert.equal(hpd.gateway, 'DS918 Gateway');
    assert.equal(hpd.online, true);
    assert.equal(hpd.printer.markers[0].level, 70);
    assert.equal(hpd.scanner.feeder, true);
    assert.equal(r.result.length, 2);
  });

  it('submit: PDF with its pages; options only where the printer can; the gateway is told', async () => {
    const media = require('../src/services/plugins/media');
    const reg = require('../src/services/plugins/registry');
    const two = require('../src/services/printPdf').jpegsToPdf([{ jpeg: await jpeg() }, { jpeg: await jpeg() }]);
    pdfMedia = (await media.storeBuffer(reg.get(P), two, { mime: 'application/pdf', name: 'Bordkarte_Mallorca.pdf', owner: annaId })).mediaId;
    jpgMedia = (await media.storeBuffer(reg.get(P), await require('sharp')({ create: { width: 60, height: 40, channels: 4, background: '#ff000080' } }).png().toBuffer(), { mime: 'image/png', name: 'foto.png', owner: annaId })).mediaId;
    assert.deepEqual((await api('/pages', { mediaId: pdfMedia })).result, { pages: 2, format: 'application/pdf' });
    mgmt.length = 0;
    const r = await api('/submit', { deviceId: ID, mediaId: pdfMedia, user: annaId, copies: 2, color: false, duplex: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    const j = r.result;
    jobId = j.id;
    assert.deepEqual([j.state, j.pages, j.copies, j.color, j.duplex, j.format, j.name], ['queued', 2, 2, false, true, 'application/pdf', 'Bordkarte_Mallorca.pdf']);
    assert.ok(Date.parse(j.expiresAt) - Date.parse(j.createdAt) === 24 * 3600 * 1000);
    assert.deepEqual(mgmt.map((m) => [m.peerId, m.path]), [[gw.peer.id, '/api/print/jobs']]);
    assert.ok(fs.existsSync(require('node:path').join(hp.jobsDir(), jobId + '.bin')));
    // the black-and-white printer: colour off, JPEG for a picture; a PDF it does not take → ERR_PRINT_FORMAT
    const bw = await api('/submit', { deviceId: BRO, mediaId: jpgMedia, user: annaId, color: true });
    assert.equal(bw.ok, true, JSON.stringify(bw));
    assert.deepEqual([bw.result.format, bw.result.color], ['image/jpeg', false]);
    // … because its gateway is too old to convert PDF (no capability print-convert): the reason says so
    const noPdf = await api('/submit', { deviceId: BRO, mediaId: pdfMedia, user: annaId });
    assert.deepEqual([noPdf.code, noPdf.reason], ['ERR_PRINT_FORMAT', 'gateway_update']);
    assert.equal((await api('/submit', { deviceId: ID, mediaId: pdfMedia, user: annaId, copies: 0 })).code, 'ERR_INVALID');
    assert.equal((await api('/submit', { deviceId: ID, mediaId: pdfMedia, user: 99999 })).code, 'ERR_NOT_FOUND');
    assert.equal((await api('/submit', { deviceId: 'h:ffffffffffffffff', mediaId: pdfMedia, user: annaId })).code, 'ERR_NOT_FOUND');
    assert.equal((await api('/submit', { deviceId: ID, mediaId: 'f'.repeat(32), user: annaId })).code, 'ERR_NOT_FOUND');
  });

  it('an Office file: ERR_PRINT_FORMAT; a picture for a printer with only PDF: one PDF page', async () => {
    const media = require('../src/services/plugins/media');
    const reg = require('../src/services/plugins/registry');
    const doc = (await media.storeBuffer(reg.get(P), Buffer.from('PK\u0003\u0004 not really a docx'), { mime: 'application/octet-stream', name: 'Hausaufgabe.docx', owner: annaId })).mediaId;
    const office = await api('/submit', { deviceId: ID, mediaId: doc, user: annaId });
    assert.deepEqual([office.code, office.reason], ['ERR_PRINT_FORMAT', 'file_type']);
    assert.deepEqual([(await api('/pages', { mediaId: doc })).code, (await api('/pages', { mediaId: doc })).reason], ['ERR_PRINT_FORMAT', 'file_type']);
    const out = await hp.printable(await jpeg(), 'image/jpeg', { formats: ['application/pdf'] });
    assert.equal(out.format, 'application/pdf');
    assert.equal(require('../src/services/printPdf').pdfPages(out.buf), 1);
  });

  it('the gateway: its queue (ETag), the file (sha256), the states — another gateway gets nothing', async () => {
    const q = await gwReq('get', '/print/jobs').expect(200);
    const mine = q.body.jobs.find((x) => x.id === jobId);
    assert.deepEqual([mine.deviceId, mine.format, mine.copies, mine.duplex, mine.user], [ID, 'application/pdf', 2, true, 'Anna']);
    await gwReq('get', '/print/jobs').set('If-None-Match', q.headers.etag).expect(304);
    assert.deepEqual((await gwReq('get', '/print/jobs', gw2).expect(200)).body.jobs, []);
    await gwReq('get', `/print/jobs/${jobId}/file`, gw2).expect(404);
    const f = await gwReq('get', `/print/jobs/${jobId}/file`).buffer(true).parse((res, cb) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    assert.equal(crypto.createHash('sha256').update(f.body).digest('hex'), mine.sha256);
    assert.equal(f.headers['x-content-sha256'], mine.sha256);
    await gwReq('post', `/print/jobs/${jobId}`, gw2).send({ state: 'done' }).expect(404);
    await gwReq('post', `/print/jobs/${jobId}`).send({ state: 'waiting', error: 'printer_offline' }).expect(200);
    assert.equal((await api('/jobs')).result.find((x) => x.id === jobId).error, 'printer_offline');
    await gwReq('post', `/print/jobs/${jobId}`).send({ state: 'sending' }).expect(200);
    await gwReq('post', `/print/jobs/${jobId}`).send({ state: 'printing', ippJobId: 101 }).expect(200);
    await gwReq('post', `/print/jobs/${jobId}`).send({ state: 'bogus' }).expect(400);
    await gwReq('post', `/print/jobs/${jobId}`).send({ state: 'done' }).expect(200);
    const done = (await api('/jobs')).result.find((x) => x.id === jobId);
    assert.deepEqual([done.state, done.error], ['done', null]);
    assert.ok(!fs.existsSync(require('node:path').join(hp.jobsDir(), jobId + '.bin')), 'the file goes when the job ends');
    // a later report does not bring it back
    assert.equal((await gwReq('post', `/print/jobs/${jobId}`).send({ state: 'sending' }).expect(200)).body.ignored, true);
  });

  it('cancel while queued; after 24 h a waiting job expires', async () => {
    const r = (await api('/submit', { deviceId: ID, mediaId: pdfMedia, user: annaId })).result;
    assert.deepEqual((await api('/cancel', { id: r.id })).result, { canceled: true, state: 'canceled' });
    const r2 = (await api('/submit', { deviceId: ID, mediaId: pdfMedia, user: annaId })).result;
    await gwReq('post', `/print/jobs/${r2.id}`).send({ state: 'waiting', error: 'printer_offline' }).expect(200);
    hp.housekeeping(Date.now() + 25 * 3600 * 1000);
    const j = (await api('/jobs')).result.find((x) => x.id === r2.id);
    assert.deepEqual([j.state, j.error], ['expired', 'printer_offline']);
    assert.ok(!(await gwReq('get', '/print/jobs').expect(200)).body.jobs.some((x) => x.id === r2.id));
  });

  it('test page: a PDF for the colour printer', async () => {
    const r = await api('/test', { deviceId: ID, user: annaId });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.format, 'application/pdf');
    assert.equal(r.result.pages, 1);
    assert.match(r.result.name, /Testseite/);
  });

  it('scan: the gateway is asked; pages become the plugin\'s media with a preview; a PDF of them', async () => {
    mgmt.length = 0;
    const r = await api('/scan', { deviceId: ID, user: annaId, source: 'platen', mode: 'document' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const scanId = r.result.scanId;
    assert.deepEqual(mgmt[0].body, { scanId, deviceId: ID, source: 'platen', color: 'gray', resolution: 300, format: 'image/jpeg', duplex: false });
    assert.equal((await api('/scan', { deviceId: ID, user: annaId })).code, 'ERR_PRINT_BUSY', 'one scan per person at a time');
    assert.equal((await api('/scan', { deviceId: BRO, user: annaId })).code, 'ERR_NOT_FOUND', 'no scanner');
    const page = await jpeg(248, 351);
    await gwReq('put', `/print/scans/${scanId}/pages/1`, gw2).set('Content-Type', 'image/jpeg').send(page).expect(404);
    await gwReq('put', `/print/scans/${scanId}/pages/1`).set('Content-Type', 'text/html').send('<b>x</b>').expect(415);
    await gwReq('put', `/print/scans/${scanId}/pages/1`).set('Content-Type', 'image/jpeg').send(page).expect(200);
    await gwReq('put', `/print/scans/${scanId}/pages/2`).set('Content-Type', 'image/jpeg').send(await jpeg(248, 351, '#eeeeee')).expect(200);
    let s = (await api('/scan-status', { id: scanId })).result;
    assert.equal(s.state, 'scanning');
    assert.equal(s.pages.length, 2);
    assert.ok(s.pages[0].thumb && Buffer.from(s.pages[0].thumb, 'base64')[0] === 0xff);
    await gwReq('post', `/print/scans/${scanId}`).send({ state: 'done', pages: 2 }).expect(200);
    s = (await api('/scan-status', { id: scanId })).result;
    assert.equal(s.state, 'done');
    const info = (await api('/store', { mediaId: s.pages[0].mediaId })).result;
    assert.deepEqual([info.mime, info.owner, info.claimed], ['image/jpeg', annaId, false]);
    const p = await api('/pdf', { pages: s.pages.map((x) => x.mediaId), user: annaId, name: '2026-11-06 Stadtwerke Rechnung' });
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.equal(p.result.name, '2026-11-06 Stadtwerke Rechnung.pdf');
    assert.equal(p.result.pages, 2);
    const pi = (await api('/store', { mediaId: p.result.mediaId })).result;
    assert.equal(pi.mime, 'application/pdf');
    // another scan is possible now; a gateway that never answers: the scan fails after 3 minutes
    const r2 = (await api('/scan', { deviceId: ID, user: annaId, source: 'feeder', mode: 'photo', resolution: 600 })).result;
    hp.housekeeping(Date.now() + 4 * 60 * 1000);
    const s2 = (await api('/scan-status', { id: r2.scanId })).result;
    assert.deepEqual([s2.state, s2.error, s2.mode, s2.resolution], ['failed', 'timeout', 'photo', 600]);
  });

  it('the gateway offline: ERR_PRINT_OFFLINE; a busy scanner: ERR_PRINT_BUSY', async () => {
    gateways.mgmtCall = async () => null;
    assert.equal((await api('/scan', { deviceId: ID, user: annaId })).code, 'ERR_PRINT_OFFLINE');
    gateways.mgmtCall = async () => ({ status: 409, body: { error: 'scanner_busy' } });
    assert.equal((await api('/scan', { deviceId: ID, user: annaId })).code, 'ERR_PRINT_BUSY');
    gateways.mgmtCall = async (peerId, p, body) => { mgmt.push({ peerId, path: p, body }); return { status: 202, body: { accepted: true } }; };
    db.prepare('UPDATE gateway_meta SET alive = 0 WHERE peer_id = ?').run(gw.peer.id);
    assert.equal((await api('/submit', { deviceId: ID, mediaId: pdfMedia, user: annaId })).code, 'ERR_PRINT_OFFLINE');
    db.prepare('UPDATE gateway_meta SET alive = 1 WHERE peer_id = ?').run(gw.peer.id);
  });
});

describe('a printer without PDF (HP OfficeJet Pro 8720): the gateway converts', () => {
  const HP = 'h:8720872087208720';
  const hp8720 = (convert) => ({
    ...device(), id: HP, name: 'HP OfficeJet Pro 8720', model: 'HP OfficeJet Pro 8720', ip: '192.168.2.40', scanner: null,
    printer: { ...device().printer, formats: ['application/vnd.hp-pcl', 'image/jpeg', 'application/pclm', 'image/urf', 'image/pwg-raster', 'application/octet-stream'], convert },
  });
  const health = (caps, version, model = 'Raspberry Pi 3 Model B Plus Rev 1.3', conv = { enabled: true, available: true }) => JSON.stringify({ telemetry: {
    gateway_version: version, capabilities: caps, hardware: { model }, features: { print: { enabled: true, convert: conv } },
  } });
  let letter;
  let photo;

  before(async () => {
    const media = require('../src/services/plugins/media');
    const reg = require('../src/services/plugins/registry');
    // the school letter as Android's print dialog hands it over — but stored without a type (octet-stream) and without ".pdf"
    letter = (await media.storeBuffer(reg.get(P), require('../src/services/printPdf').jpegsToPdf([{ jpeg: await jpeg() }]), { mime: 'application/octet-stream', name: '306ee607-2bbf-458c-880c-ed82755135bf-Digitaler Elternabend', owner: annaId })).mediaId;
    photo = (await media.storeBuffer(reg.get(P), await jpeg(120, 80), { mime: 'image/jpeg', name: 'foto.jpg', owner: annaId })).mediaId;
    db.prepare('UPDATE gateway_meta SET last_health = ?, alive = 1 WHERE peer_id = ?').run(health(['print', 'print-convert'], '1.29.0'), gw2.peer.id);
    await admin('put', '/features', gw2).send({ print: { enabled: true } }).expect(200);
  });

  it('the type by the content: a PDF without type and name is a PDF; pages counted', async () => {
    assert.deepEqual((await api('/pages', { mediaId: letter })).result, { pages: 1, format: 'application/pdf' });
    const pdf = require('../src/services/printPdf');
    assert.equal(pdf.sniff(Buffer.from('%PDF-1.7')), 'application/pdf');
    assert.equal(pdf.sniff(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0x0a]), Buffer.from('%PDF-1.4')])), 'application/pdf');
    assert.equal(pdf.sniff(await jpeg()), 'image/jpeg');
    assert.equal(pdf.sniff(Buffer.from('\x89PNG\r\n\x1a\n0000', 'latin1')), 'image/png');
    assert.equal(pdf.sniff(Buffer.from('RIFF0000WEBPVP8 ')), 'image/webp');
    assert.equal(pdf.sniff(Buffer.from('\0\0\0\x18ftypheic0000', 'latin1')), 'image/heic');
    assert.equal(pdf.sniff(Buffer.from('PK\u0003\u0004 docx')), null);
  });

  it('the gateway converts (printer.convert): the PDF is queued as PDF, a picture as a PDF page', async () => {
    await gwReq('post', '/print/devices', gw2).send({ devices: [hp8720('image/pwg-raster')] }).expect(200);
    const d = (await api('/devices')).result.find((x) => x.id === HP);
    assert.equal(d.printer.convert, 'image/pwg-raster');
    const r = await api('/submit', { deviceId: HP, mediaId: letter, user: annaId });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.result.format, r.result.pages, r.result.name], ['application/pdf', 1, '306ee607-2bbf-458c-880c-ed82755135bf-Digitaler Elternabend']);
    assert.ok((await gwReq('get', '/print/jobs', gw2).expect(200)).body.jobs.some((x) => x.id === r.result.id && x.format === 'application/pdf'));
    // the printer names JPEG: a picture goes as JPEG; a test page as PDF (the gateway converts it)
    assert.equal((await api('/submit', { deviceId: HP, mediaId: photo, user: annaId })).result.format, 'image/jpeg');
    assert.equal((await api('/test', { deviceId: HP, user: annaId })).result.format, 'application/pdf');
    const noJpeg = await hp.printable(await jpeg(), 'image/jpeg', { formats: ['image/pwg-raster'], convert: 'image/pwg-raster' });
    assert.equal(noJpeg.format, 'application/pdf');
  });

  it('the reasons when it cannot: converting off, the printer names no format for it, the gateway too old', async () => {
    await gwReq('post', '/print/devices', gw2).send({ devices: [hp8720(null)] }).expect(200);
    let r = await api('/submit', { deviceId: HP, mediaId: letter, user: annaId });
    assert.deepEqual([r.code, r.reason], ['ERR_PRINT_FORMAT', 'printer']);
    assert.match(r.error, /takes no PDF \(it names application\/vnd\.hp-pcl/);
    await admin('put', '/features', gw2).send({ print: { convert: false } }).expect(200);
    assert.deepEqual((await gwReq('get', '/config', gw2).expect(200)).body.features.print, { enabled: true, manual: [], convert: false });
    r = await api('/submit', { deviceId: HP, mediaId: letter, user: annaId });
    assert.deepEqual([r.code, r.reason], ['ERR_PRINT_FORMAT', 'convert_off']);
    const bad = await admin('put', '/features', gw2).send({ print: { convert: 'yes' } });
    assert.equal(bad.status, 400);
    db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(health(['print'], '1.28.0'), gw2.peer.id);
    r = await api('/submit', { deviceId: HP, mediaId: letter, user: annaId });
    assert.deepEqual([r.code, r.reason], ['ERR_PRINT_FORMAT', 'gateway_update']);
    // a picture still works (JPEG); a broken PDF: damaged
    assert.equal((await api('/submit', { deviceId: HP, mediaId: photo, user: annaId })).ok, true);
    const media = require('../src/services/plugins/media');
    const broken = (await media.storeBuffer(require('../src/services/plugins/registry').get(P), Buffer.from('not a pdf at all'), { mime: 'application/pdf', name: 'kaputt.pdf', owner: annaId })).mediaId;
    r = await api('/submit', { deviceId: ID, mediaId: broken, user: annaId });
    assert.deepEqual([r.code, r.reason], ['ERR_PRINT_FORMAT', 'damaged']);
  });

  it('the row "Drucken & Scannen": the checkbox, printers without PDF, "Gateway zu alt", the tool, the Pi hint', async () => {
    let v = (await admin('get', '/features', gw2).expect(200)).body.gateway.print;
    assert.deepEqual([v.convert, v.convertSupported, v.minGatewayConvert], [false, false, '1.29.0']);
    assert.deepEqual(v.devices.map((x) => [x.name, x.noPdf, x.convert]), [['HP OfficeJet Pro 8720', true, null]]);
    db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(health(['print', 'print-convert'], '1.29.0', undefined, { enabled: true, available: false }), gw2.peer.id);
    await admin('put', '/features', gw2).send({ print: { convert: true } }).expect(200);
    assert.deepEqual((await gwReq('get', '/config', gw2).expect(200)).body.features.print, { enabled: true, manual: [] });
    await gwReq('post', '/print/devices', gw2).send({ devices: [hp8720('image/urf'), { ...device(), id: 'h:9999999999999999', ip: '192.168.2.41', scanner: null }] }).expect(200);
    v = (await admin('get', '/features', gw2).expect(200)).body.gateway.print;
    assert.deepEqual([v.convert, v.convertSupported, v.convertAvailable, v.convertHint], [true, true, false, 'slow']);
    assert.deepEqual(v.devices.map((x) => [x.noPdf, x.convert]), [[true, 'image/urf'], [false, null]]);
    // an unknown target from the gateway is not taken
    await gwReq('post', '/print/devices', gw2).send({ devices: [hp8720('application/pclm')] }).expect(200);
    assert.equal(hp.devices().find((x) => x.id === HP).printer.convert, null);
    await admin('put', '/features', gw2).send({ print: { enabled: false } }).expect(200);
  });
});

describe('PDF helpers', () => {
  const pdf = require('../src/services/printPdf');
  it('jpegInfo, jpegsToPdf page size from the scan resolution', async () => {
    const j = await jpeg(300, 600);
    assert.deepEqual(pdf.jpegInfo(j), { width: 300, height: 600, components: 3 });
    assert.equal(pdf.jpegInfo(Buffer.from('nope')), null);
    const doc = pdf.jpegsToPdf([{ jpeg: j, dpi: 300 }]).toString('latin1');
    assert.match(doc, /\/MediaBox \[0 0 72 144\]/);
    assert.match(doc, /\/Filter \/DCTDecode/);
    assert.match(doc, /startxref\n\d+\n%%EOF/);
    assert.throws(() => pdf.jpegsToPdf([{ jpeg: Buffer.from('x') }]), { code: 'not_jpeg' });
  });

  it('pdfPages: page objects, compressed object streams, the page tree count', () => {
    assert.equal(pdf.pdfPages(pdf.testPagePdf({ title: 'Testseite', device: 'HP (Wohnzimmer)', when: 'heute', note: 'Grüße – ok' })), 1);
    const zlib = require('node:zlib');
    const objs = '1 0 2 50 << /Type /Page /Parent 3 0 R >> << /Type /Page /Parent 3 0 R >> << /Type /Pages /Count 2 >>';
    const z = zlib.deflateSync(Buffer.from(objs));
    const compressed = Buffer.concat([Buffer.from('%PDF-1.5\n4 0 obj\n<< /Type /ObjStm /N 3 /First 8 /Filter /FlateDecode /Length ' + z.length + ' >>\nstream\n'), z, Buffer.from('\nendstream\nendobj\n%%EOF')]);
    assert.equal(pdf.pdfPages(compressed), 2);
    assert.equal(pdf.pdfPages(Buffer.from('%PDF-1.4\n<< /Type /Catalog >> << /Count 7 >>')), 7);
    assert.equal(pdf.pdfPages(Buffer.from('not a pdf')), null);
    assert.equal(pdf.pdfText('Grüße (x) € – 🙂'), '(Gr\\374\\337e \\(x\\) \\200 \\226 ?)');
  });
});
