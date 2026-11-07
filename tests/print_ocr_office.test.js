'use strict';

// Drucken & Scannen, Restpunkte phase 3c (services/homePrint.js, services/printOffice.js, gateway docs/print.md):
// office files and plain text for printing (the gateway's service office, „Office-Dateien drucken“), the reasons when
// it cannot, paper and tray of a job, the job state the apps read (gc.print.job), PCLm as a convert target, the text
// recognition (gc.print.ocr: a gateway with „Texterkennung“ makes a searchable PDF and its text), the switches in the
// config pull and the row "Drucken & Scannen", the service office in the compose file.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const { printPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let app, agent, csrf, db, gw, gw2, gateways, runtime, plugins, hp, annaId, media, reg;
const P = 'print-demo';
const ID = 'u:f0d8a1b2000010008000' + '00aabbccddee';
const mgmt = [];
let mgmtAnswer = () => ({ status: 202, body: { accepted: true } });
const FX = path.join(__dirname, 'fixtures', 'print');

const gwReq = (method, p, g = gw) => supertest(app)[method]('/api/v1/gateway' + p).set('Authorization', 'Bearer ' + g.apiToken);
const admin = (method, p, g = gw) => agent[method]('/api/v1/gateways/' + g.peer.id + p).set('X-CSRF-Token', csrf);

async function api(p, body) {
  const r = await agent.post(`/api/v1/plugins/${P}/api${p}`).set('X-CSRF-Token', csrf).send(body || {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

const OFFICE_MEDIA = ['iso_a4_210x297mm', 'iso_a5_148x210mm', 'na_index-4x6_4x6in'];
function device(printer = {}) {
  return {
    id: ID, name: 'HP OfficeJet 8020', model: 'HP OfficeJet 8020 series', ip: '192.168.1.57', location: null, source: 'mdns', online: true, seenAt: Date.now(), problem: null,
    printer: {
      state: 'idle', reasons: [], color: true, duplex: true, formats: ['application/pdf', 'image/jpeg'], copiesMax: 99, markers: [], office: true,
      media: { sizes: OFFICE_MEDIA, default: 'iso_a4_210x297mm', sources: ['main', 'photo'], sourceDefault: 'main', ready: [{ size: 'na_index-4x6_4x6in', source: 'photo' }] },
      ...printer,
    },
    scanner: { state: 'idle', platen: true, feeder: false, duplex: false, color: ['gray', 'color'], resolutions: [150, 300], formats: ['image/jpeg'], adf: null },
  };
}
const health = (caps, extra = {}) => JSON.stringify({ telemetry: {
  gateway_version: '1.32.0', capabilities: caps, hardware: { model: 'Synology DS918+', mem_total: 8 * 1024 ** 3 },
  features: { print: { enabled: true, convert: { enabled: true, available: true }, ocr: { enabled: true, available: true, langs: ['deu', 'eng'] }, office: { enabled: true, service: 'managed' }, ...extra } },
} });
const ALL = ['print', 'print-convert', 'print-ocr', 'print-office', 'print-media'];
const store = async (buf, mime, name) => (await media.storeBuffer(reg.get(P), buf, { mime, name, owner: annaId })).mediaId;

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  require('../src/services/license')._overrideForTest({ gateway_peers: 10 });
  gateways = require('../src/services/gateways');
  gateways.notifyConfigChanged = async () => {};
  gateways.mgmtCall = async (peerId, p, body) => { mgmt.push({ peerId, path: p, body }); return mgmtAnswer(peerId, p, body); };
  gw = await gateways.createGateway({ name: 'DS918 Gateway' });
  gw2 = await gateways.createGateway({ name: 'Pi Keller' });
  db = require('../src/db/connection').getDb();
  hp = require('../src/services/homePrint');
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  media = require('../src/services/plugins/media');
  reg = require('../src/services/plugins/registry');
  const users = require('../src/services/users');
  annaId = (await users.create({ username: 'anna', password: 'AnnaPass123!xy', role: 'user', displayName: 'Anna' })).id;
  db.prepare('UPDATE gateway_meta SET last_health = ?, alive = 1, last_seen_at = ? WHERE peer_id = ?').run(health(ALL), Date.now(), gw.peer.id);
  db.prepare('UPDATE gateway_meta SET last_health = ?, alive = 1, last_seen_at = ? WHERE peer_id = ?').run(health(['print', 'print-convert'], { ocr: undefined, office: undefined }), Date.now(), gw2.peer.id);
  // install the test plugin
  const r = await agent.post('/api/v1/plugins/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(printPackage());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ins = await agent.post('/api/v1/plugins/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true });
  assert.equal(ins.status, 200, JSON.stringify(ins.body));
  assert.equal(await runtime.waitRunning(P), true);
});

