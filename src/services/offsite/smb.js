'use strict';

// SMB transport via `smbclient` (Alpine samba-client): Windows shares, Samba,
// Synology/QNAP/Fritz!Box NAS. docs/feature-release-b.md §7.
//
// Config: { host, port?, share, path, username, password, domain?, via?, encrypt? }
// `encrypt` ("Verbindung verschlüsseln (SMB3)", on for new targets): SMB3
// encryption required (--client-protection=encrypt, as the storage
// targets' SMB driver); a share that cannot encrypt fails with a clear
// message (NO_ENCRYPTION_TEXT, the page shows its own words for it).
// `via` (storageTargets/via.js, as a storage target's "Verbindung"): through
// a VPN peer (its VPN address, `via.port`) or an L4 route (what Caddy dials
// for it) — smbclient then connects to that address (-I, -p) while the
// share is still named after `host` (or the address, when no host is set).
// Credentials go through a temporary authentication file (-A, mode 0600,
// deleted afterwards) — never on the command line, where every process on
// the host could read them from /proc.

const { run, writeTemp, writeTempAsync, rmQuiet } = require('./proc');
const via = require('../storageTargets/via');
const { encryptArgs, noEncryption } = require('../storageTargets/drivers/smb');

// English, for logs, last_error and API callers; the page has its own text (hint 'smb_no_encryption')
const NO_ENCRYPTION_TEXT = 'SMB: the share cannot encrypt the connection (SMB3) — switch on SMB3 encryption on the NAS, or switch off "encrypt connection"';

const TIMEOUT_MS = 180 * 1000;

function q(s) { return `"${s}"`; } // path charset is validated (no quotes/semicolons/backslashes)

function authFile(cfg) {
  const lines = [`username = ${cfg.username || ''}`, `password = ${cfg.password || ''}`];
  if (cfg.domain) lines.push(`domain = ${cfg.domain}`);
  return writeTemp('smbauth', lines.join('\n') + '\n');
}

/** `dial`: { address, port } of a `via` (dialOf), null for the host itself. */
function baseArgs(cfg, auth, dial = null) {
  const args = [`//${cfg.host || (dial && dial.address)}/${cfg.share}`, '-A', auth];
  if (dial) args.push('-I', dial.address);
  args.push('-p', String(dial ? dial.port : (cfg.port || 445)), ...encryptArgs(cfg.encrypt === true), '-t', '60');
  if (!cfg.username) args.push('-N');
  return args;
}

async function dialOf(cfg) {
  try { return await via.tcpAddress(cfg.via, { host: cfg.host, port: cfg.port || 445 }); } catch (err) {
    const e = new Error(`SMB: ${err.message}`);
    e.code = 'TRANSPORT';
    throw e;
  }
}

/**
 * A refused / unanswered connection to an address of this server itself →
 * hint (via.selfHint); a share that cannot encrypt → hint 'smb_no_encryption'.
 */
async function failure(cfg, message) {
  const e = new Error(message);
  e.code = 'TRANSPORT';
  if (message === NO_ENCRYPTION_TEXT) { e.hint = 'smb_no_encryption'; return e; }
  const hint = await via.selfHint(e, cfg.via, cfg.host);
  if (hint) { e.hint = hint; e.message += ` (${via.SELF_HINT_TEXT})`; }
  return e;
}

function explain(res, encrypt = false) {
  const out = `${res.stdout || ''}\n${res.stderr || ''}`;
  if (res.timedOut) return 'SMB timed out';
  if (noEncryption(out, encrypt)) return NO_ENCRYPTION_TEXT;
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
  const dial = await dialOf(cfg);
  const auth = authFile(cfg);
  try {
    const res = await run('smbclient', [...baseArgs(cfg, auth, dial), '-c', commands.join('; ')], { timeoutMs });
    const failed = res.code !== 0 || res.timedOut
      || (!tolerate && /NT_STATUS_(?!OK\b)[A-Z_]+/.test(`${res.stdout}\n${res.stderr}`));
    if (failed && !tolerate) throw await failure(cfg, explain(res, cfg.encrypt === true));
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
  const local = await writeTempAsync('upload', buf);
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

/** Read one file back (restore test) into a Buffer; nothing on the share changes. */
async function download(cfg, name) {
  const local = writeTemp('download', '');
  try {
    await smb(cfg, [...cd(cfg), `get ${q(name)} ${q(local)}`]);
    return await require('node:fs').promises.readFile(local);
  } finally {
    rmQuiet(local);
  }
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

module.exports = { upload, download, list, remove, test, parseLs, baseArgs, explain, NO_ENCRYPTION_TEXT };
