'use strict';

// SMB transport via `smbclient` (Alpine samba-client): Windows shares, Samba,
// Synology/QNAP/Fritz!Box NAS. docs/feature-release-b.md §7.
//
// Config: { host, port?, share, path, username, password, domain? }
// Credentials go through a temporary authentication file (-A, mode 0600,
// deleted afterwards) — never on the command line, where every process on
// the host could read them from /proc.

const { run, writeTemp, rmQuiet } = require('./proc');

const TIMEOUT_MS = 180 * 1000;

function q(s) { return `"${s}"`; } // path charset is validated (no quotes/semicolons/backslashes)

function authFile(cfg) {
  const lines = [`username = ${cfg.username || ''}`, `password = ${cfg.password || ''}`];
  if (cfg.domain) lines.push(`domain = ${cfg.domain}`);
  return writeTemp('smbauth', lines.join('\n') + '\n');
}

function baseArgs(cfg, auth) {
  const args = [`//${cfg.host}/${cfg.share}`, '-A', auth, '-p', String(cfg.port || 445), '-t', '60'];
  if (!cfg.username) args.push('-N');
  return args;
}

function explain(res) {
  const out = `${res.stdout || ''}\n${res.stderr || ''}`;
  if (res.timedOut) return 'SMB timed out';
  const st = /NT_STATUS_[A-Z_]+/.exec(out);
  const hints = {
    NT_STATUS_LOGON_FAILURE: 'wrong username or password',
    NT_STATUS_ACCESS_DENIED: 'access denied',
    NT_STATUS_BAD_NETWORK_NAME: 'share not found',
    NT_STATUS_CONNECTION_REFUSED: 'connection refused',
    NT_STATUS_IO_TIMEOUT: 'connection timed out',
    NT_STATUS_HOST_UNREACHABLE: 'host unreachable',
    NT_STATUS_OBJECT_PATH_NOT_FOUND: 'folder not found',
    NT_STATUS_OBJECT_NAME_NOT_FOUND: 'folder or file not found',
  };
  if (st) return `SMB: ${hints[st[0]] || st[0]}`;
  const last = out.split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' ').slice(0, 300);
  return `SMB failed${res.code != null ? ` (exit ${res.code})` : ''}${last ? `: ${last}` : ''}`;
}

async function smb(cfg, commands, { timeoutMs = TIMEOUT_MS, tolerate = false } = {}) {
  const auth = authFile(cfg);
  try {
    const res = await run('smbclient', [...baseArgs(cfg, auth), '-c', commands.join('; ')], { timeoutMs });
    const failed = res.code !== 0 || res.timedOut
      || (!tolerate && /NT_STATUS_(?!OK\b)[A-Z_]+/.test(`${res.stdout}\n${res.stderr}`));
    if (failed && !tolerate) {
      const e = new Error(explain(res));
      e.code = 'TRANSPORT';
      throw e;
    }
    return res;
  } finally {
    rmQuiet(auth);
  }
}

function segments(p) {
  return String(p || '').split('/').filter((s) => s && s !== '.');
}

/** Create the folder chain; "already exists" is fine (separate call per level). */
async function ensurePath(cfg) {
  const segs = segments(cfg.path);
  let cur = '';
  for (const s of segs) {
    cur = cur ? `${cur}/${s}` : s;
    await smb(cfg, [`mkdir ${q(cur)}`], { timeoutMs: 30000, tolerate: true });
  }
}

function cd(cfg) {
  const segs = segments(cfg.path);
  return segs.length ? [`cd ${q(segs.join('/'))}`] : [];
}

/** Parse `ls` output: "  name   A   12345  Mon Sep 14 03:00:00 2026". */
function parseLs(out) {
  const files = [];
  const re = /^\s{2}(.+?)\s+([A-Z]{0,8})\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s*$/;
  for (const line of String(out).split('\n')) {
    const m = re.exec(line);
    if (!m || m[2].includes('D')) continue;
    const name = m[1].trim();
    if (name === '.' || name === '..') continue;
    const t = Date.parse(m[4]);
    files.push({ name, size: Number(m[3]) || 0, modified: Number.isFinite(t) ? new Date(t).toISOString() : null });
  }
  return files;
}

async function upload(cfg, name, buf) {
  const local = writeTemp('upload', buf);
  try {
    await ensurePath(cfg);
    await smb(cfg, [...cd(cfg), `put ${q(local)} ${q(name + '.part')}`, `rename ${q(name + '.part')} ${q(name)}`]);
  } finally {
    rmQuiet(local);
  }
}

async function list(cfg) {
  const res = await smb(cfg, [...cd(cfg), 'ls'], { timeoutMs: 60000 });
  return parseLs(res.stdout);
}

async function remove(cfg, name) {
  await smb(cfg, [...cd(cfg), `del ${q(name)}`], { timeoutMs: 60000 });
}

async function test(cfg) {
  const probe = `.gatecontrol-write-test-${Date.now().toString(36)}`;
  const local = writeTemp('probe', 'ok\n');
  try {
    await ensurePath(cfg);
    await smb(cfg, [...cd(cfg), `put ${q(local)} ${q(probe)}`, `del ${q(probe)}`], { timeoutMs: 60000 });
    const files = await list(cfg);
    return `connected, write + delete ok (${files.length} file(s) in the folder)`;
  } finally {
    rmQuiet(local);
  }
}

module.exports = { upload, list, remove, test, parseLs, baseArgs };
