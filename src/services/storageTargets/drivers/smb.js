'use strict';

// Storage target "NAS über SMB" (kind 'smb'): any Windows share or NAS
// (SMB 2/3), through the `smbclient` of the image (samba-client). One
// smbclient process per operation; its commands go in on stdin (one per
// line — `-c` would split file names at ";"), the file data through a FIFO
// in a private temporary folder (smbclient `put <fifo> …` / `get … <fifo>`),
// so nothing is held in memory or written to the server's disk. The
// password goes into an authentication file (0600) in that folder, never
// onto a command line.
//
// SMB has no ranged read in smbclient: `ranges: false`, a read fetches the
// whole file (the media store keeps a local copy).
//
// config: { host, port, share, folder, username, domain } + dial { address, port } (index.js)
// secret: { password }

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { StorageError } = require('../errors');
const { slice } = require('../streams');

const BIN = process.env.GC_SMBCLIENT || 'smbclient';
const OP_TIMEOUT_MS = 60 * 1000;

// SMB file names: no " < > | ? * : \ and no control characters
const BAD_SEG_RE = /["<>|?*:\\\u0000-\u001f]/;

function mkfifo(p) {
  return new Promise((resolve, reject) => {
    execFile('mkfifo', ['-m', '600', p], (err) => (err ? reject(new StorageError('failed', 'mkfifo: ' + err.message)) : resolve()));
  });
}

/** An NT_STATUS line of smbclient's output → StorageError code. */
function codeOf(status) {
  if (/LOGON_FAILURE|WRONG_PASSWORD|ACCOUNT_(?:DISABLED|LOCKED_OUT|RESTRICTION|EXPIRED)|PASSWORD_(?:EXPIRED|MUST_CHANGE)|NO_SUCH_USER/.test(status)) return 'auth';
  if (/ACCESS_DENIED|MEDIA_WRITE_PROTECTED|SHARING_VIOLATION/.test(status)) return 'denied';
  if (/BAD_NETWORK_NAME|OBJECT_NAME_NOT_FOUND|OBJECT_PATH_NOT_FOUND|NO_SUCH_FILE|NOT_A_DIRECTORY|OBJECT_NAME_INVALID/.test(status)) return 'not_found';
  if (/DISK_FULL|QUOTA_EXCEEDED/.test(status)) return 'full';
  if (/CONNECTION_REFUSED|HOST_UNREACHABLE|NETWORK_UNREACHABLE|IO_TIMEOUT|CONNECTION_(?:RESET|DISCONNECTED)|PORT_UNREACHABLE/.test(status)) return 'unreachable';
  return 'failed';
}

function create(cfg, secret) {
  const dial = cfg.dial || { address: cfg.host, port: cfg.port || 445 };
  const root = String(cfg.folder || '').split('/').filter(Boolean);

  function smbPath(key) {
    const segs = root.concat(String(key).split('/').filter(Boolean));
    for (const s of segs) if (BAD_SEG_RE.test(s)) throw new StorageError('failed', 'a name SMB does not allow');
    return segs.join('\\');
  }

  function q(s) { return `"${s}"`; }

  /**
   * Run smbclient with `commands` (one per line). opts.feed(fifo) / opts.drain(fifo):
   * the data side of a put / get. → { out } (stdout + stderr) or throws StorageError.
   * `allow`: NT_STATUS codes that are no error for this run (a folder that exists).
   */
  async function run(commands, { feed = null, drain = null, allow = [], long = false } = {}) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gc-smb-'));
    const authFile = path.join(dir, 'auth');
    const fifo = path.join(dir, 'data');
    let child = null;
    try {
      const lines = [`username=${cfg.username || ''}`, `password=${secret.password || ''}`];
      if (cfg.domain) lines.push(`domain=${cfg.domain}`);
      await fs.promises.writeFile(authFile, lines.join('\n') + '\n', { mode: 0o600 });
      if (feed || drain) await mkfifo(fifo);
      const args = [`//${dial.address}/${cfg.share}`, '-p', String(dial.port || 445), '-A', authFile,
        '--option=client min protocol=SMB2', '-t', '60'];
      const out = [];
      child = spawn(BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.on('data', (d) => { if (out.length < 400) out.push(d); });
      child.stderr.on('data', (d) => { if (out.length < 400) out.push(d); });
      const exited = new Promise((resolve) => {
        child.on('error', (e) => resolve({ code: -1, err: e }));
        child.on('close', (code) => resolve({ code }));
      });
      const script = commands.map((c) => c.replace(/\$FIFO/g, fifo)).join('\n') + '\nexit\n';
      child.stdin.end(script);
      // the data side: blocks until smbclient opens the FIFO — or until it exits without doing so
      let side = null;
      if (feed) side = feed(fifo);
      else if (drain) side = drain(fifo);
      const timer = long ? null : setTimeout(() => child.kill('SIGKILL'), OP_TIMEOUT_MS);
      const res = await exited;
      if (timer) clearTimeout(timer);
      if (side) await unblock(fifo, feed ? 'reader' : 'writer', side);
      if (res.err) throw new StorageError('failed', res.err.code === 'ENOENT' ? 'smbclient is not installed' : res.err.message);
      const text = Buffer.concat(out).toString('utf8');
      const statuses = text.match(/NT_STATUS_[A-Z_]+/g) || [];
      const bad = statuses.find((s) => !allow.includes(s));
      if (bad) throw new StorageError(codeOf(bad), `${bad}`);
      if (res.code !== 0) throw new StorageError('failed', `smbclient exited with ${res.code}`);
      return { out: text, side: side ? await side : null };
    } finally {
      if (child && child.exitCode == null) child.kill('SIGKILL');
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * smbclient is gone; when it never opened the FIFO our side still waits in
   * open(): open the other end ourselves (non-blocking) so it returns, then
   * let `side` settle (with an error that the caller ignores).
   */
  async function unblock(fifo, needed, side) {
    let settled = false;
    side.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setImmediate(r));
    if (settled) return;
    try {
      const flags = needed === 'reader' ? fs.constants.O_RDONLY | fs.constants.O_NONBLOCK : fs.constants.O_WRONLY | fs.constants.O_NONBLOCK;
      const fd = fs.openSync(fifo, flags);
      fs.closeSync(fd);
    } catch { /* the other side is open already */ }
    await side.catch(() => null);
  }

  /** mkdir commands for every folder of `p` (a\b\c → a, a\b), collisions allowed. */
  function mkdirs(p) {
    const segs = p.split('\\').slice(0, -1);
    const cmds = [];
    for (let i = 1; i <= segs.length; i++) cmds.push(`mkdir ${q(segs.slice(0, i).join('\\'))}`);
    return cmds;
  }

  async function put(key, source) {
    const p = smbPath(key);
    let written = 0;
    const feed = (fifo) => new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(fifo);
      const rs = source.open(0, source.length - 1);
      rs.on('data', (c) => { written += c.length; });
      rs.on('error', (e) => { ws.destroy(); reject(e); });
      ws.on('error', (e) => { rs.destroy(); reject(e); });
      ws.on('finish', resolve);
      rs.pipe(ws);
    });
    try {
      await run(mkdirs(p).concat([`put $FIFO ${q(p)}`]), { feed, allow: ['NT_STATUS_OBJECT_NAME_COLLISION'], long: true });
    } catch (e) {
      try { await run([`del ${q(p)}`], { allow: ['NT_STATUS_NO_SUCH_FILE', 'NT_STATUS_OBJECT_NAME_NOT_FOUND'] }); } catch { /* best effort */ }
      throw e;
    }
    if (written !== source.length) {
      try { await run([`del ${q(p)}`]); } catch { /* best effort */ }
      throw new StorageError('length_mismatch', 'not all bytes were sent');
    }
  }

  async function get(key, range) {
    const p = smbPath(key);
    const { PassThrough } = require('node:stream');
    const pass = new PassThrough();
    const drain = (fifo) => new Promise((resolve, reject) => {
      const rs = fs.createReadStream(fifo);
      rs.on('error', reject);
      rs.on('end', resolve);
      // the reader stopped early (a range, a closed connection): close the FIFO so smbclient ends too
      pass.on('close', () => { if (!rs.readableEnded) { rs.destroy(); resolve(); } });
      rs.pipe(pass, { end: false });
    });
    run([`get ${q(p)} $FIFO`], { drain, long: true })
      .then(() => pass.end(), (e) => pass.destroy(e));
    return range ? slice(pass, range.start, range.end) : pass;
  }

  async function head(key) {
    const p = smbPath(key);
    let r;
    try { r = await run([`allinfo ${q(p)}`]); } catch (e) {
      if (e.code === 'not_found') return null;
      throw e;
    }
    const size = /stream: \[::\$DATA\], (\d+) bytes/.exec(r.out);
    const wt = /write_time:\s+(.+)/.exec(r.out);
    if (!size) return null;
    return { size: Number(size[1]), mtime: wt ? Date.parse(wt[1].trim()) || null : null };
  }

  async function remove(key) {
    const p = smbPath(key);
    try { await run([`del ${q(p)}`]); return true; } catch (e) {
      if (e.code === 'not_found') return false;
      throw e;
    }
  }

  async function move(from, to) {
    const a = smbPath(from);
    const b = smbPath(to);
    const dirs = mkdirs(b);
    if (dirs.length) await run(dirs, { allow: ['NT_STATUS_OBJECT_NAME_COLLISION'] });
    // a collision of the rename itself is an error (the target exists)
    await run([`rename ${q(a)} ${q(b)}`]);
  }

  async function space() {
    try {
      const r = await run(['du']);
      const m = /(\d+) blocks of size (\d+)\. (\d+) blocks available/.exec(r.out);
      if (!m) return { free: null, total: null };
      return { free: Number(m[3]) * Number(m[2]), total: Number(m[1]) * Number(m[2]) };
    } catch { return { free: null, total: null }; }
  }

  async function prepare() {
    const dirs = [];
    for (let i = 1; i <= root.length; i++) dirs.push(`mkdir ${q(root.slice(0, i).join('\\'))}`);
    await run(dirs.length ? dirs : ['ls'], { allow: ['NT_STATUS_OBJECT_NAME_COLLISION'] });
  }

  return { kind: 'smb', ranges: false, put, get, head, remove, move, space, prepare };
}

module.exports = { create, codeOf };
