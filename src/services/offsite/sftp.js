'use strict';

// SFTP transport via the OpenSSH `sftp` client (Alpine openssh-client-default),
// key authentication only with the GateControl-generated ed25519 key.
// docs/feature-release-b.md §7.
//
// Config: { host, port, username, path, via? }
// `via` (storageTargets/via.js, as a storage target's "Verbindung"): through
// a VPN peer (its VPN address, `via.port`) or an L4 route (what Caddy dials
// for it) — sftp then connects to that address; the host key is stored for it.
// Host keys: trust on first use (StrictHostKeyChecking=accept-new) into
// <dataDir>/offsite/known_hosts; a changed key fails with a clear message and
// is reset when the target's host/port changes or the target is deleted.
// Uploads go to "<name>.part" and are renamed afterwards, so an interrupted
// upload never counts as a backup for the retention. The archive goes up from
// its file (source.js): `put` streams it — nothing of it passes through
// GateControl's memory; the time limit grows with its size.

const fs = require('node:fs');
const { run, writeTemp, writeTempAsync, rmQuiet, workDir } = require('./proc');
const path = require('node:path');
const via = require('../storageTargets/via');
const { sourceOf, localPath, transferTimeout, TooLarge } = require('./source');

const TIMEOUT_MS = 180 * 1000;

function knownHostsFile() { return path.join(workDir(), 'known_hosts'); }

function destination(host) { return host.includes(':') ? `[${host}]` : host; }

/** `dial`: { address, port } of a `via` (dialOf), null for the host itself. */
function sshOptions(cfg, keyFile, dial = null) {
  return [
    '-F', '/dev/null',
    '-i', keyFile,
    '-P', String(dial ? dial.port : (cfg.port || 22)),
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${knownHostsFile()}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'LogLevel=ERROR',
    '-o', `User=${cfg.username}`,
  ];
}

function q(s) { return `"${s}"`; } // path charset is validated (no quotes/backslashes/newlines)

/** "-mkdir a", "-mkdir a/b", … then "cd a/b" (absolute paths keep their '/'). */
function cdScript(p) {
  const clean = String(p || '').replace(/\/+$/, '');
  if (!clean || clean === '.') return [];
  const abs = clean.startsWith('/');
  const parts = clean.split('/').filter(Boolean);
  const lines = [];
  let cur = '';
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : (abs ? `/${part}` : part);
    lines.push(`-mkdir ${q(cur)}`);
  }
  lines.push(`cd ${q(clean)}`);
  return lines;
}

function explain(res) {
  const err = (res.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const text = err.join(' ');
  if (res.timedOut) return 'SFTP timed out';
  if (/Permission denied \(publickey/.test(text)) return 'SFTP: key rejected — add the GateControl public key to ~/.ssh/authorized_keys of this user';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) return 'SFTP: the server\'s host key changed — if that is expected, save the target again to reset the stored key';
  if (/Connection refused/i.test(text)) return 'SFTP: connection refused';
  if (/timed out/i.test(text)) return 'SFTP: connection timed out';
  if (/Could not resolve hostname/i.test(text)) return 'SFTP: host name not found';
  // Batch mode stops at the failing command → its message is the last line
  // (earlier lines can stem from ignored "-mkdir"/"-rm" commands).
  const last = err.filter((l) => !/^sftp>/.test(l)).slice(-1).join(' ').slice(0, 300);
  return `SFTP failed${res.code != null ? ` (exit ${res.code})` : ''}${last ? `: ${last}` : ''}`;
}

async function dialOf(cfg) {
  try { return await via.tcpAddress(cfg.via, { host: cfg.host, port: cfg.port || 22 }); } catch (err) {
    const e = new Error(`SFTP: ${err.message}`);
    e.code = 'TRANSPORT';
    throw e;
  }
}

async function batch(cfg, ctx, lines, timeoutMs = TIMEOUT_MS) {
  if (!ctx || !ctx.privateKey) {
    const e = new Error('SFTP: no GateControl SSH key');
    e.code = 'TRANSPORT';
    throw e;
  }
  const dial = await dialOf(cfg);
  const keyFile = writeTemp('id_ed25519', ctx.privateKey);
  try {
    const args = ['-b', '-', ...sshOptions(cfg, keyFile, dial), '--', destination(dial ? dial.address : cfg.host)];
    const res = await run('sftp', args, { input: lines.join('\n') + '\n', timeoutMs });
    if (res.code !== 0 || res.timedOut) {
      const e = new Error(explain(res));
      e.code = 'TRANSPORT';
      const hint = await via.selfHint(e, cfg.via, cfg.host);
      if (hint) { e.hint = hint; e.message += ` (${via.SELF_HINT_TEXT})`; }
      throw e;
    }
    return res.stdout;
  } finally {
    rmQuiet(keyFile);
  }
}

/** Parse `ls -ln` output (regular files only). */
function parseLs(out) {
  const files = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('sftp>') || !line.startsWith('-')) continue;
    const f = line.split(/\s+/);
    if (f.length < 9) continue;
    const name = f.slice(8).join(' ');
    files.push({ name: path.posix.basename(name), size: Number(f[4]) || 0, modified: null });
  }
  return files;
}

