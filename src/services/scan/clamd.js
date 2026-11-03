'use strict';

// clamd over TCP (the "z" commands, NUL-terminated):
//   zPING        → PONG
//   zVERSION     → "ClamAV 1.4.3/27812/Mon Nov  3 06:14:00 2026"
//   zRELOAD      → RELOADING (clamd reloads the signature database freshclam
//                  has put on disk — what "Signaturen jetzt aktualisieren" does)
//   zINSTREAM    → chunks <uint32 BE length><bytes>, a zero length ends;
//                  "stream: OK" | "stream: <signature> FOUND" |
//                  "INSTREAM size limit exceeded. ERROR"
// The file is streamed chunk by chunk with back-pressure; never buffered.
//
// Latest published versions: the DNS TXT record current.cvd.clamav.net
// (what freshclam asks): "<engine>:<main>:<daily>:<time>:…:<bytecode>" — no
// new dependency, no HTTP.

const dns = require('node:dns');
const N = require('./net');

const CHUNK = 64 * 1024;

async function command(addr, cmd, { timeoutMs = 5000 } = {}) {
  const sock = await N.connect(addr, { timeoutMs });
  try {
    await N.write(sock, Buffer.from(`z${cmd}\0`));
    const reply = await N.readReply(sock, { timeoutMs, done: (b) => b.includes(0) });
    return reply.toString('utf8').replace(/\0.*$/s, '').trim();
  } finally { sock.destroy(); }
}

async function ping(addr) { return (await command(addr, 'PING')) === 'PONG'; }

/** → { engine, daily, dailyAt } (dailyAt ISO or null). */
async function version(addr) {
  return parseVersion(await command(addr, 'VERSION'));
}

function parseVersion(text) {
  const m = /^ClamAV ([0-9][\w.-]*)(?:\/(\d+)\/(.+))?$/.exec(String(text || '').trim());
  if (!m) return { engine: null, daily: null, dailyAt: null, raw: String(text || '').slice(0, 100) };
  let at = null;
  if (m[3]) { const d = new Date(m[3].replace(/\s+/g, ' ') + ' UTC'); at = Number.isNaN(d.getTime()) ? null : d.toISOString(); }
  return { engine: m[1], daily: m[2] ? Number(m[2]) : null, dailyAt: at };
}

async function reload(addr) { return command(addr, 'RELOAD', { timeoutMs: 10000 }); }

/**
 * Stream `source` (async iterable of Buffers) to clamd.
 * → { verdict: 'clean' | 'infected' | 'unscannable', finding?, reason? }
 */
async function scan(addr, source, { timeoutMs = 120000 } = {}) {
  const sock = await N.connect(addr, { timeoutMs: 5000 });
  const reply = N.readReply(sock, { timeoutMs, done: (b) => b.includes(0) });
  reply.catch(() => {});
  try {
    await N.write(sock, Buffer.from('zINSTREAM\0'));
    for await (const part of source) {
      for (let o = 0; o < part.length; o += CHUNK) {
        const piece = part.subarray(o, o + CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(piece.length, 0);
        await N.write(sock, Buffer.concat([len, piece]));
      }
    }
    await N.write(sock, Buffer.alloc(4));
    const text = (await reply).toString('utf8').replace(/\0.*$/s, '').trim();
    return parseResult(text);
  } catch (e) {
    // clamd closes the stream when its limit is hit — its answer says so
    const text = await reply.then((b) => b.toString('utf8').replace(/\0.*$/s, '').trim()).catch(() => '');
    if (/size limit/i.test(text)) return { verdict: 'unscannable', reason: 'too_large' };
    throw e;
  } finally { sock.destroy(); }
}

function parseResult(text) {
  if (/:\s*OK$/.test(text)) return { verdict: 'clean' };
  const f = /:\s*(.+)\s+FOUND$/.exec(text);
  if (f) {
    const sig = f[1].trim().slice(0, 200);
    if (/^Heuristics\.Encrypted\./.test(sig)) return { verdict: 'unscannable', reason: 'encrypted' };
    if (/^Heuristics\.Limits\.Exceeded/.test(sig)) return { verdict: 'unscannable', reason: 'too_large' };
    return { verdict: 'infected', finding: sig };
  }
  if (/size limit/i.test(text)) return { verdict: 'unscannable', reason: 'too_large' };
  throw new N.ScanNetError('protocol', `unexpected answer: ${text.slice(0, 100)}`);
}

let _resolveTxt = (name) => dns.promises.resolveTxt(name);

/** Latest published ClamAV versions → { engine, main, daily, bytecode, at } or null. */
async function latest() {
  try {
    const recs = await Promise.race([
      _resolveTxt('current.cvd.clamav.net'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000).unref()),
    ]);
    const txt = (recs && recs[0] ? recs[0].join('') : '').trim();
    return parseTxt(txt);
  } catch { return null; }
}

function parseTxt(txt) {
  const f = String(txt || '').split(':');
  if (f.length < 3 || !/^\d+\.\d+/.test(f[0])) return null;
  const n = (v) => (/^\d+$/.test(v || '') ? Number(v) : null);
  return { engine: f[0], main: n(f[1]), daily: n(f[2]), at: n(f[3]) ? new Date(n(f[3]) * 1000).toISOString() : null, bytecode: n(f[7]) };
}

/** '1.4.3' < '1.5.1' ? */
function older(a, b) {
  const pa = String(a || '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0); }
  return false;
}

function _setResolveTxtForTest(fn) { _resolveTxt = fn || ((name) => dns.promises.resolveTxt(name)); }

module.exports = { ping, version, reload, scan, latest, parseVersion, parseResult, parseTxt, older, _setResolveTxtForTest };