after(async () => { await plugins.stop(); teardown(); });

describe('the switches „Texterkennung“ and „Office-Dateien drucken“', () => {
  it('off by default; on → config pull (only when on, the hash of others stays), the row, the compose file', async () => {
    await admin('put', '/features').send({ print: { enabled: true } }).expect(200);
    assert.deepEqual((await gwReq('get', '/config').expect(200)).body.features.print, { enabled: true, manual: [] });
    let v = (await admin('get', '/features').expect(200)).body.gateway.print;
    assert.deepEqual([v.ocr, v.ocrSupported, v.ocrAvailable, v.office, v.officeSupported, v.officeService, v.officeHint], [false, true, true, false, true, 'managed', null]);
    await admin('put', '/features').send({ print: { ocr: true, office: true } }).expect(200);
    assert.deepEqual((await gwReq('get', '/config').expect(200)).body.features.print, { enabled: true, manual: [], ocr: true, office: true });
    v = (await admin('get', '/features').expect(200)).body.gateway.print;
    assert.deepEqual([v.ocr, v.office, v.minGatewayP3c], [true, true, '1.32.0']);
    assert.equal((await admin('put', '/features').send({ print: { office: 'yes' } })).status, 400);
    // the compose file of this gateway has the service office (without a profile)
    const yml = (await admin('post', '/compose').send({ platform: 'linux' }).expect(200)).text;
    assert.match(yml, /\n {2}office:\n {4}image: ghcr\.io\/callmetechie\/gatecontrol-gateway:office\n/);
    assert.match(yml, /network_mode: none/);
    assert.ok(!/\n {2}office:[\s\S]*profiles:/.test(yml.split('\n  office:')[1].split('\nvolumes:')[0]), 'no profile');
    const without = (await admin('post', '/compose').send({ platform: 'linux', office: false }).expect(200)).text;
    assert.ok(!/\n {2}office:\n/.test(without));
  });

  it('hints: a Raspberry Pi 3 or less than 2 GB RAM (never a ban); a gateway without the capabilities: "Gateway zu alt"', async () => {
    db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(JSON.stringify({ telemetry: { gateway_version: '1.32.0', capabilities: ALL, hardware: { model: 'Raspberry Pi 3 Model B Plus Rev 1.3', mem_total: 1024 ** 3 }, features: { print: { ocr: { available: true }, office: { service: 'absent' } } } } }), gw2.peer.id);
    await admin('put', '/features', gw2).send({ print: { enabled: true, office: true } }).expect(200);
    let v = (await admin('get', '/features', gw2).expect(200)).body.gateway.print;
    assert.deepEqual([v.ocrHint, v.officeHint, v.officeService], ['slow', 'small', 'absent']);
    db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(health(['print', 'print-convert'], { ocr: undefined, office: undefined }), gw2.peer.id);
    v = (await admin('get', '/features', gw2).expect(200)).body.gateway.print;
    assert.deepEqual([v.ocrSupported, v.officeSupported, v.officeService], [false, false, null]);
    await admin('put', '/features', gw2).send({ print: { enabled: false, office: false } }).expect(200);
  });
});

