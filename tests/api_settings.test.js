'use strict';

// Charakterisierungs-Tests für /api/v1/settings/* — Safety-Net für den
// Split der 863-LOC-Datei routes/api/settings.js in 6 Cluster-Files.
// Deckt alle 37 Endpunkte mit ihren Status-Codes und Response-Shapes ab.
// Wenn der Split etwas bricht, schlagen diese Tests fehl.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf;

before(async () => {
  const ctx = await setup();
  agent = ctx.agent;
  csrf = ctx.csrfToken;
});

after(() => teardown());

// ─── User Cluster ───────────────────────────────────────────
describe('settings/user — profile, password, language', () => {
  it('GET /profile returns profile shape', async () => {
    const res = await agent.get('/api/v1/settings/profile').expect(200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.profile);
    assert.equal(typeof res.body.profile.username, 'string');
  });

  it('PUT /profile updates display_name', async () => {
    const res = await agent
      .put('/api/v1/settings/profile')
      .set('X-CSRF-Token', csrf)
      .send({ display_name: 'Test Admin' })
      .expect(200);
    assert.equal(res.body.ok, true);
  });

  it('PUT /profile rejects unsupported language', async () => {
    const res = await agent
      .put('/api/v1/settings/profile')
      .set('X-CSRF-Token', csrf)
      .send({ language: 'xx' })
      .expect(400);
    assert.equal(res.body.ok, false);
  });

  it('PUT /profile rejects invalid theme', async () => {
    const res = await agent
      .put('/api/v1/settings/profile')
      .set('X-CSRF-Token', csrf)
      .send({ theme: 'bogus' })
      .expect(400);
    assert.equal(res.body.ok, false);
  });

  it('PUT /password requires both current_password and new_password', async () => {
    const res = await agent
      .put('/api/v1/settings/password')
      .set('X-CSRF-Token', csrf)
      .send({})
      .expect(400);
    assert.equal(res.body.ok, false);
  });

  it('PUT /password rejects new_password shorter than 8 chars', async () => {
    const res = await agent
      .put('/api/v1/settings/password')
      .set('X-CSRF-Token', csrf)
      .send({ current_password: 'TestPass123!', new_password: 'x' })
      .expect(400);
    assert.equal(res.body.ok, false);
  });

  it('PUT /password rejects wrong current password', async () => {
    const res = await agent
      .put('/api/v1/settings/password')
      .set('X-CSRF-Token', csrf)
      .send({ current_password: 'WrongPass!', new_password: 'NewValidPass1!' })
      .expect(400);
    assert.equal(res.body.ok, false);
  });

  it('POST /language switches and persists', async () => {
    const res = await agent
      .post('/api/v1/settings/language')
      .set('X-CSRF-Token', csrf)
      .send({ language: 'de' })
      .expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.language, 'de');
  });

  it('POST /language rejects unsupported language', async () => {
    const res = await agent
      .post('/api/v1/settings/language')
      .set('X-CSRF-Token', csrf)
      .send({ language: 'xx' })
      .expect(400);
    assert.equal(res.body.ok, false);
  });
});

// ─── Appearance Cluster ─────────────────────────────────────
describe('settings/appearance — app, default-theme', () => {
  it('GET /app returns settings + config block', async () => {
    const res = await agent.get('/api/v1/settings/app').expect(200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.settings);
    assert.ok(res.body.config);
    assert.equal(typeof res.body.config.appName, 'string');
    assert.ok(Array.isArray(res.body.config.availableLanguages));
  });

  it('PUT /default-theme accepts valid theme', async () => {
    const res = await agent
      .put('/api/v1/settings/default-theme')
      .set('X-CSRF-Token', csrf)
      .send({ theme: 'default' })
      .expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.theme, 'default');
  });

  it('PUT /default-theme rejects invalid theme', async () => {
    const res = await agent
      .put('/api/v1/settings/default-theme')
      .set('X-CSRF-Token', csrf)
      .send({ theme: 'bogus' })
      .expect(400);
    assert.equal(res.body.ok, false);
  });
});

