'use strict';

// WAF audit log (docs/feature-waf.md): parser against REAL Coraza JSON lines
// (tests/fixtures/waf/coraza-audit.jsonl, captured from the built Caddy
// v2.11.4 + coraza-caddy v2.6.1 + CRS 4.25.0 with the generated directives —
// audit parts AHZ: no request headers, no bodies, no response part;
// block.test = block/PL1, detect.test = detect/PL2; the requests carried a
// Cookie and an Authorization header and a password in the POST body), the
// transaction → rows mapping with the redacted raw record, and the watcher
// (truncation after ingest, incremental offsets, partial lines, missing file,
// restart state, external truncation, fallback rotation).

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup, teardown } = require('./helpers/setup');

const FIXTURE = path.join(__dirname, 'fixtures', 'waf', 'coraza-audit.jsonl');
const LINES = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);
// Fixture index → content
const L = {
  xssBlocked: LINES[0],     // GET /?q=<script>… block.test, interrupted, 941100/941110/941160/941390 + 949110
  lfiBlocked: LINES[1],     // GET /download?file=../../etc/passwd, 930100/930110/930120/932160 + 949110
  upstream403: LINES[2],    // upstream 403, no rule message
  sqliPost: LINES[3],       // POST /login body sqli, 942100 + 949110
  badJson: LINES[4],        // POST /api broken JSON → 200002 (status 400)
  cookieXss: LINES[5],      // GET / with <script> in a COOKIE value → 941xxx on REQUEST_COOKIES:q
  xssDetected: LINES[6],    // detect.test, DetectionOnly, 6 rules + 949110
  sqliDetected: LINES[7],   // detect.test, 9 rules + 949110
  noMsg1: LINES[8],         // DetectionOnly entry without messages (Coraza tx-pool
                            //   reuse keeps a stale detection-only interruption)
};

let waf, db, events;
const eventBus = require('../src/services/eventBus');
const onEvent = (e) => { if (e.type === 'waf') events.push(e.payload); };

beforeEach(async () => {
  await setup();
  waf = require('../src/services/waf');
  db = require('../src/db/connection').getDb();
  db.prepare("INSERT INTO routes (id, domain, target_ip, target_port, route_type) VALUES (1, 'block.test', '10.0.0.1', 80, 'http')").run();
  db.prepare("INSERT INTO routes (id, domain, target_ip, target_port, route_type) VALUES (2, 'detect.test', '10.0.0.1', 80, 'http')").run();
  events = [];
  eventBus.subscribe(onEvent);
});
afterEach(() => { eventBus.unsubscribe(onEvent); waf.stopWatcher(); teardown(); });

test('fixture has the 9 captured lines; AHZ keeps headers, bodies and secrets out', () => {
  assert.equal(LINES.length, 9);
  const text = LINES.join('\n');
  assert.equal(/SECRETCOOKIE123|SECRETTOKEN456|SECRETPASSWORD789/.test(text), false, 'no Cookie/Authorization header, no body');
  for (const l of LINES) {
    const t = JSON.parse(l).transaction;
    assert.equal(t.request.headers, null);
    assert.equal(t.request.body, '');
    assert.equal(t.response, undefined, 'no response part');
  }
});

