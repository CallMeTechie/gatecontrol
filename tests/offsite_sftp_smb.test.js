'use strict';

// SFTP / SMB transports (docs/feature-release-b.md §7) with shim binaries on
// PATH: what exactly is passed to `sftp` / `smbclient`, that secrets never
// reach argv or the child environment, that temporary key/auth files are 0600
// and gone afterwards, and the output parsers. (Real servers: see the release
// B report — tested once against throw-away openssh/samba containers.)

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-xfer-'));
const bin = path.join(root, 'bin');
const rec = path.join(root, 'rec');
fs.mkdirSync(bin);
fs.mkdirSync(rec);
process.env.GC_DATA_DIR = path.join(root, 'data');
delete process.env.GC_DATA_PATH;
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.GC_SECRET_CANARY = 'must-not-leak';

// One shim for both tools: records argv, env, stdin and the files it was
// pointed at (-i key / -A auth file incl. mode), then answers like the tool.
const SHIM = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const rec = ${JSON.stringify(rec)};
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
let stdin = ''; try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
const out = { tool, args, env: process.env, stdin, files: {} };
for (const flag of ['-i', '-A']) {
  const i = args.indexOf(flag);
  if (i !== -1) { const f = args[i + 1]; out.files[flag] = { mode: (fs.statSync(f).mode & 0o777).toString(8), content: fs.readFileSync(f, 'utf8') }; }
}
const n = fs.readdirSync(rec).length;
fs.writeFileSync(path.join(rec, String(n).padStart(3, '0') + '.json'), JSON.stringify(out));
const mode = fs.existsSync(path.join(rec, '..', 'fail')) ? fs.readFileSync(path.join(rec, '..', 'fail'), 'utf8') : '';
if (tool === 'sftp') {
  if (mode === 'denied') { process.stderr.write('backup@nas: Permission denied (publickey).\\r\\nConnection closed\\n'); process.exit(255); }
  process.stdout.write('sftp> ls -ln\\n-rw-r--r--    ? 1000     1000         7 Sep 14 03:00 gatecontrol-20260914-030000.gcbk\\ndrwxr-xr-x    ? 1000     1000      4096 Sep 14 03:00 sub\\n-rw-r--r--    ? 1000     1000         3 Sep 14 03:00 notes.txt\\n');
  process.exit(0);
}
if (tool === 'smbclient') {
  if (mode === 'logon') { process.stdout.write('session setup failed: NT_STATUS_LOGON_FAILURE\\n'); process.exit(1); }
  const cmd = args[args.indexOf('-c') + 1] || '';
  if (/(^|; )ls$/.test(cmd)) {
    process.stdout.write('  .                                   D        0  Mon Sep 14 03:00:00 2026\\n  ..                                  D        0  Mon Sep 14 03:00:00 2026\\n  gatecontrol-20260914-030000.gcbk      A     1234  Mon Sep 14 03:00:00 2026\\n  My Notes.txt                        A       12  Sun Sep 13 10:11:12 2026\\n  sub                                 D        0  Mon Sep 14 03:00:00 2026\\n\\n\\t\\t102400 blocks of size 1024. 1000 blocks available\\n');
  }
  process.exit(0);
}
`;
for (const t of ['sftp', 'smbclient']) {
  fs.writeFileSync(path.join(bin, t), SHIM, { mode: 0o755 });
}

const sftp = require('../src/services/offsite/sftp');
const smb = require('../src/services/offsite/smb');
const { generate } = require('../src/services/offsite/sshKey');

function records() {
  return fs.readdirSync(rec).sort().map((f) => JSON.parse(fs.readFileSync(path.join(rec, f), 'utf8')));
}
function reset(fail = '') {
  for (const f of fs.readdirSync(rec)) fs.unlinkSync(path.join(rec, f));
  const ff = path.join(root, 'fail');
  if (fail) fs.writeFileSync(ff, fail); else try { fs.unlinkSync(ff); } catch {}
}
function workFiles() {
  const d = path.join(process.env.GC_DATA_DIR, 'offsite');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n !== 'known_hosts') : [];
}

after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('SFTP', () => {
  const key = generate();
  const ctx = { privateKey: key.privateKey };
  const cfg = { host: 'nas.lan', port: 2222, username: 'backup', path: '/volume1/gc backups' };

  it('upload: key-only options, batch with mkdir chain, .part + rename; key file 0600 and removed', async () => {
    reset();
    await sftp.upload(cfg, 'gatecontrol-20260914-030000.gcbk', Buffer.from('archive'), ctx);
    const [r] = records();
    assert.equal(r.tool, 'sftp');
    const a = r.args;
    assert.deepEqual(a.slice(0, 2), ['-b', '-']);
    for (const opt of ['BatchMode=yes', 'IdentitiesOnly=yes', 'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no', 'StrictHostKeyChecking=accept-new', 'User=backup']) {
      assert.ok(a.includes(opt), opt);
    }
    assert.equal(a[a.indexOf('-P') + 1], '2222');
    assert.equal(a[a.indexOf('-F') + 1], '/dev/null');
    assert.deepEqual(a.slice(-2), ['--', 'nas.lan'], 'host after --');
    assert.equal(r.files['-i'].mode, '600');
    assert.equal(r.files['-i'].content, key.privateKey);
    const lines = r.stdin.trim().split('\n');
    assert.deepEqual(lines.slice(0, 3), ['-mkdir "/volume1"', '-mkdir "/volume1/gc backups"', 'cd "/volume1/gc backups"']);
    assert.match(lines[4], /^put "\/.+\/offsite\/upload-[0-9a-f]{16}" "gatecontrol-20260914-030000\.gcbk\.part"$/);
    assert.equal(lines[5], 'rename "gatecontrol-20260914-030000.gcbk.part" "gatecontrol-20260914-030000.gcbk"');
    assert.equal(r.env.GC_SECRET_CANARY, undefined, 'app environment not inherited');
    assert.equal(r.env.GC_ENCRYPTION_KEY, undefined);
    assert.deepEqual(workFiles(), [], 'key + upload temp files removed');
  });

  it('list parses `ls -ln` (files only)', async () => {
    reset();
    const files = await sftp.list(cfg, ctx);
    assert.deepEqual(files, [
      { name: 'gatecontrol-20260914-030000.gcbk', size: 7, modified: null },
      { name: 'notes.txt', size: 3, modified: null },
    ]);
  });

  it('IPv6 host is bracketed; relative path without leading slash', async () => {
    reset();
    await sftp.remove({ ...cfg, host: 'fd00::10', path: 'gc/a' }, 'x.gcbk', ctx);
    const [r] = records();
    assert.equal(r.args[r.args.length - 1], '[fd00::10]');
    assert.deepEqual(r.stdin.trim().split('\n'), ['-mkdir "gc"', '-mkdir "gc/a"', 'cd "gc/a"', 'rm "x.gcbk"']);
  });

  it('key rejected → readable hint, temp files still removed', async () => {
    reset('denied');
    await assert.rejects(sftp.test(cfg, ctx), (e) => e.code === 'TRANSPORT' && /authorized_keys/.test(e.message));
    assert.deepEqual(workFiles(), []);
  });

  it('no key → clear error without spawning', async () => {
    reset();
    await assert.rejects(sftp.list(cfg, {}), /no GateControl SSH key/);
    assert.equal(records().length, 0);
  });
});

describe('SMB', () => {
  const cfg = { host: 'nas.lan', port: 445, share: 'backup', path: 'gc/host1', username: 'bob', password: 'p@ss; "word"', domain: 'WORKGROUP' };

  it('password only in a 0600 auth file (removed afterwards), never in argv/env', async () => {
    reset();
    await smb.upload(cfg, 'gatecontrol-20260914-030000.gcbk', Buffer.from('archive'));
    const recs = records();
    assert.equal(recs.length, 3, 'mkdir gc, mkdir gc/host1, upload');
    for (const r of recs) {
      assert.equal(r.args[0], '//nas.lan/backup');
      assert.ok(!JSON.stringify(r.args).includes('p@ss'), 'no password in argv');
      assert.ok(!r.args.includes('-U'));
      assert.equal(r.files['-A'].mode, '600');
      assert.equal(r.files['-A'].content, 'username = bob\npassword = p@ss; "word"\ndomain = WORKGROUP\n');
      assert.equal(r.args[r.args.indexOf('-p') + 1], '445');
      assert.equal(r.env.GC_SECRET_CANARY, undefined);
    }
    assert.equal(recs[0].args[recs[0].args.indexOf('-c') + 1], 'mkdir "gc"');
    assert.equal(recs[1].args[recs[1].args.indexOf('-c') + 1], 'mkdir "gc/host1"');
    assert.match(recs[2].args[recs[2].args.indexOf('-c') + 1],
      /^cd "gc\/host1"; put "\/.+\/offsite\/upload-[0-9a-f]{16}" "gatecontrol-20260914-030000\.gcbk\.part"; rename "gatecontrol-20260914-030000\.gcbk\.part" "gatecontrol-20260914-030000\.gcbk"$/);
    assert.deepEqual(workFiles(), []);
  });

  it('list parses smbclient `ls` (no dirs, names with spaces, dates)', async () => {
    reset();
    const files = await smb.list(cfg);
    assert.deepEqual(files.map((f) => [f.name, f.size]), [['gatecontrol-20260914-030000.gcbk', 1234], ['My Notes.txt', 12]]);
    assert.ok(files[0].modified && files[0].modified.startsWith('2026-09-14'));
  });

  it('guest (no username) uses -N', async () => {
    reset();
    await smb.remove({ ...cfg, username: '', password: '' }, 'x.gcbk');
    const [r] = records();
    assert.ok(r.args.includes('-N'));
  });

  it('logon failure → readable message', async () => {
    reset('logon');
    await assert.rejects(smb.list(cfg), (e) => e.code === 'TRANSPORT' && e.message === 'SMB: wrong username or password');
    assert.deepEqual(workFiles(), []);
  });
});

describe('missing binary', () => {
  it('reports "not installed in this image"', async () => {
    const { run } = require('../src/services/offsite/proc');
    await assert.rejects(run('definitely-not-a-binary-gc', []), /not installed in this image/);
  });
});
