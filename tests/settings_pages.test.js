'use strict';

// Settings: one address per section (/settings, /settings/<section>) with
// the old addresses forwarded (routes/index.js settingsTarget), the start
// page and its sources (services/settingsOverview.js, GET
// /api/v1/settings/overview), and one save bar for every page with fields.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const fs = require('node:fs');
const path = require('node:path');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent } = require('./helpers/setup');
const { withoutScripts } = require('./helpers/html');

const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

let agent, db, settings, overview, license, autoUpdate;

before(async () => {
  await setup();
  agent = getAgent();
  db = require('../src/db/connection').getDb();
  settings = require('../src/services/settings');
  overview = require('../src/services/settingsOverview');
  license = require('../src/services/license');
  autoUpdate = require('../src/services/autoUpdate');
});
after(() => { try { fs.rmSync(autoUpdate.STATE_FILE, { force: true }); } catch { /* gone */ } teardown(); });

const SECTIONS = ['domains', 'netzwerk', 'daten', 'anmeldung', 'geraete', 'gruppen', 'richtlinien', 'splittunnel', 'clientupdates',
  'email', 'benachrichtigungen', 'webhooks', 'monitoring', 'geoip', 'portal', 'ki', 'backup', 'updates', 'lizenz', 'gefahr'];

function visibleSections(html) {
  return [...html.matchAll(/<section class="st-section(?: [a-z-]+)?" data-section="([a-z]+)"[^>]*>/g)]
    .filter((m) => !/ hidden>$/.test(m[0])).map((m) => m[1]);
}

describe('one address per section', () => {
  it('/settings is the start page: "Übersicht" current, only the start section visible', async () => {
    const html = withoutScripts((await agent.get('/settings').expect(200)).text);
    assert.match(html, /<div class="pgx stx" id="st-page" data-section="start"/);
    assert.deepEqual(visibleSections(html), ['start']);
    const L = /<html lang="de"/.test(html) ? de : en;
    assert.ok(html.includes(`<h1 class="page-crumb">${L['nav.settings']}</h1>`));
    assert.match(html, /href="\/settings" data-section="start" aria-current="page"/);
  });

  for (const s of SECTIONS) {
    it(`/settings/${s}: its page visible, its menu entry current, the crumb names it`, async () => {
      const html = withoutScripts((await agent.get('/settings/' + s).expect(200)).text);
      assert.deepEqual(visibleSections(html), [s]);
      assert.match(html, new RegExp(`<div class="pgx stx" id="st-page" data-section="${s}"`));
      assert.match(html, new RegExp(`href="/settings/${s}" data-section="${s}" aria-current="page"`));
      assert.equal((html.match(/data-section="[a-z]+"[^>]* aria-current="page"/g) || []).length, 1, 'one menu entry is current');
      const L = /<html lang="de"/.test(html) ? de : en;
      const label = L['st.nav.' + s];
      assert.ok(html.includes(`<h1 class="page-crumb">${L['nav.settings']} / ${label.replace(/&/g, '&amp;')}</h1>`), label);
      assert.doesNotMatch(html, /\bst\.(nav|desc|att|state|tile|status)\.[a-z_]+/, 'no raw keys');
    });
  }

  it('old addresses are forwarded: ?tab=, /settings/<old tab>, /settings/uebersicht', async () => {
    for (const [from, to] of [
      ['/settings?tab=general', '/settings'], ['/settings?tab=backup', '/settings/backup'], ['/settings?tab=client-policy', '/settings/richtlinien'],
      ['/settings?tab=security', '/settings/anmeldung'], ['/settings?tab=nonsense', '/settings'],
      ['/settings/uebersicht', '/settings'], ['/settings/general', '/settings'], ['/settings/security', '/settings/anmeldung'],
      ['/settings/license', '/settings/lizenz'], ['/settings/start', '/settings'],
      ['/settings?plugin=hello', '/settings/plugins/manage/hello'], ['/settings?install=gatecontrol-familie', '/settings/plugins/catalog/gatecontrol-familie'],
    ]) {
      assert.equal((await agent.get(from).expect(302)).headers.location, to, from);
    }
  });

  it('unknown sections are a 404; Pi-hole without its licence leads to the start page', async () => {
    await agent.get('/settings/nope').expect(404);
    await agent.get('/settings/..%2Fdashboard').expect(404);
    assert.equal((await agent.get('/settings/pihole').expect(302)).headers.location, '/settings');
  });

  it('the plugin area keeps its own pages under /settings/plugins', async () => {
    const html = withoutScripts((await agent.get('/settings/plugins').expect(200)).text);
    assert.match(html, /<div class="pgx" id="pgx" data-view="installed"/);
  });
});

