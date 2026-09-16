'use strict';

// update.sh version marker (docs/feature-next-package.md §S2.2). Both copies
// of the script carry "# gc-update-sh: <n>"; update.sh writes its own number
// into .auto-update-state.json, the image reads its own from the vendored copy,
// and GET /api/v1/system/auto-update reports
// update_sh: { host_version, image_version, matches }.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, teardown, getAgent } = require('./helpers/setup');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MARKER_RE = /^# gc-update-sh: (\d+)$/m;

let systemSetup;
let autoUpdate;
let stateFile;

before(async () => {
  await setup();
  systemSetup = require('../src/services/systemSetup');
  autoUpdate = require('../src/services/autoUpdate');
  stateFile = autoUpdate.STATE_FILE;
});
after(() => { try { fs.unlinkSync(stateFile); } catch { /* gone */ } teardown(); });

function writeMarker(extra) {
  fs.writeFileSync(stateFile, JSON.stringify({
    checked_at: new Date().toISOString(), action: 'noop', mode: 'auto', ok: true, ...extra,
  }));
}

describe('the script itself', () => {
  it('both copies carry the same version marker and stay byte-identical', () => {
    const root = read('update.sh');
    const vendored = read('src/services/systemSetup/templates/update.sh');
    assert.equal(root, vendored, 'repo-root and vendored update.sh must not drift');
    const m = MARKER_RE.exec(root);
    assert.ok(m, 'update.sh carries a "# gc-update-sh: <n>" line');
    assert.equal(systemSetup.updateShVersion(), Number(m[1]));
  });

  it('writes its own version into the state marker and reads it the same way', () => {
    const src = read('update.sh');
    assert.match(src, /"update_sh":%s/, 'write_state carries update_sh');
    assert.match(src, /SELF_VERSION="\$\(update_sh_version "\$SCRIPT_PATH"\)"/);
    assert.match(src, /GC_UPDATE_SH_SELFUPDATE/, 'the self-update can be switched off');
    assert.match(src, /docker run --rm --entrypoint sh "\$IMAGE" -c 'cat \/app\/update\.sh'/);
    assert.match(src, /mv -f "\$tmp" "\$SCRIPT_PATH"/, 'atomic replace');
    assert.match(src, /cp -p "\$SCRIPT_PATH" "\$SCRIPT_PATH\.bak"/, 'backup of the old version');
    assert.doesNotMatch(src, /exec\s+"?\$SCRIPT_PATH/, 'never re-executed in the same run');
  });

  it('parseUpdateShVersion only accepts the exact marker line', () => {
    assert.equal(systemSetup.parseUpdateShVersion('x\n# gc-update-sh: 7\ny'), 7);
    assert.equal(systemSetup.parseUpdateShVersion('# gc-update-sh: 0'), 0);
    assert.equal(systemSetup.parseUpdateShVersion('  # gc-update-sh: 7'), null);
    assert.equal(systemSetup.parseUpdateShVersion('# gc-update-sh: v7'), null);
    assert.equal(systemSetup.parseUpdateShVersion('# gc-update-sh: 7 '), null);
    assert.equal(systemSetup.parseUpdateShVersion(''), null);
  });
});

describe('GET /api/v1/system/auto-update → update_sh', () => {
  const image = () => systemSetup.updateShVersion();

  it('no marker yet → host_version null, no match', async () => {
    try { fs.unlinkSync(stateFile); } catch { /* gone */ }
    const res = await getAgent().get('/api/v1/system/auto-update');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.update_sh, { host_version: null, image_version: image(), matches: false });
  });

  it('an update.sh without the marker stays host_version null (one-off reinstall)', async () => {
    writeMarker({});
    const res = await getAgent().get('/api/v1/system/auto-update');
    assert.equal(res.body.update_sh.host_version, null);
    assert.equal(res.body.update_sh.matches, false);
  });

  it('same version on both sides → matches true', async () => {
    writeMarker({ update_sh: image() });
    const res = await getAgent().get('/api/v1/system/auto-update');
    assert.deepEqual(res.body.update_sh, { host_version: image(), image_version: image(), matches: true });
  });

  it('an older host version → matches false', async () => {
    writeMarker({ update_sh: image() - 1 });
    const res = await getAgent().get('/api/v1/system/auto-update');
    assert.equal(res.body.update_sh.host_version, image() - 1);
    assert.equal(res.body.update_sh.matches, false);
  });

  it('a nonsense value in the marker is ignored', async () => {
    for (const v of ['3', -1, 1.5, 1e12, null, {}]) {
      writeMarker({ update_sh: v });
      const res = await getAgent().get('/api/v1/system/auto-update');
      assert.equal(res.body.update_sh.host_version, null, JSON.stringify(v));
    }
  });
});