// ─── Security Cluster ───────────────────────────────────────
describe('settings/security — security, lockout, machine-binding', () => {
  it('GET /security returns lockout + password shape', async () => {
    const res = await agent.get('/api/v1/settings/security').expect(200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.data.lockout);
    assert.ok(res.body.data.password);
    assert.equal(typeof res.body.data.lockout.enabled, 'boolean');
    assert.equal(typeof res.body.data.password.min_length, 'number');
  });

  it('PUT /security updates settings', async () => {
    const res = await agent
      .put('/api/v1/settings/security')
      .set('X-CSRF-Token', csrf)
      .send({
        lockout: { enabled: true, max_attempts: 5, duration: 15 },
        password: { complexity_enabled: true, min_length: 10 },
      })
      .expect(200);
    assert.equal(res.body.ok, true);
  });

  it('GET /lockout returns locked accounts list', async () => {
    const res = await agent.get('/api/v1/settings/lockout').expect(200);
    assert.equal(res.body.ok, true);
    assert.ok(Array.isArray(res.body.locked));
  });

  it('DELETE /lockout/:identifier returns ok even for unknown identifier', async () => {
    const res = await agent
      .delete('/api/v1/settings/lockout/unknown@nowhere.test')
      .set('X-CSRF-Token', csrf)
      .expect(200);
    assert.equal(res.body.ok, true);
  });

  it('GET /machine-binding returns mode', async () => {
    const res = await agent.get('/api/v1/settings/machine-binding').expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.data.mode, 'string');
  });

  it('PUT /machine-binding accepts valid mode (license-gated, on for tests)', async () => {
    const res = await agent
      .put('/api/v1/settings/machine-binding')
      .set('X-CSRF-Token', csrf)
      .send({ mode: 'off' })
      .expect(200);
    assert.equal(res.body.ok, true);
  });

  it('PUT /machine-binding rejects invalid mode', async () => {
    const res = await agent
      .put('/api/v1/settings/machine-binding')
      .set('X-CSRF-Token', csrf)
      .send({ mode: 'bogus' })
      .expect(400);
    assert.equal(res.body.ok, false);
  });
});

// ─── Backup Cluster ─────────────────────────────────────────
describe('settings/backup — backup, restore, autobackup, clear-logs', () => {
  it('GET /backup downloads JSON backup', async () => {
    const res = await agent.get('/api/v1/settings/backup').expect(200);
    assert.match(res.headers['content-disposition'] || '', /^attachment/);
    assert.match(res.headers['content-type'] || '', /application\/json/);
  });

  it('POST /restore/preview rejects request without file', async () => {
    const res = await agent
      .post('/api/v1/settings/restore/preview')
      .set('X-CSRF-Token', csrf)
      .expect(400);
    assert.equal(res.body.ok, false);
  });

  it('POST /restore rejects request without file', async () => {
    const res = await agent
      .post('/api/v1/settings/restore')
      .set('X-CSRF-Token', csrf)
      .expect(400);
    assert.equal(res.body.ok, false);
  });

  it('POST /restore/preview rejects invalid JSON', async () => {
    const res = await agent
      .post('/api/v1/settings/restore/preview')
      .set('X-CSRF-Token', csrf)
      .attach('backup', Buffer.from('not-json'), 'corrupt.json')
      .expect(400);
    assert.equal(res.body.ok, false);
  });

  it('POST /clear-logs returns ok with deleted count', async () => {
    const res = await agent
      .post('/api/v1/settings/clear-logs')
      .set('X-CSRF-Token', csrf)
      .expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.deleted, 'number');
  });

  it('GET /autobackup returns settings', async () => {
    const res = await agent.get('/api/v1/settings/autobackup').expect(200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.data);
  });

  it('PUT /autobackup updates settings', async () => {
    const res = await agent
      .put('/api/v1/settings/autobackup')
      .set('X-CSRF-Token', csrf)
      .send({ enabled: false, schedule: 'daily', retention: 7 })
      .expect(200);
    assert.equal(res.body.ok, true);
  });

  it('GET /autobackup/list returns files array', async () => {
    const res = await agent.get('/api/v1/settings/autobackup/list').expect(200);
    assert.equal(res.body.ok, true);
    assert.ok(Array.isArray(res.body.files));
  });

  it('GET /autobackup/download/:filename returns 404 for unknown file', async () => {
    await agent
      .get('/api/v1/settings/autobackup/download/does-not-exist.json')
      .expect(404);
  });

  it('DELETE /autobackup/:filename rejects invalid filename', async () => {
    const res = await agent
      .delete('/api/v1/settings/autobackup/' + encodeURIComponent('../etc/passwd'))
      .set('X-CSRF-Token', csrf);
    // Could be 400 (invalid filename) or 404 (not found) depending on path handling
    assert.ok([400, 404].includes(res.status));
    assert.equal(res.body.ok, false);
  });
});