test('parseAuditLine: blocked XSS (real line)', () => {
  const t = waf.parseAuditLine(L.xssBlocked);
  assert.equal(t.host, 'block.test');
  assert.equal(t.client_ip, '127.0.0.1');
  assert.equal(t.method, 'GET');
  assert.equal(t.uri, '/?q=%3Cscript%3Ealert(1)%3C/script%3E');
  assert.equal(t.interrupted, true);
  assert.equal(t.rule_engine, 'On');
  assert.match(t.tx_id, /^[A-Za-z0-9]{16}$/);
  assert.match(t.ts, /^2026-09-13T18:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual(t.messages.map((m) => m.rule_id), [941100, 941110, 941160, 941390, 949110]);
  const m = t.messages[0];
  assert.equal(m.message, 'XSS Attack Detected via libinjection');
  assert.equal(m.severity, 'critical');
  assert.equal(m.data, 'Matched Data: XSS data found within ARGS:q: <script>alert(1)</script>');
  assert.ok(m.tags.includes('attack-xss'));
  assert.ok(m.tags.includes('paranoia-level/1'));
});

test('parseAuditLine: other real lines', () => {
  const lfi = waf.parseAuditLine(L.lfiBlocked);
  assert.deepEqual(lfi.messages.map((m) => m.rule_id), [930100, 930110, 930120, 932160, 949110]);
  const post = waf.parseAuditLine(L.sqliPost);
  assert.equal(post.method, 'POST');
  assert.equal(post.uri, '/login');
  assert.equal(post.messages[0].rule_id, 942100);
  const bad = waf.parseAuditLine(L.badJson);
  assert.equal(bad.messages[0].rule_id, 200002);
  assert.equal(bad.messages[0].message, 'Failed to parse request body.');
  const det = waf.parseAuditLine(L.xssDetected);
  assert.equal(det.interrupted, false);
  assert.equal(det.rule_engine, 'DetectionOnly');
  assert.equal(det.host, 'detect.test');
  assert.equal(det.status, null, 'no response part (F) any more');
  assert.ok(det.messages.some((m) => m.rule_id === 942131), 'PL2 rule fired on the paranoia-2 route');
  assert.equal(waf.parseAuditLine(L.noMsg1).messages.length, 0);
  const ck = waf.parseAuditLine(L.cookieXss);
  assert.equal(ck.uri, '/');
  assert.ok(ck.messages.some((m) => /REQUEST_COOKIES:q/.test(m.data || '')));
  assert.equal(waf.parseAuditLine(L.upstream403).messages.length, 0);
});

test('parseAuditLine: defensive against garbage and other shapes', () => {
  assert.equal(waf.parseAuditLine('not json'), null);
  assert.equal(waf.parseAuditLine('{}'), null);
  assert.equal(waf.parseAuditLine('[1,2]'), null);
  assert.equal(waf.parseAuditLine('{"transaction":"x"}'), null);
  // Structured part-K details (data object, numeric severity) and ISO/second timestamps.
  const t = waf.parseAuditLine(JSON.stringify({
    transaction: { id: 'abc', timestamp: '2026/01/02 03:04:05', server_id: 'Alias.Test.', client_ip: '203.0.113.9', is_interrupted: true,
      request: { method: 'GET', uri: '/x', headers: { Host: ['alias.test:8443'] } } },
    messages: [{ message: 'm', data: { id: 941100, msg: 'XSS', severity: 2, data: 'Matched', tags: ['a'] } }, { data: null, error_message: '[id "bogus"]' }, 'x'],
  }));
  assert.equal(t.host, 'alias.test');
  assert.equal(t.ts, '2026-01-02T03:04:05.000Z');
  assert.deepEqual(t.messages[0], { rule_id: 941100, severity: 'critical', message: 'XSS', data: 'Matched', tags: ['a'] });
  assert.equal(t.messages[1].rule_id, null);
  const h = waf.parseAuditLine(JSON.stringify({ transaction: { unix_timestamp: 1757764800, request: { headers: { host: ['x.test:80'] } } } }));
  assert.equal(h.host, 'x.test');
  assert.equal(h.ts, '2025-09-13T12:00:00.000Z');
});

test('parseErrorLog: Go-quoted values with escapes', () => {
  const e = waf.parseErrorLog('[client "1.2.3.4"] Coraza: Warning. X [id "941100"] [msg "a \\"quoted\\" \\\\ msg"] [data "tab\\there \\u00e9 \\x41"] [severity "critical"] [tag "t1"] [tag "t2"] [msg_match_1 "later"]');
  assert.equal(e.id, '941100');
  assert.equal(e.msg, 'a "quoted" \\ msg');
  assert.equal(e.data, 'tab\there é A');
  assert.equal(e.severity, 'critical');
  assert.deepEqual(e.tags, ['t1', 't2']);
  assert.deepEqual(waf.parseErrorLog(''), { tags: [] });
});

test('eventsFromTransaction: one row per detection rule, summary rules dropped, message-less entries ignored', () => {
  const lookup = (h) => ({ 'block.test': 1, 'detect.test': 2 }[h] ?? null);
  const rows = waf.eventsFromTransaction(waf.parseAuditLine(L.xssBlocked), lookup);
  assert.deepEqual(rows.map((r) => r.rule_id), [941100, 941110, 941160, 941390]);
  assert.ok(rows.every((r) => r.action === 'blocked' && r.route_id === 1 && r.host === 'block.test' && r.tx_id === rows[0].tx_id));
  assert.deepEqual(JSON.parse(rows[0].raw).rule.tags.slice(0, 1), ['application-multi']);
  const det = waf.eventsFromTransaction(waf.parseAuditLine(L.xssDetected), lookup);
  assert.equal(det.length, 6);
  assert.ok(det.every((r) => r.action === 'detected' && r.route_id === 2));
  assert.deepEqual(waf.eventsFromTransaction(waf.parseAuditLine(L.noMsg1), lookup), []);
  assert.deepEqual(waf.eventsFromTransaction(waf.parseAuditLine(L.upstream403), lookup), []);
  // Only a summary rule matched → it is kept so a blocked request never vanishes.
  const only = waf.eventsFromTransaction({ ...waf.parseAuditLine(L.xssBlocked), messages: [{ rule_id: 949110, severity: 'emergency', message: 'Inbound Anomaly Score Exceeded', data: '', tags: [] }] }, lookup);
  assert.deepEqual(only.map((r) => r.rule_id), [949110]);
  assert.equal(waf.eventsFromTransaction(waf.parseAuditLine(L.xssBlocked), () => null)[0].route_id, null, 'unknown host → route_id null');
});

async function withLog(lines, fn, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-waf-log-'));
  const file = path.join(dir, 'waf-audit.log');
  if (lines !== null) fs.writeFileSync(file, lines.map((l) => l + '\n').join(''));
  waf.startWatcher({ file, intervalMs: 1e9, immediate: false, ...opts });
  try { await fn(file, dir); } finally { waf.stopWatcher(); fs.rmSync(dir, { recursive: true, force: true }); }
}
const count = () => db.prepare('SELECT COUNT(*) AS n FROM waf_events').get().n;

test('watcher: missing file tolerated, incremental offsets, partial line, events published', async () => {
  await withLog(null, async (file) => {
    assert.equal(await waf.pollOnce(), 0);
    fs.writeFileSync(file, L.xssBlocked + '\n' + L.upstream403 + '\n');
    assert.equal(await waf.pollOnce(), 4);
    assert.equal(await waf.pollOnce(), 0, 'nothing new');
    // A line written in two pieces is applied once complete.
    const half = Math.floor(L.sqliPost.length / 2);
    fs.appendFileSync(file, L.sqliPost.slice(0, half));
    assert.equal(await waf.pollOnce(), 0);
    fs.appendFileSync(file, L.sqliPost.slice(half) + '\n' + 'garbage line\n' + L.xssDetected + '\n');
    assert.equal(await waf.pollOnce(), 1 + 6);
    assert.equal(count(), 11);
    const row = db.prepare('SELECT * FROM waf_events WHERE rule_id = 942100').get();
    assert.equal(row.host, 'block.test'); assert.equal(row.route_id, 1); assert.equal(row.method, 'POST');
    assert.equal(row.action, 'blocked'); assert.equal(row.severity, 'critical');
    // One publish per transaction with the first detection rule.
    assert.deepEqual(events, [
      { host: 'block.test', action: 'blocked', rule_id: 941100 },
      { host: 'block.test', action: 'blocked', rule_id: 942100 },
      { host: 'detect.test', action: 'detected', rule_id: 941100 },
    ]);
  });
});

test('watcher: state survives a restart (no replay), truncation elsewhere is detected', async () => {
  await withLog([L.xssBlocked], async (file) => {
    assert.equal(await waf.pollOnce(), 4);
    waf.stopWatcher();
    fs.appendFileSync(file, L.lfiBlocked + '\n');
    waf.startWatcher({ file, intervalMs: 1e9, immediate: false });
    assert.equal(await waf.pollOnce(), 4, 'only the new line after restart');
    // Truncated + rewritten by someone else (shorter than our offset) → from the top.
    fs.writeFileSync(file, L.badJson + '\n');
    assert.equal(await waf.pollOnce(), 1);
    assert.equal(count(), 9);
  }, { truncateAfterIngest: false });
});

test('watcher: own rotation at the size limit keeps 3 files and loses nothing', async () => {
  await withLog([L.xssBlocked, L.lfiBlocked], async (file) => {
    // rotateBytes tiny → every poll that read the whole file rotates it.
    assert.equal(await waf.pollOnce(), 8);
    assert.equal(fs.statSync(file).size, 0, 'truncated in place (Coraza keeps its O_APPEND fd)');
    assert.ok(fs.existsSync(file + '.1'));
    // Writer continues into the same inode.
    fs.appendFileSync(file, L.sqliPost + '\n');
    assert.equal(await waf.pollOnce(), 1);
    fs.appendFileSync(file, L.badJson + '\n');
    assert.equal(await waf.pollOnce(), 1);
    fs.appendFileSync(file, L.xssDetected + '\n');
    assert.equal(await waf.pollOnce(), 6);
    fs.appendFileSync(file, L.sqliDetected + '\n');
    assert.equal(await waf.pollOnce(), 9);
    const files = fs.readdirSync(path.dirname(file)).sort();
    assert.deepEqual(files, ['waf-audit.log', 'waf-audit.log.1', 'waf-audit.log.2', 'waf-audit.log.3']);
    assert.equal(fs.readFileSync(file + '.1', 'utf8'), L.sqliDetected + '\n', 'newest rotated file is .1');
    assert.equal(count(), 25);
    for (const f of files) assert.equal(fs.statSync(path.join(path.dirname(file), f)).mode & 0o777, 0o600, f);
  }, { rotateBytes: 10, truncateAfterIngest: false });
});

test('watcher: rotates only once the file passed the limit AND is fully read', async () => {
  await withLog([L.xssBlocked], async (file) => {
    // Below the limit: read, no rotation. Then grow past it: read + rotate.
    assert.equal(await waf.pollOnce(), 4);
    assert.equal(fs.existsSync(file + '.1'), false);
    fs.appendFileSync(file, L.lfiBlocked + '\n');
    assert.equal(await waf.pollOnce(), 4);
    assert.equal(fs.statSync(file).size, 0);
    assert.equal(fs.readFileSync(file + '.1', 'utf8'), L.xssBlocked + '\n' + L.lfiBlocked + '\n');
    assert.equal(count(), 8);
  }, { rotateBytes: L.xssBlocked.length + 10, truncateAfterIngest: false });
});

test('watcher (default): file is emptied right after ingest, mode 0600, nothing lost on the next write', async () => {
  await withLog([L.xssBlocked, L.upstream403], async (file) => {
    fs.chmodSync(file, 0o644);
    assert.equal(await waf.pollOnce(), 4);
    assert.equal(fs.statSync(file).size, 0, 'truncated after ingest');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(file + '.1'), false, 'no rotated copy');
    // The writer continues at offset 0 (O_APPEND) — the next line is read in full.
    fs.appendFileSync(file, L.lfiBlocked + '\n');
    assert.equal(await waf.pollOnce(), 4);
    assert.equal(fs.statSync(file).size, 0);
    // A half-written line is not truncated away: the file stays until the line is complete.
    const half = Math.floor(L.sqliPost.length / 2);
    fs.appendFileSync(file, L.sqliPost.slice(0, half));
    assert.equal(await waf.pollOnce(), 0);
    assert.equal(fs.statSync(file).size, half);
    fs.appendFileSync(file, L.sqliPost.slice(half) + '\n');
    assert.equal(await waf.pollOnce(), 1);
    assert.equal(fs.statSync(file).size, 0);
    assert.equal(count(), 9);
  });
});