describe('office files and plain text', () => {
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  let docx;
  let xlsx;
  let odt;
  let txt;

  before(async () => {
    await gwReq('post', '/print/devices').send({ devices: [device()] }).expect(200);
    docx = await store(fs.readFileSync(path.join(FX, 'sample.docx')), 'application/octet-stream', 'Elternbrief.docx');
    xlsx = await store(fs.readFileSync(path.join(FX, 'sample.xlsx')), 'application/octet-stream', 'Zaehler.xlsx');
    odt = await store(fs.readFileSync(path.join(FX, 'sample.odt')), 'application/octet-stream', 'Brief.odt');
    txt = await store(Buffer.from('Einkaufsliste\n- Milch\n- Brot „frisch“ – 2,50 €\n'), 'application/octet-stream', 'liste.txt');
  });

  it('the kind by the content: docx, xlsx, pptx, odt, ods, odp, rtf; pages where the file names them', () => {
    const office = require('../src/services/printOffice');
    const kinds = ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf'].map((e) => office.officeInfo(fs.readFileSync(path.join(FX, `sample.${e}`))).ext);
    assert.deepEqual(kinds, ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf']);
    assert.equal(office.officeInfo(fs.readFileSync(path.join(FX, 'sample.odt'))).pages, 1);
    // Word's own docProps/app.xml names the pages
    const kit = require('../public/js/gateway-kit');
    const zip = Buffer.from(kit.zipStored([
      { name: '[Content_Types].xml', data: '<Types/>' }, { name: 'word/document.xml', data: '<w:document/>' },
      { name: 'docProps/app.xml', data: '<Properties><Pages>7</Pages></Properties>' },
    ]));
    assert.deepEqual(office.officeInfo(zip), { mime: DOCX, ext: 'docx', pages: 7 });
    assert.equal(office.officeInfo(Buffer.from('PK\u0003\u0004 not a zip')), null);
    assert.equal(office.officeInfo(fs.readFileSync(path.join(FX, 'sample.pdf'))), null);
    assert.equal(office.isText(Buffer.from('a\0b'), 'text/plain'), false);
    assert.equal(office.decodeText(Buffer.from([0xff, 0xfe, 0x41, 0, 0xe4, 0])), 'Aä');
    assert.equal(office.decodeText(Buffer.from([0xe4, 0x20, 0x41])), 'ä A', 'Latin-1 when it is no UTF-8');
  });

  it('a printer whose gateway converts office files: queued as the office type, pages estimated; text becomes a PDF', async () => {
    const pages = await api('/pages', { mediaId: docx });
    assert.deepEqual(pages.result, { pages: 1, format: DOCX, estimated: true });
    assert.deepEqual((await api('/pages', { mediaId: odt })).result, { pages: 1, format: 'application/vnd.oasis.opendocument.text' });
    const r = await api('/submit', { deviceId: ID, mediaId: docx, user: annaId });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.result.format, r.result.pages], [DOCX, 1]);
    const q = (await gwReq('get', '/print/jobs').expect(200)).body.jobs.find((x) => x.id === r.result.id);
    assert.equal(q.format, DOCX);
    // the gateway made the PDF and says how many pages it has: the job counts them now
    await gwReq('post', '/print/jobs/' + r.result.id).send({ state: 'sending', message: 'converting_office' }).expect(200);
    await gwReq('post', '/print/jobs/' + r.result.id).send({ state: 'printing', ippJobId: 12, pages: 3 }).expect(200);
    const j = (await api('/job', { id: r.result.id })).result;
    assert.deepEqual([j.state, j.pages], ['printing', 3]);
    // plain text: a PDF made by the server (no LibreOffice needed)
    const t = await api('/submit', { deviceId: ID, mediaId: txt, user: annaId });
    assert.deepEqual([t.ok, t.result.format, t.result.pages], [true, 'application/pdf', 1]);
    assert.deepEqual((await api('/pages', { mediaId: txt })).result, { pages: 1, format: 'text/plain' });
    assert.equal((await api('/submit', { deviceId: ID, mediaId: xlsx, user: annaId })).ok, true);
  });

  it('the reasons when it cannot: switched off, the service not running yet, the gateway too old', async () => {
    await gwReq('post', '/print/devices').send({ devices: [device({ office: false })] }).expect(200);
    await admin('put', '/features').send({ print: { office: false } }).expect(200);
    let r = await api('/submit', { deviceId: ID, mediaId: docx, user: annaId });
    assert.deepEqual([r.code, r.reason], ['ERR_PRINT_FORMAT', 'office_off']);
    await admin('put', '/features').send({ print: { office: true } }).expect(200);
    db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(health(ALL, { office: { enabled: true, service: 'absent' } }), gw.peer.id);
    r = await api('/submit', { deviceId: ID, mediaId: docx, user: annaId });
    assert.deepEqual([r.code, r.reason], ['ERR_PRINT_FORMAT', 'office_missing']);
    db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(health(['print', 'print-convert']), gw.peer.id);
    r = await api('/submit', { deviceId: ID, mediaId: docx, user: annaId });
    assert.deepEqual([r.code, r.reason], ['ERR_PRINT_FORMAT', 'gateway_update']);
    // text still works without the service (made on the server)
    assert.equal((await api('/submit', { deviceId: ID, mediaId: txt, user: annaId })).ok, true);
    // anything else: file_type
    const exe = await store(Buffer.from('MZ\x90\x00 not printable'), 'application/octet-stream', 'setup.exe');
    r = await api('/submit', { deviceId: ID, mediaId: exe, user: annaId });
    assert.deepEqual([r.code, r.reason], ['ERR_PRINT_FORMAT', 'file_type']);
    db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(health(ALL), gw.peer.id);
    await gwReq('post', '/print/devices').send({ devices: [device()] }).expect(200);
  });
});

