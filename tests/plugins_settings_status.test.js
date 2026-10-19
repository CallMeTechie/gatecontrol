'use strict';

// Settings form of a plugin (docs/plugins.md "plugin.json", "Plugin code"):
// ui.settingsGroups give the form headings, the hook settingsStatus status
// lines; saving waits for settingsChanged so the lines show its outcome.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HELLO, helloPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let agent, csrf, runtime, plugins;
const API = '/api/v1/plugins';

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  const raw = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
  const ui = {
    ...raw.ui,
    settingsGroups: [{ id: 'account', label: { de: 'Konto', en: 'Account' }, help: { de: 'Zugang zum Dienst', en: 'Access to the service' } }],
    settings: raw.ui.settings.map((s) => (s.key === 'token' ? { ...s, group: 'account' } : s)),
  };
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream')
    .send(helloPackage({ overrides: { ui } })).expect(200);
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
  assert.equal(await runtime.waitRunning('hello'), true);
});
after(async () => {
  await plugins.stop();
  teardown();
});

describe('settings groups and status lines', () => {
  it('the form carries the groups (in the viewer’s language) and each setting its group', async () => {
    const r = await agent.get(API + '/hello/settings').set('Accept-Language', 'en').expect(200);
    assert.deepEqual(r.body.groups, [{ id: 'account', label: 'Account', help: 'Access to the service' }]);
    assert.deepEqual(r.body.defs.map((d) => [d.key, d.group]), [['greeting', null], ['loud', null], ['repeat', null], ['token', 'account']]);
    assert.deepEqual(r.body.status, []);
  });

  it('saving waits for settingsChanged and answers with the status lines, cleaned', async () => {
    let r = await agent.put(API + '/hello/settings').set('X-CSRF-Token', csrf).send({ values: { token: 'good' } }).expect(200);
    // the text in the viewer's language (the session's: English after the first request here)
    assert.deepEqual(r.body.status, [{ group: 'account', tone: 'ok', text: 'Signed in' }, { group: null, tone: 'info', text: 'Hallo  Welt' }]);
    assert.deepEqual(r.body.values.token, { set: true });
    r = await agent.put(API + '/hello/settings').set('X-CSRF-Token', csrf).send({ values: { token: 'bad' } }).expect(200);
    assert.deepEqual(r.body.status, [{ group: 'account', tone: 'error', text: 'Anmeldung fehlgeschlagen' }, { group: null, tone: 'info', text: 'x' }], 'unknown group → above the form, unknown tone → info');
    const g = await agent.get(API + '/hello/settings').expect(200);
    assert.equal(g.body.status[0].tone, 'error');
  });

  it('a manifest with a setting in an unknown group is refused', () => {
    const m = require('../src/services/plugins/manifest');
    const base = { id: 'x-y', name: 'x', version: '1.0.0', publisher: 'p', gatecontrol: '*', entry: 'a.js' };
    let r = m.validate({ ...base, ui: { settings: [{ key: 'a', type: 'text', label: 'A', group: 'g' }] } });
    assert.ok(r.errors.includes('ui.settings: unknown group'), r.errors.join());
    r = m.validate({ ...base, ui: { settingsGroups: [{ id: 'g', label: 'G' }, { id: 'g', label: 'H' }] } });
    assert.ok(r.errors.includes('ui.settingsGroups: duplicate'), r.errors.join());
    r = m.validate({ ...base, ui: { settingsGroups: [{ id: 'G!', label: 'G' }] } });
    assert.ok(r.errors.includes('ui.settingsGroups: invalid'), r.errors.join());
    r = m.validate({ ...base, ui: { settingsGroups: [{ id: 'g', label: 'G' }], settings: [{ key: 'a', type: 'text', label: 'A', group: 'g' }] } });
    assert.deepEqual(r.errors, []);
  });
});
