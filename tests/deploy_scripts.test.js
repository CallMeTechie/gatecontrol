'use strict';

// Host-side deployment files: the release docker-compose.yml(s), deploy/setup.sh
// and update.sh. The compose files bind ./data:/data — update.sh, the
// dashboard's update status and a plain tar backup of the install folder all
// read the data there. update.sh falls back to the mountpoint of an older
// install's named volume (gatecontrol-data); tests/update_sh.test.sh covers that
// with a fake docker and runs here, so CI does not skip it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const SCRIPTS = ['update.sh', 'deploy/setup.sh'];

describe('release docker-compose.yml', () => {
  for (const f of ['docker-compose.yml', 'deploy/docker-compose.yml']) {
    it(`${f} binds ./data:/data and declares no gatecontrol-data volume`, () => {
      const src = read(f);
      assert.match(src, /^\s+- \.\/data:\/data\s*$/m, `${f}: ./data:/data missing`);
      assert.doesNotMatch(src, /^\s+- gatecontrol-data:\/data/m, `${f}: still mounts the named volume`);
      assert.doesNotMatch(src, /^ {2}gatecontrol-data:\s*$/m, `${f}: still declares the named volume`);
      assert.match(src, /^ {2}clamav-db:\s*$/m, `${f}: the clamav volume must stay`);
    });
  }
});

describe('deploy/setup.sh', () => {
  const src = read('deploy/setup.sh');
  const firstUp = src.indexOf('docker compose up -d');

  it('creates ./data and refuses a silent empty start next to an old volume', () => {
    assert.match(src, /^mkdir -p data$/m);
    assert.match(src, /^data_dir_guard$/m);
    assert.ok(src.indexOf('\ndata_dir_guard\n') < firstUp, 'guard must run before the first compose up');
    assert.match(src, /gatecontrol-data\$'/, 'looks for <project>_gatecontrol-data volumes');
  });

  it('asks for the time zone and writes TZ into .env', () => {
    assert.match(src, /set_env TZ "\$\{time_zone\}"/);
    assert.match(src, /\/etc\/timezone/);
    assert.match(src, /timedatectl show -p Timezone --value/);
    assert.match(src, /Europe\/Berlin/);
  });

  it('copies update.sh out of the image when it is missing', () => {
    assert.match(src, /cat \/app\/update\.sh/);
    assert.match(src, /bash -n update\.sh\.tmp/, 'syntax check before it is used');
  });

  it('only sets up the cron schedule after the container was started', () => {
    const call = src.lastIndexOf('setup_update_cron');
    assert.ok(call > src.lastIndexOf('docker compose up -d'), 'cron after compose up');
    assert.match(src, /\[ -e "\$cron_file" \]/, 'an existing schedule is never overwritten');
  });
});

describe('shell scripts', () => {
  for (const f of SCRIPTS) {
    it(`${f}: bash -n`, () => {
      const r = spawnSync('bash', ['-n', path.join(ROOT, f)], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    });
  }

  it('shellcheck -S warning is clean', { skip: !has('shellcheck') && 'shellcheck not installed' }, () => {
    const r = spawnSync('shellcheck', ['-S', 'warning', ...SCRIPTS, 'tests/update_sh.test.sh'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  it('tests/update_sh.test.sh passes (fake docker)', { skip: process.platform !== 'linux' && 'needs GNU coreutils' }, () => {
    const r = spawnSync('bash', [path.join(ROOT, 'tests/update_sh.test.sh')], { encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, r.stdout.split('\n').filter((l) => /NOT OK|passed/.test(l)).join('\n') + r.stderr);
    assert.match(r.stdout, /update_sh\.test\.sh: \d+ passed, 0 failed/);
  });
});