/** Upload the archive (source.js: its file as it is, a Buffer through a temp file) as "<name>.part", then rename. */
async function upload(cfg, name, body, ctx) {
  const src = sourceOf(body);
  const local = src.path ? localPath(src.path, 'SFTP') : await writeTempAsync('upload', src.buffer);
  try {
    await batch(cfg, ctx, [
      ...cdScript(cfg.path),
      `-rm ${q(name + '.part')}`,
      `put ${q(local)} ${q(name + '.part')}`,
      `rename ${q(name + '.part')} ${q(name)}`,
    ], transferTimeout(TIMEOUT_MS, src.size));
  } finally {
    if (!src.path) rmQuiet(local);
  }
}

async function list(cfg, ctx) {
  const out = await batch(cfg, ctx, [...cdScript(cfg.path), 'ls -ln'], 60000);
  return parseLs(out);
}

/**
 * Read one file back (restore test) into the local `file` (created here,
 * 0600; sftp writes it in chunks); the remote side is read-only here.
 * `size`: what the listing said (the time limit). → bytes. On an error the
 * caller removes `file`.
 */
async function downloadTo(cfg, name, file, ctx, { maxBytes = Infinity, size = 0 } = {}) {
  const local = localPath(file, 'SFTP');
  await fs.promises.writeFile(local, '', { flag: 'wx', mode: 0o600 });
  await batch(cfg, ctx, [...cdScript(cfg.path), `get ${q(name)} ${q(local)}`], transferTimeout(TIMEOUT_MS, size));
  const bytes = (await fs.promises.stat(local)).size;
  if (bytes > maxBytes) throw new TooLarge(maxBytes);
  return bytes;
}

async function remove(cfg, name, ctx) {
  await batch(cfg, ctx, [...cdScript(cfg.path), `rm ${q(name)}`], 60000);
}

async function test(cfg, ctx) {
  const probe = `.gatecontrol-write-test-${Date.now().toString(36)}`;
  const local = writeTemp('probe', 'ok\n');
  try {
    const out = await batch(cfg, ctx, [
      ...cdScript(cfg.path),
      `put ${q(local)} ${q(probe)}`,
      `rm ${q(probe)}`,
      'ls -ln',
    ], 60000);
    return `connected, write + delete ok (${parseLs(out).length} file(s) in the folder)`;
  } finally {
    rmQuiet(local);
  }
}

/** Forget the stored host key of host:port (target edited/deleted). */
async function forgetHost(cfg) {
  if (!cfg) return;
  let host = cfg.host;
  let port = Number(cfg.port || 22);
  if (cfg.via && cfg.via.kind && cfg.via.kind !== 'host') {
    // the address the key was stored for (peer or route as they are now; gone → nothing to find)
    try { const d = await via.tcpAddress(cfg.via, { host: cfg.host, port }); host = d.address; port = d.port; } catch { return; }
  }
  if (!host) return;
  const name = port === 22 ? host : `[${host}]:${port}`;
  try {
    await run('ssh-keygen', ['-R', name, '-f', knownHostsFile()], { timeoutMs: 10000 });
    rmQuiet(knownHostsFile() + '.old');
  } catch { /* no ssh-keygen / no file — nothing to forget */ }
}

module.exports = { upload, downloadTo, list, remove, test, forgetHost, parseLs, cdScript, sshOptions };