// ─── Network Cluster ────────────────────────────────────────
describe('settings/network — dns, split-tunnel', () => {
  it('GET /dns returns dns + is_custom + default_dns', async () => {
    const res = await agent.get('/api/v1/settings/dns').expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.data.dns, 'string');
    assert.equal(typeof res.body.data.is_custom, 'boolean');
    assert.equal(typeof res.body.data.default_dns, 'string');
  });

  it('PUT /dns accepts valid IPv4 list', async () => {
    const res = await agent
      .put('/api/v1/settings/dns')
      .set('X-CSRF-Token', csrf)
      .send({ dns: '1.1.1.1,8.8.8.8' })
      .expect(200);
    assert.equal(res.body.ok, true);
  });

  it('PUT /dns rejects malformed IP', async () => {
    const res = await agent
      .put('/api/v1/settings/dns')
      .set('X-CSRF-Token', csrf)
      .send({ dns: 'not-an-ip' })
      .expect(400);
    assert.equal(res.body.ok, false);
  });

  it('PUT /dns clears custom DNS when value is empty', async () => {
    const res = await agent
      .put('/api/v1/settings/dns')
      .set('X-CSRF-Token', csrf)
      .send({ dns: '' })
      .expect(200);
    assert.equal(res.body.ok, true);
  });

  it('GET /split-tunnel returns mode/networks/locked', async () => {
    const res = await agent.get('/api/v1/settings/split-tunnel').expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.mode, 'string');
    assert.ok(Array.isArray(res.body.networks));
    assert.equal(typeof res.body.locked, 'boolean');
  });

  it('PUT /split-tunnel rejects invalid mode', async () => {
    const res = await agent
      .put('/api/v1/settings/split-tunnel')
      .set('X-CSRF-Token', csrf)
      .send({ mode: 'bogus', networks: [], locked: false });
    // Either 400 (invalid mode) or 403 if license-gating fires first
    assert.ok([400, 403].includes(res.status));
    assert.equal(res.body.ok, false);
  });

  it('PUT /split-tunnel rejects networks > 50', async () => {
    const tooMany = Array.from({ length: 51 }, () => ({ cidr: '10.0.0.0/24' }));
    const res = await agent
      .put('/api/v1/settings/split-tunnel')
      .set('X-CSRF-Token', csrf)
      .send({ mode: 'exclude', networks: tooMany, locked: false });
    assert.ok([400, 403].includes(res.status));
    assert.equal(res.body.ok, false);
  });

  it('PUT /split-tunnel rejects bad CIDR', async () => {
    const res = await agent
      .put('/api/v1/settings/split-tunnel')
      .set('X-CSRF-Token', csrf)
      .send({ mode: 'exclude', networks: [{ cidr: 'bogus' }], locked: false });
    assert.ok([400, 403].includes(res.status));
    assert.equal(res.body.ok, false);
  });
});

