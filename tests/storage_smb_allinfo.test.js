'use strict';

// SMB driver, head(): `allinfo` of smbclient 4.21 and newer also asks for the
// shadow copies of the file and, on a share without them (most shares),
// prints "NT_STATUS_INVALID_DEVICE_REQUEST getting shadow copy data for …"
// (source3/client/client.c, do_allinfo). Size and time are there all the
// same — that line is no error. Everything else still is. The live test
// (tests/storage_targets_live.test.js) runs against the Samba of the runner;
// this one pins the output of 4.23 with an smbclient shim.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const shimRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-smb-allinfo-shim-'));
const shim = path.join(shimRoot, 'smbclient');
// answers by the file name in the allinfo line (stdout and stderr, like smbclient)
fs.writeFileSync(shim, `#!/usr/bin/env node
const fs = require('fs');
let stdin = ''; try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
const name = (/allinfo "([^"]*)"/.exec(stdin) || [])[1] || '';
const info = 'altname: X\\ncreate_time:    Thu Nov 19 09:18:57 2026 UTC\\naccess_time:    Thu Nov 19 09:18:57 2026 UTC\\n'
  + 'write_time:     Thu Nov 19 09:18:57 2026 UTC\\nchange_time:    Thu Nov 19 09:18:57 2026 UTC\\nattributes:  (80)\\n';
const shadow = 'NT_STATUS_INVALID_DEVICE_REQUEST getting shadow copy data for ' + name + '\\n';
if (name.endsWith('plain')) process.stdout.write(info + 'stream: [::$DATA], 3 bytes\\n');
else if (name.endsWith('new')) { process.stdout.write(info + 'stream: [::$DATA], 73400443 bytes\\n'); process.stderr.write(shadow); }
else if (name.endsWith('missing')) process.stdout.write('NT_STATUS_OBJECT_NAME_NOT_FOUND getting alt name for ' + name + '\\n');
else if (name.endsWith('denied')) { process.stdout.write('NT_STATUS_ACCESS_DENIED getting alt name for ' + name + '\\n'); process.stderr.write(shadow); }
else if (name.endsWith('odd')) process.stdout.write(info + 'NT_STATUS_INVALID_DEVICE_REQUEST getting streams for ' + name + '\\n');
process.exit(0);
`, { mode: 0o755 });
process.env.GC_SMBCLIENT = shim;

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const smb = require('../src/services/storageTargets/drivers/smb');

after(() => fs.rmSync(shimRoot, { recursive: true, force: true }));

describe('SMB head() with the allinfo of smbclient 4.21+', () => {
  const target = () => smb.create({ host: '127.0.0.1', share: 'share', username: 'u', folder: 'gc' }, { password: 'p' });
  const mtime = Date.parse('Thu Nov 19 09:18:57 2026 UTC');

  it('as before: size and time', async () => {
    assert.deepEqual(await target().head('plain'), { size: 3, mtime });
  });

  it('"… getting shadow copy data" is no error: size and time', async () => {
    assert.deepEqual(await target().head('big/new'), { size: 73400443, mtime });
  });

  it('a missing file is still null', async () => {
    assert.equal(await target().head('missing'), null);
  });

  it('another NT_STATUS still fails, with the shadow copy line next to it as well', async () => {
    await assert.rejects(target().head('denied'), { code: 'denied' });
    await assert.rejects(target().head('odd'), { code: 'failed', message: 'NT_STATUS_INVALID_DEVICE_REQUEST' });
  });
});
