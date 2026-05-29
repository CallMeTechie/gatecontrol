'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

before(async () => { await setup(); });
after(() => teardown());

describe('GET /api/v1/system/auto-update', () => {
  it('returns status + mode', async () => {
    const res = await getAgent().get('/api/v1/system/auto-update');
    assert.equal(res.status, 200);
    assert.ok(['not_configured', 'active', 'stale'].includes(res.body.status));
    assert.ok(['auto', 'manual'].includes(res.body.mode));
  });
});

describe('PUT /api/v1/system/auto-update', () => {
  it('sets the mode', async () => {
    const res = await getAgent().put('/api/v1/system/auto-update')
      .set('X-CSRF-Token', getCsrf()).send({ mode: 'manual' });
    assert.equal(res.status, 200);
    assert.equal(res.body.mode, 'manual');
  });
  it('rejects an invalid mode', async () => {
    const res = await getAgent().put('/api/v1/system/auto-update')
      .set('X-CSRF-Token', getCsrf()).send({ mode: 'bogus' });
    assert.equal(res.status, 400);
  });
});

describe('POST /api/v1/system/auto-update/trigger', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const dataDir = process.env.GC_DATA_PATH || process.env.GC_DATA_DIR;
  const marker = path.join(dataDir, '.auto-update-state.json');
  function setMode(mode){ return getAgent().put('/api/v1/system/auto-update').set('X-CSRF-Token', getCsrf()).send({ mode }); }
  it('409 in auto mode', async () => {
    await setMode('auto');
    const res = await getAgent().post('/api/v1/system/auto-update/trigger').set('X-CSRF-Token', getCsrf()).send({});
    assert.equal(res.status, 409);
  });
  it('queues in manual mode when a live cron marker is fresh', async () => {
    await setMode('manual');
    fs.writeFileSync(marker, JSON.stringify({ checked_at: new Date().toISOString(), action: 'noop', mode: 'manual', ok: true }));
    const res = await getAgent().post('/api/v1/system/auto-update/trigger').set('X-CSRF-Token', getCsrf()).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.queued, true);
  });
  it('refuses (queued:false, stale_no_cron) in manual mode without a live cron', async () => {
    await setMode('manual');
    try { fs.unlinkSync(marker); } catch {}
    const res = await getAgent().post('/api/v1/system/auto-update/trigger').set('X-CSRF-Token', getCsrf()).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.queued, false);
    assert.equal(res.body.reason, 'stale_no_cron');
  });
});

describe('GET /api/v1/system/update-sh', () => {
  it('serves the script as attachment', async () => {
    const res = await getAgent().get('/api/v1/system/update-sh');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-disposition'] || '', /update\.sh/);
    assert.match(res.text, /^#!\/bin\/bash/);
  });
});