describe('paper, tray, PCLm and the job state', () => {
  let pdfId;
  before(async () => {
    pdfId = await store(fs.readFileSync(path.join(FX, 'sample.pdf')), 'application/pdf', 'Rechnung.pdf');
  });

  it('paper and tray only from what the printer names; in the queue for the gateway', async () => {
    const d = (await api('/devices')).result.find((x) => x.id === ID);
    assert.deepEqual(d.printer.media.sizes, OFFICE_MEDIA);
    assert.deepEqual(d.printer.media.ready, [{ size: 'na_index-4x6_4x6in', source: 'photo' }]);
    const r = await api('/submit', { deviceId: ID, mediaId: pdfId, user: annaId, media: 'na_index-4x6_4x6in', source: 'photo' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.result.media, r.result.source], ['na_index-4x6_4x6in', 'photo']);
    const q = (await gwReq('get', '/print/jobs').expect(200)).body.jobs.find((x) => x.id === r.result.id);
    assert.deepEqual([q.media, q.source], ['na_index-4x6_4x6in', 'photo']);
    assert.equal((await api('/submit', { deviceId: ID, mediaId: pdfId, user: annaId, media: 'na_legal_8.5x14in' })).code, 'ERR_INVALID');
    assert.equal((await api('/submit', { deviceId: ID, mediaId: pdfId, user: annaId, source: 'tray-9' })).code, 'ERR_INVALID');
    // the gateway's report: unknown names and sources dropped
    const bad = hp.cleanDevice(device({ media: { sizes: ['iso_a4_210x297mm', '../x', 'A4'], default: 'A4', sources: ['main', 'Tray 1'], ready: [{ size: 'x', source: 'y' }] } }));
    assert.deepEqual(bad.printer.media, { sizes: ['iso_a4_210x297mm'], default: null, sources: ['main'], sourceDefault: null, ready: [] });
  });

  it('PCLm is a convert target now; the job with its state for the apps (gc.print.job)', async () => {
    const d = hp.cleanDevice(device({ formats: ['application/pclm', 'image/jpeg'], convert: 'application/pclm' }));
    assert.equal(d.printer.convert, 'application/pclm');
    const r = await api('/submit', { deviceId: ID, mediaId: pdfId, user: annaId });
    await gwReq('post', '/print/jobs/' + r.result.id).send({ state: 'printing', ippJobId: 7 }).expect(200);
    await gwReq('post', '/print/jobs/' + r.result.id).send({ state: 'printing', ippJobId: 7, message: 'media-empty' }).expect(200);
    let j = (await api('/job', { id: r.result.id })).result;
    assert.deepEqual([j.state, j.message], ['printing', 'media-empty']);
    // pages only change for an office file
    await gwReq('post', '/print/jobs/' + r.result.id).send({ state: 'done', pages: 9 }).expect(200);
    j = (await api('/job', { id: r.result.id })).result;
    assert.deepEqual([j.state, j.pages], ['done', 1]);
  });
});