test('raw: redacted JSON of request line + rule messages; cookie / authorization matches never stored', async () => {
  const lookup = () => 1;
  const row = waf.eventsFromTransaction(waf.parseAuditLine(L.xssBlocked), lookup)[0];
  const raw = JSON.parse(row.raw);
  assert.equal(raw.request, 'GET /?q=%3Cscript%3Ealert(1)%3C/script%3E HTTP/1.1');
  // Real line with the attack in a cookie value: matched data redacted in every row.
  const ckRows = waf.eventsFromTransaction(waf.parseAuditLine(L.cookieXss), lookup);
  assert.ok(ckRows.length > 0);
  assert.equal(ckRows.some((r) => JSON.stringify(r).includes('COOKIEPAYLOAD')), false);
  assert.ok(ckRows.some((r) => JSON.parse(r.raw).rule.data === '[redacted: matched in REQUEST_COOKIES:q]'));
  assert.equal(raw.interrupted, true);
  assert.equal(raw.rule.id, 941100);
  assert.match(raw.rule.data, /ARGS:q/);
  assert.ok(raw.messages.some((m) => m.id === 949110), 'anomaly summary kept in the messages list');
  assert.equal(JSON.stringify(raw).includes('headers'), false);

  // A rule that fired on a cookie / credential header: value replaced.
  for (const target of ['REQUEST_COOKIES:sid', 'REQUEST_COOKIES_NAMES:x', 'REQUEST_HEADERS:Cookie', 'REQUEST_HEADERS:authorization', 'REQUEST_HEADERS:Proxy-Authorization']) {
    const data = `Matched Data: <script>SECRETVALUE found within ${target}: <script>SECRETVALUE</script>`;
    const red = waf.redactMatchedData(data);
    assert.equal(red.includes('SECRETVALUE'), false, target);
    assert.match(red, /^\[redacted: matched in /, target);
  }
  // Credential-like form / JSON fields: value replaced as well.
  for (const target of ['ARGS:password', 'ARGS_POST:new_passwd', 'ARGS:json.user.pwd', 'ARGS_POST:api_key', 'ARGS:access_token', 'ARGS_POST:recovery_code', 'ARGS_POST:client_secret']) {
    const red = waf.redactMatchedData(`Matched Data: ' or 1=1 SECRETVALUE found within ${target}: ' or 1=1 SECRETVALUE`);
    assert.equal(red.includes('SECRETVALUE'), false, target);
    assert.match(red, /^\[redacted: matched in ARGS/, target);
  }
  assert.equal(waf.redactMatchedData('Matched Data: x found within ARGS:q: x'), 'Matched Data: x found within ARGS:q: x');
  assert.equal(waf.redactMatchedData('Matched Data: x found within ARGS:user: x'), 'Matched Data: x found within ARGS:user: x');
  const tx = waf.parseAuditLine(L.xssBlocked);
  tx.messages[0].data = 'Matched Data: <script> found within REQUEST_COOKIES:session: <script>TOPSECRET';
  const rows = waf.eventsFromTransaction(tx, lookup);
  assert.equal(rows.some((r) => r.raw.includes('TOPSECRET')), false);
});
