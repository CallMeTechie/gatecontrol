'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const gs = require('../src/services/gatewaySetup');

test('slug sanitizes hostile names', () => {
  assert.equal(gs._slug('Office GW', 7), 'office-gw');
  assert.equal(gs._slug('..', 7), 'gateway-7');
  assert.equal(gs._slug('a\nb', 7), 'a-b');
  assert.equal(gs._slug('', 7), 'gateway-7');
  assert.equal(gs._slug('  ', 7), 'gateway-7');
});

test('renderScript embeds update.sh + single-quotes/escapes name + lowercase image', () => {
  const s = gs.renderScript({ id: 7, name: "weird ' name" });
  const m = s.match(/^GATEWAY_NAME=.*$/m);
  assert.ok(m && m[0].indexOf("'\\''") !== -1, 'name single-quote-escaped on one line');
  assert.equal(s.indexOf('{{UPDATE_SH}}'), -1, 'UPDATE_SH placeholder consumed');
  assert.match(s, /GATEWAY_STATE_DIR:-\/state/);
  assert.match(s, /ghcr\.io\/callmetechie\/gatecontrol-gateway:latest/);
});

test('renderScript does not interpret $-sequences in the name (replace footgun)', () => {
  const s = gs.renderScript({ id: 7, name: '$& $$ end' });
  assert.match(s, /^GATEWAY_NAME='\$& \$\$ end'$/m);
});

test('buildBundleFiles lists all expected entries', () => {
  const names = gs.buildBundleFiles({ id: 7, name: 'gw' }).map((f) => f.name).sort();
  assert.deepEqual(names, ['README.md','docker-compose.state-snippet.yml','setup.sh','systemd/gatecontrol-gateway-update.path','systemd/gatecontrol-gateway-update.service','update.sh']);
});

test('rendered setup.sh passes bash -n syntax check', { skip: !require('node:child_process').spawnSync('bash', ['--version']).status === 0 }, () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const which = spawnSync('bash', ['--version']);
  if (which.status !== 0 && which.error) {
    // bash not available — skip gracefully
    return;
  }
  const script = gs.renderScript({ id: 1, name: 'x' });
  const tmp = require('node:path').join(os.tmpdir(), `gatecontrol-setup-test-${process.pid}.sh`);
  fs.writeFileSync(tmp, script, 'utf8');
  try {
    const result = spawnSync('bash', ['-n', tmp]);
    assert.equal(result.status, 0, `bash -n failed: ${result.stderr ? result.stderr.toString() : ''}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
});