describe('text recognition (gc.print.ocr)', () => {
  let pages;
  let ocrId;
  const page = () => fs.readFileSync(path.join(FX, 'scan-page.jpg'));

  before(async () => {
    pages = [await store(page(), 'image/jpeg', 'Scan 1.jpg'), await store(page(), 'image/jpeg', 'Scan 2.jpg')];
  });

  it('available only with a gateway that has „Texterkennung“ on and tesseract in its image', async () => {
    assert.deepEqual((await api('/ocr-available')).result, { available: true, gateways: 1 });
    db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(health(ALL, { ocr: { enabled: true, available: false } }), gw.peer.id);
    assert.deepEqual((await api('/ocr-available')).result, { available: false, gateways: 0 });
    const r = await api('/ocr', { pages, user: annaId, name: 'Rechnung' });
    assert.equal(r.code, 'ERR_PRINT_OCR_UNAVAILABLE');
    db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(health(ALL), gw.peer.id);
    assert.equal((await api('/ocr', { pages: [], user: annaId })).code, 'ERR_INVALID');
    const pdfOnly = await store(fs.readFileSync(path.join(FX, 'sample.pdf')), 'application/pdf', 'x.pdf');
    assert.equal((await api('/ocr', { pages: [pdfOnly], user: annaId })).code, 'ERR_PRINT_FORMAT');
  });

  it('the gateway is asked, fetches the pages, sends the PDF and the text; the plugin gets both', async () => {
    mgmt.length = 0;
    const r = await api('/ocr', { pages, user: annaId, name: 'Rechnung Stadtwerke', dpi: 150, deviceId: ID });
    assert.equal(r.ok, true, JSON.stringify(r));
    ocrId = r.result.ocrId;
    assert.deepEqual(mgmt.map((m) => [m.peerId, m.path, m.body]), [[gw.peer.id, '/api/print/ocr', { ocrId, pages: 2, dpi: 150 }]]);
    let s = (await api('/ocr-status', { id: ocrId })).result;
    assert.deepEqual([s.state, s.page, s.pages, s.mediaId, s.text], ['queued', 0, 2, null, null]);
    // the pages: only for this gateway, only open ones
    const p1 = await gwReq('get', `/print/ocr/${ocrId}/pages/1`).expect(200);
    assert.equal(p1.headers['content-type'], 'image/jpeg');
    assert.ok(Buffer.from(p1.body).equals(page()));
    await gwReq('get', `/print/ocr/${ocrId}/pages/3`).expect(404);
    await gwReq('get', `/print/ocr/${ocrId}/pages/1`, gw2).expect(404);
    await gwReq('post', `/print/ocr/${ocrId}`).send({ state: 'running', page: 1, pages: 2 }).expect(200);
    assert.deepEqual(((await api('/ocr-status', { id: ocrId })).result).page, 1);
    // done without the PDF: failed (upload_failed) — so first the PDF, then the text, then done
    const doc = fs.readFileSync(path.join(FX, 'sample.pdf'));
    await gwReq('put', `/print/ocr/${ocrId}/document`).set('Content-Type', 'image/jpeg').send(doc).expect(415);
    await gwReq('put', `/print/ocr/${ocrId}/document`).set('Content-Type', 'application/pdf').send(Buffer.from('nope')).expect(400);
    await gwReq('put', `/print/ocr/${ocrId}/document`).set('Content-Type', 'application/pdf').send(doc).expect(200);
    await gwReq('put', `/print/ocr/${ocrId}/text`).set('Content-Type', 'text/plain; charset=utf-8').send(Buffer.from('Rechnung Nr. 4711\n\u0007Betrag: 129,00 €')).expect(200);
    await gwReq('post', `/print/ocr/${ocrId}`).send({ state: 'done', page: 2, pages: 2 }).expect(200);
    s = (await api('/ocr-status', { id: ocrId })).result;
    assert.equal(s.state, 'done');
    assert.equal(s.text, 'Rechnung Nr. 4711\n Betrag: 129,00 €');
    const info = (await api('/store', { mediaId: s.mediaId })).result;
    assert.deepEqual([info.mime, info.name, info.bytes], ['application/pdf', 'Rechnung Stadtwerke.pdf', doc.length]);
    // after the end: no more pages, no more uploads
    await gwReq('get', `/print/ocr/${ocrId}/pages/1`).expect(404);
    await gwReq('put', `/print/ocr/${ocrId}/text`).set('Content-Type', 'text/plain').send('x').expect(404);
  });

  it('failed and silent ones end; cancel tells the gateway; a busy gateway: ERR_PRINT_BUSY', async () => {
    let r = await api('/ocr', { pages, user: annaId, name: 'a' });
    await gwReq('post', `/print/ocr/${r.result.ocrId}`).send({ state: 'failed', error: 'ocr_timeout' }).expect(200);
    let s = (await api('/ocr-status', { id: r.result.ocrId })).result;
    assert.deepEqual([s.state, s.error], ['failed', 'ocr_timeout']);
    r = await api('/ocr', { pages, user: annaId, name: 'b' });
    mgmt.length = 0;
    assert.deepEqual((await api('/ocr-cancel', { id: r.result.ocrId })).result, { canceled: true, state: 'canceled' });
    assert.deepEqual(mgmt.map((m) => m.path), ['/api/print/ocr/cancel']);
    // the gateway goes silent: after 3 minutes the server gives up
    r = await api('/ocr', { pages, user: annaId, name: 'c' });
    await gwReq('post', `/print/ocr/${r.result.ocrId}`).send({ state: 'running', page: 0 }).expect(200);
    db.prepare('UPDATE print_ocr SET updated_at = ? WHERE id = ?').run(Date.now() - 4 * 60 * 1000, r.result.ocrId);
    s = (await api('/ocr-status', { id: r.result.ocrId })).result;
    assert.deepEqual([s.state, s.error], ['failed', 'timeout']);
    mgmtAnswer = (peerId, p) => (p === '/api/print/ocr' ? { status: 409, body: { error: 'ocr_busy' } } : { status: 202 });
    assert.equal((await api('/ocr', { pages, user: annaId })).code, 'ERR_PRINT_BUSY');
    mgmtAnswer = () => null;
    assert.equal((await api('/ocr', { pages, user: annaId })).code, 'ERR_PRINT_OCR_UNAVAILABLE');
    mgmtAnswer = () => ({ status: 202 });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM print_ocr WHERE state = 'queued'").get().n, 0, 'no row left of a refused one');
  });
});