describe('one save bar, the same page pattern everywhere', () => {
  it('every field belongs to a section; KI-Anbieter has no own save button', async () => {
    const html = withoutScripts((await agent.get('/settings').expect(200)).text);
    assert.equal((html.match(/id="st-savebar"/g) || []).length, 1, 'one save bar');
    assert.doesNotMatch(html, /id="ai-defaults-save"/);
    for (const f of ['ai-default', 'ai-fallback', 'ai-media', 'ai-budget', 'ai-perhour', 'ai-rate', 'ai-prices']) {
      assert.match(html, new RegExp(`data-st-field="${f}"`), f);
    }
    // a field outside any section would never be saved
    const tpl = fs.readFileSync(path.join(__dirname, '..', 'templates', 'aurora', 'pages', 'settings.njk'), 'utf8');
    const body = tpl.slice(tpl.indexOf('{% block content %}'), tpl.indexOf('<div class="st-savebar"'));
    const outside = body.split(/<section class="st-section/).slice(0, 1).join('');
    assert.doesNotMatch(outside, /data-st-field=/);
  });

  it('page heads: at most a secondary and a primary action; card actions only in the card head', async () => {
    const tpl = fs.readFileSync(path.join(__dirname, '..', 'templates', 'aurora', 'pages', 'settings.njk'), 'utf8');
    for (const m of tpl.matchAll(/\{% call pageHead\([^)]*\) %\}([\s\S]*?)\{% endcall %\}/g)) {
      const pri = (m[1].match(/pgx-btn-pri/g) || []).length;
      const all = (m[1].match(/class="pgx-btn/g) || []).length;
      assert.ok(pri <= 1 && all <= 2, m[0].slice(0, 80));
    }
    assert.doesNotMatch(tpl, /st-card-foot|st-btn-dashed|\+ \{\{/, 'no foot actions, no dashed "+ add" buttons');
  });

  it('a segment never wraps: a choice that does not fit one line in the control column is a select', async () => {
    const html = withoutScripts((await agent.get('/settings').expect(200)).text);
    // short choices stay segments, long ones (machine binding, split-tunnel mode) are selects
    for (const id of ['st-smtp-tls', 'st-cu-channel', 'st-au-mode', 'st-cl-scope']) assert.match(html, new RegExp(`<div class="st-seg" role="group" id="${id}"`), id);
    for (const id of ['st-mb-mode', 'st-st-mode']) assert.match(html, new RegExp(`<select class="st-select" id="${id}" data-st-field=`), id);
    assert.match(html, /<label class="st-label" for="st-mb-mode" id="st-mb-mode-label">/, 'the select keeps its label');
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    assert.match(css, /\.stx \.st-row-ctl > \.st-seg,\.stx \.st-row-ctl > \.cpf-seg\{flex:0 1 auto; max-width:100%; flex-wrap:nowrap\}/, 'segments start left and keep one line');
    assert.match(css, /\.stx \.st-seg-btn,\.cpf-seg-btn\{[^}]*white-space:nowrap/);
    // the client policy rows use the same rule
    global.window = global.window || {};
    require('../public/js/client-policy-form.js');
    const fits = global.window.ClientPolicyForm.fitsSegment;
    assert.equal(fits(['Benutzer entscheidet', 'Erzwungen (immer an)']), true);
    assert.equal(fits(['Benutzer entscheidet', 'Erzwungen', 'Immer verbunden (Trennen gesperrt)']), false);
  });

  it('the danger actions live in the Gefahrenzone only', async () => {
    const html = withoutScripts((await agent.get('/settings').expect(200)).text);
    const sec = (id) => { const a = html.indexOf(`data-section="${id}" aria-labelledby`); return html.slice(a, html.indexOf('<section class="st-section', a + 10)); };
    assert.doesNotMatch(sec('daten'), /data-st-action="clear-logs"/, 'Daten: no second clean-up card');
    assert.match(sec('gefahr'), /data-st-action="clear-logs"/);
    assert.match(sec('gefahr'), /id="st-wg-stop"/);
    assert.match(sec('gefahr'), /id="card-restore"/);
    assert.doesNotMatch(sec('backup'), /id="st-rs-file"/);
  });
});

describe('start page: GET /api/v1/settings/overview', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM domains').run();
    db.prepare('DELETE FROM backup_targets').run();
    settings.set('domains.server_ip_warning', '0');
    settings.set('alerts.backup_reminder_days', '0');
    try { fs.rmSync(autoUpdate.STATE_FILE, { force: true }); } catch { /* none */ }
  });

  it('answers with tiles, attention rows and the state of every area — no text', async () => {
    const r = await agent.get('/api/v1/settings/overview').expect(200);
    const d = r.body.data;
    assert.equal(d.version, require('../package.json').version);
    assert.ok(d.tiles.domains && d.tiles.backup && d.tiles.license);
    assert.ok(Array.isArray(d.attention));
    for (const id of ['domains', 'netzwerk', 'daten', 'anmeldung', 'geraete', 'gruppen', 'splittunnel', 'clientupdates', 'email',
      'benachrichtigungen', 'webhooks', 'monitoring', 'geoip', 'portal', 'plugins', 'ki', 'backup', 'updates', 'lizenz']) {
      assert.ok(d.states[id] && /^st\.state\.[a-z_]+$/.test(d.states[id].key), id);
    }
  });

  it('domains: waiting for DNS and failed checks, at most three rows each, the failed ones first', () => {
    const ins = db.prepare('INSERT INTO domains (domain, status) VALUES (?, ?)');
    ['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com', 'e.example.com'].forEach((x) => ins.run(x, 'pending'));
    ins.run('bad.example.com', 'failed');
    ins.run('ok.example.com', 'verified');
    const att = overview.build().attention;
    const kinds = att.map((x) => x.kind);
    assert.equal(kinds[0], 'domain_failed');
    assert.equal(att[0].tone, 'crit');
    assert.deepEqual(att.filter((x) => x.kind === 'domain_pending').map((x) => x.params.domain), ['a.example.com', 'b.example.com', 'c.example.com']);
    assert.deepEqual(att.find((x) => x.kind === 'domain_pending_more').params, { n: 2 });
    assert.equal(att[0].href, '/settings/domains');
    const t = overview.build().tiles.domains;
    assert.deepEqual([t.total, t.verified, t.pending, t.failed], [7, 1, 5, 1]);
  });

  it('server IP warning, update marker, backups without a target / failing / too old, SMTP missing', async () => {
    settings.set('domains.server_ip_warning', '1');
    fs.writeFileSync(autoUpdate.STATE_FILE, JSON.stringify({ checked_at: new Date().toISOString(), action: 'waiting_window', mode: 'auto', ok: true }));
    settings.set('alerts.backup_reminder_days', '7');
    let kinds = overview.build().attention.map((x) => x.kind);
    for (const k of ['server_ip', 'update_waiting', 'backup_local_only', 'backup_none']) assert.ok(kinds.includes(k), k + ' in ' + kinds.join());
    assert.equal(overview.build().updates.lastAction, 'waiting_window');

    db.prepare("INSERT INTO backup_targets (name, type, config_enc, enabled, last_status, created_at) VALUES ('NAS', 'sftp', 'x', 1, 'failed', datetime('now'))").run();
    fs.writeFileSync(autoUpdate.STATE_FILE, JSON.stringify({ checked_at: new Date().toISOString(), action: 'rolled_back', mode: 'auto', ok: false, bad_version: '9.9.9' }));
    const att = overview.build().attention;
    kinds = att.map((x) => x.kind);
    assert.ok(!kinds.includes('backup_local_only'), 'a target exists');
    const failed = att.find((x) => x.kind === 'backup_target_failed');
    assert.deepEqual([failed.tone, failed.params.names], ['crit', 'NAS']);
    assert.equal(att.find((x) => x.kind === 'update_rolled_back').tone, 'crit');

    await agent.put('/api/v1/settings/alerts').set('X-CSRF-Token', require('./helpers/setup').getCsrf()).send({ email: 'admin@example.com' }).expect(200);
    kinds = overview.build().attention.map((x) => x.kind);
    assert.ok(kinds.includes('smtp_missing'), kinds.join());
  });

  it('without the backup licence an off-site target is not asked for', () => {
    license._overrideForTest({ scheduled_backups: false });
    try {
      assert.ok(!overview.build().attention.some((x) => x.kind === 'backup_local_only'));
    } finally { license._overrideForTest({ scheduled_backups: true }); }
  });

  it('a source that fails is left out instead of failing the page', () => {
    const domains = require('../src/services/domains');
    const orig = domains.list;
    domains.list = () => { throw new Error('boom'); };
    try {
      const o = overview.build();
      assert.equal(o.tiles.domains, null);
      assert.ok(o.states.netzwerk);
    } finally { domains.list = orig; }
  });

  it('every attention kind and state has its texts in both languages', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'settingsOverview.js'), 'utf8');
    const kinds = new Set(['wg_down', 'caddy_down', 'update_rolled_back', 'update_failed', 'domain_pending_more', 'domain_failed_more', 'plugin_license', 'plugin_crashed', 'plugin_blocked']);
    for (const m of src.matchAll(/add\('([a-z_]+)'/g)) if (!m[1].endsWith('_')) kinds.add(m[1]);
    for (const k of ['domain_pending', 'domain_failed', 'backup_stale', 'backup_none']) kinds.add(k);
    for (const k of kinds) {
      for (const part of ['title', 'sub', 'pill', 'action']) {
        const key = `st.att.${k}.${part}`;
        assert.ok(de[key] && en[key], key);
      }
    }
    const states = new Set();
    for (const m of src.matchAll(/st\('[a-z]+', '([a-z_]+)'/g)) if (!m[1].endsWith('_')) states.add(m[1]);
    for (const k of ['mb_off', 'mb_global', 'mb_individual', 'split_off', 'split_exclude', 'split_include', 'channel_stable', 'channel_beta', 'twofa_required', 'twofa_optional',
      'connected', 'not_set_up', 'recipient_set', 'no_recipient', 'key_set', 'no_key', 'on', 'off', 'providers', 'ai_off', 'last_backup', 'no_backup', 'update_ready', 'mode_auto', 'mode_manual']) states.add(k);
    for (const k of states) {
      const has = (l) => l['st.state.' + k] || (l['st.state.' + k + '_one'] && l['st.state.' + k + '_other']);
      assert.ok(has(de) && has(en), 'st.state.' + k);
    }
  });
});
