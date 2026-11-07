'use strict';

// Rate limits of the official plugin catalogue (src/middleware/rateLimit.js
// pluginCatalogLimiter / pluginCatalogRefreshLimiter, routes/api/pluginCatalog.js):
// "Alle aktualisieren" prepares one catalogue download per plugin — 16 at once
// (and the dialog opened again) must pass; the limit still applies eventually,
// with a translated 429 that says when to try again; the downloads do not eat
// the upload budget (uploadLimiter: /plugins/inspect, backup restore, branding)
// and ?refresh=1 has a small bucket of its own. The network is a stubbed transport.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { helloPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

const API = '/api/v1/plugin-catalog';
const GH = 'https://github.com/CallMeTechie/gatecontrol-plugins/releases/download';
const N = 16;

let agent, csrf, plugins, catalog;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const routes = new Map();
const fetched = [];

function entry(id, version, buf) {
  return {
    schema: 1, id, name: { de: id, en: id }, description: { de: 'Beispiel', en: 'Example' }, publisher: 'GateControl Tests',
    version, prerelease: false, gatecontrol: '>=1.0.0', license_required: false, file: `${id}-${version}.gcplugin`,
    size: buf.length, sha256: sha(buf), url: `${GH}/${id}-v${version}/${id}-${version}.gcplugin`,
    signature: { alg: 'Ed25519', key_id: '0000000000000000', public_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
    tag: `${id}-v${version}`, release_url: `https://github.com/CallMeTechie/gatecontrol-plugins/releases/tag/${id}-v${version}`,
    published_at: '2026-11-07T10:00:00.000Z',
  };
}

const ids = Array.from({ length: N }, (_, i) => `bulk-${i + 1}`);

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  plugins = require('../src/services/plugins');
  catalog = require('../src/services/plugins/catalog');
  require('../src/db/connection').getDb().prepare("UPDATE users SET language = 'de' WHERE username = 'admin'").run();
  const out = {};
  for (const id of ids) {
    const buf = helloPackage({ overrides: { id, name: id, version: '1.0.1' } });
    const e = entry(id, '1.0.1', buf);
    routes.set(e.url, { status: 200, body: buf });
    out[id] = { id, name: e.name, description: e.description, publisher: e.publisher, latest: e, versions: [e] };
  }
  routes.set(catalog.DEFAULT_URL, { status: 200, body: Buffer.from(JSON.stringify({ schema: 1, generated_at: '2026-11-07T00:00:00.000Z', repository: 'CallMeTechie/gatecontrol-plugins', plugins: out })) });
  catalog._reset();
  catalog._setTransport(async (url) => {
    fetched.push(url);
    const r = routes.get(url);
    return r ? { status: r.status, location: null, body: r.body } : { status: 404, location: null, body: null };
  });
});
after(async () => {
  catalog._reset();
  await plugins.stop();
  teardown();
});

const prepare = (id) => agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ id, version: '1.0.1' });

describe('plugin catalogue rate limits', () => {
  it('"Alle aktualisieren" for 16 plugins passes — three times over (dialog opened again, retries)', async () => {
    for (let round = 0; round < 3; round++) {
      for (const id of ids) {
        const r = await prepare(id);
        assert.equal(r.status, 200, `round ${round + 1}, ${id}: ${r.status} ${JSON.stringify(r.body)}`);
        assert.equal(r.body.canInstall, true, id);
        assert.equal(r.headers['ratelimit-limit'], '100');
      }
    }
  });

  it('the downloads have their own bucket: the upload budget is untouched', async () => {
    const r = await agent.post('/api/v1/plugins/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(Buffer.from('not a package'));
    assert.notEqual(r.status, 429);
    assert.equal(r.headers['ratelimit-limit'], '15', 'the upload limiter still guards /plugins/inspect');
  });

  it('the limit still applies eventually: a translated 429 with Retry-After, nothing downloaded', async () => {
    let r;
    let n = 3 * N;
    do {
      r = await prepare(ids[0]);
      n++;
    } while (r.status === 200 && n < 200);
    assert.equal(r.status, 429);
    assert.equal(n, 101, 'the 101st download in the window is refused');
    const before = fetched.length;
    assert.equal((await prepare(ids[1])).status, 429);
    assert.equal(fetched.length, before, 'a refused request does not reach GitHub');
    assert.equal(r.body.ok, false);
    assert.equal(r.body.code, 'rate_limited');
    assert.ok(r.body.retryAfter >= 1 && r.body.retryAfter <= 15 * 60, String(r.body.retryAfter));
    assert.ok(Number(r.headers['retry-after']) >= 1);
    const minutes = Math.max(1, Math.ceil(r.body.retryAfter / 60));
    assert.equal(r.body.error, de['error.rate_limit.plugin_catalog'].replace('{{minutes}}', String(minutes)));
    assert.match(r.body.error, /^Zu viele Plugin-Downloads in kurzer Zeit\. Bitte in \d+ Minute\(n\) erneut versuchen\.$/);
    assert.match(en['error.rate_limit.plugin_catalog'], /\{\{minutes\}\}/);
  });

  it('?refresh=1 has a small bucket of its own (20 per 15 minutes), cached reads stay open', async () => {
    let r;
    let n = 0;
    do {
      r = await agent.get(API + '/updates?refresh=1');
      n++;
    } while (r.status === 200 && n < 100);
    assert.equal(n, 21);
    assert.equal(r.status, 429);
    assert.equal(r.body.code, 'rate_limited');
    assert.match(r.body.error, /^Der Plugin-Katalog wurde zu oft neu abgefragt\. Bitte in \d+ Minute\(n\) erneut versuchen\.$/);
    assert.equal((await agent.get(API + '?refresh=1')).status, 429, 'one bucket for both lists');
    const cached = await agent.get(API).expect(200);
    assert.equal(cached.body.available, true);
    assert.equal(cached.body.plugins.length, N);
  });
});