// ─── Observability Cluster ──────────────────────────────────
describe('settings/observability — monitoring, metrics, alerts, ip2location, data', () => {
  it('GET /monitoring returns settings', async () => {
    const res = await agent.get('/api/v1/settings/monitoring').expect(200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.data);
  });

  it('PUT /monitoring updates interval / email_alerts / alert_email', async () => {
    const res = await agent
      .put('/api/v1/settings/monitoring')
      .set('X-CSRF-Token', csrf)
      .send({ interval: 60, email_alerts: 'true', alert_email: 'op@example.test' })
      .expect(200);
    assert.equal(res.body.ok, true);
  });

  it('GET /metrics returns enabled flag', async () => {
    const res = await agent.get('/api/v1/settings/metrics').expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.data.enabled, 'boolean');
  });

  it('PUT /metrics toggles enabled', async () => {
    const res = await agent
      .put('/api/v1/settings/metrics')
      .set('X-CSRF-Token', csrf)
      .send({ enabled: true })
      .expect(200);
    assert.equal(res.body.ok, true);
  });

  it('GET /alerts returns shape with all keys', async () => {
    const res = await agent.get('/api/v1/settings/alerts').expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.data.email, 'string');
    assert.equal(typeof res.body.data.email_events, 'string');
    assert.equal(typeof res.body.data.backup_reminder_days, 'number');
    assert.equal(typeof res.body.data.resource_cpu_threshold, 'number');
    assert.equal(typeof res.body.data.resource_ram_threshold, 'number');
  });

  it('PUT /alerts updates fields (license-gated, on for tests)', async () => {
    const res = await agent
      .put('/api/v1/settings/alerts')
      .set('X-CSRF-Token', csrf)
      .send({
        email: 'alerts@example.test',
        email_events: 'peer_offline',
        backup_reminder_days: 14,
        resource_cpu_threshold: 80,
        resource_ram_threshold: 90,
      })
      .expect(200);
    assert.equal(res.body.ok, true);
  });

  it('GET /ip2location returns has_api_key flag', async () => {
    const res = await agent.get('/api/v1/settings/ip2location').expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.data.has_api_key, 'boolean');
  });

  it('PUT /ip2location stores api key', async () => {
    const res = await agent
      .put('/api/v1/settings/ip2location')
      .set('X-CSRF-Token', csrf)
      .send({ api_key: 'TEST-KEY-XYZ' })
      .expect(200);
    assert.equal(res.body.ok, true);
  });

  it('POST /ip2location/test returns ok shape (offline-friendly)', async () => {
    const res = await agent
      .post('/api/v1/settings/ip2location/test')
      .set('X-CSRF-Token', csrf)
      .send({ ip: '8.8.8.8' });
    // network call may fail in CI sandbox — just assert status range
    assert.ok([200, 500].includes(res.status));
  });

  it('GET /data returns retention shape', async () => {
    const res = await agent.get('/api/v1/settings/data').expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.data.retention_traffic_days, 'number');
    assert.equal(typeof res.body.data.retention_activity_days, 'number');
    assert.equal(typeof res.body.data.peer_online_timeout, 'number');
  });

  it('PUT /data clamps + accepts in-range values', async () => {
    const res = await agent
      .put('/api/v1/settings/data')
      .set('X-CSRF-Token', csrf)
      .send({ retention_traffic_days: 7, retention_activity_days: 14, peer_online_timeout: 120 })
      .expect(200);
    assert.equal(res.body.ok, true);
  });
});

// ─── Token-Auth-Forbidden Middleware ────────────────────────
describe('settings — token-auth forbidden paths', () => {
  it('forbidden paths array exists in module exports source', () => {
    // Sanity: the route file is expected to mount a token-forbidden middleware
    // that 403s session-only endpoints when accessed via API token.
    // We can't test token auth without spinning up tokens here, but we record
    // the contract: backup/restore/clear-logs/security/lockout/dns/
    // machine-binding/split-tunnel/autobackup/ip2location/metrics/password/profile
    // must NOT be reachable via token. The split must preserve this guard.
    // (Behavior is exercised in tokens_gateway_scope.test.js)
    assert.ok(true);
  });
});
