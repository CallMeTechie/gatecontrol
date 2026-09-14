'use strict';

// SFTP transport via the OpenSSH `sftp` client (Alpine openssh-client-default),
// key authentication only with the GateControl-generated ed25519 key.
// docs/feature-release-b.md §7.
//
// Config: { host, port, username, path }
// Host keys: trust on first use (StrictHostKeyChecking=accept-new) into
// <dataDir>/offsite/known_hosts; a changed key fails with a clear message and
// is reset when the target's host/port changes or the target is deleted.
// Uploads go to "<name>.part" and are renamed afterwards, so an interrupted
// upload never counts as a backup for the retention.

const { run, writeTemp, rmQuiet, workDir } = require('./proc');
const path = require('node:path');

const TIMEOUT_MS = 180 * 1000;

function knownHostsFile() { return path.join(workDir(), 'known_hosts'); }

function destination(host) { return host.includes(':') ? `[${host}]` : host; }

function sshOptions(cfg, keyFile) {
  return [
    '-F', '/dev/null',
    '-i', keyFile,
    '-P', String(cfg.port || 22),
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

async function batch(cfg, ctx, lines, timeoutMs = TIMEOUT_MS) {
  if (!ctx || !ctx.privateKey) {
    const e = new Error('SFTP: no GateControl SSH key');
    e.code = 'TRANSPORT';
    throw e;
  }
  const keyFile = writeTemp('id_ed25519', ctx.privateKey);
  try {
    const args = ['-b', '-', ...sshOptions(cfg, keyFile), '--', destination(cfg.host)];
    const res = await run('sftp', args, { input: lines.join('\n') + '\n', timeoutMs });
    if (res.code !== 0 || res.timedOut) {
      const e = new Error(explain(res));
      e.code = 'TRANSPORT';
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

async function upload(cfg, name, buf, ctx) {
  const local = writeTemp('upload', buf);
  try {
    await batch(cfg, ctx, [
      ...cdScript(cfg.path),
      `-rm ${q(name + '.part')}`,
      `put ${q(local)} ${q(name + '.part')}`,
      `rename ${q(name + '.part')} ${q(name)}`,
    ]);
  } finally {
    rmQuiet(local);
  }
}

async function list(cfg, ctx) {
  const out = await batch(cfg, ctx, [...cdScript(cfg.path), 'ls -ln'], 60000);
  return parseLs(out);
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
  if (!cfg || !cfg.host) return;
  const port = Number(cfg.port || 22);
  const name = port === 22 ? cfg.host : `[${cfg.host}]:${port}`;
  try {
    await run('ssh-keygen', ['-R', name, '-f', knownHostsFile()], { timeoutMs: 10000 });
    rmQuiet(knownHostsFile() + '.old');
  } catch { /* no ssh-keygen / no file — nothing to forget */ }
}

module.exports = { upload, list, remove, test, forgetHost, parseLs, cdScript, sshOptions };
