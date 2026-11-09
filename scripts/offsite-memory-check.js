#!/usr/bin/env node
'use strict';

// Peak memory of an off-site backup upload (services/offsite) — the archive
// written as a file and sent from read streams, against holding it as one
// Buffer as up to 1.258.1 ("--legacy").
//
//   node scripts/offsite-memory-check.js [--mb 400] [--legacy] [--part-mb 16]
//
// Writes (in a child process) a backup file with <mb> MB of incompressible plugin data (as
// base64, as in a real backup) into a temp folder, then builds the archive
// and uploads it to a WebDAV and an S3 server running in this process (both
// only count and hash what arrives — the S3 one with a multipart upload
// above --part-mb). RSS is sampled every 10 ms from the start of the build
// to the end of the uploads. Prints one JSON line:
//   { mode, plugin_mb, archive_mb, baseline_rss_mb, peak_rss_mb, extra_mb, max_rss_mb, ok }
// extra_mb = peak − baseline: what the archive transfer added.
//
// tests/offsite_memory.test.js runs it with a smaller size and checks the
// bound; the numbers for the PR come from a run with --mb 400.

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.GC_LOG_LEVEL = process.env.GC_LOG_LEVEL || 'silent';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i === -1 ? dflt : Number(args[i + 1]); };
const MB = 1024 * 1024;
const PLUGIN_MB = opt('mb', 400);
const PART_MB = opt('part-mb', 16);
const LEGACY = args.includes('--legacy');

const gcbk = require('../src/services/offsite/gcbk');
const webdav = require('../src/services/offsite/webdav');
const s3 = require('../src/services/offsite/s3');

const rssMb = () => process.memoryUsage().rss / MB;

/** The backup file, written piece by piece (its own RSS stays small). */
async function writeBackup(file) {
  const out = fs.createWriteStream(file);
  const write = (s) => new Promise((resolve) => { if (out.write(s)) resolve(); else out.once('drain', resolve); });
  await write('{\n  "version": 1,\n  "data": {\n    "settings": [],\n    "plugins": [\n      {\n        "id": "big",\n        "db": "');
  // base64 of random bytes in pieces of 3 MiB (a multiple of 3: the pieces join to one valid base64 text)
  for (let left = PLUGIN_MB * MB; left > 0; left -= 3 * MB) await write(crypto.randomBytes(Math.min(left, 3 * MB)).toString('base64'));
  await write('"\n      }\n    ]\n  }\n}\n');
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
}

/** A server that takes WebDAV and S3 requests and only counts and hashes the bodies. */
function sink() {
  const got = { bytes: 0, objects: new Map() }; // name → { size, sha }
  const uploads = new Map();
  const server = http.createServer((req, res) => {
    const h = crypto.createHash('sha256');
    let n = 0;
    req.on('data', (c) => { n += c.length; h.update(c); });
    req.on('end', () => {
      got.bytes += n;
      const u = new URL(req.url, 'http://x');
      const name = decodeURIComponent(u.pathname.split('/').pop());
      if (req.method === 'PROPFIND') { res.writeHead(207); res.end('<d:multistatus xmlns:d="DAV:"></d:multistatus>'); return; }
      if (req.method === 'POST' && u.searchParams.has('uploads')) {
        const id = crypto.randomBytes(6).toString('hex');
        uploads.set(id, 0);
        res.writeHead(200); res.end(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`); return;
      }
      if (req.method === 'PUT' && u.searchParams.has('uploadId')) {
        uploads.set(u.searchParams.get('uploadId'), uploads.get(u.searchParams.get('uploadId')) + n);
        res.writeHead(200, { etag: `"${h.digest('hex').slice(0, 32)}"` }); res.end(); return;
      }
      if (req.method === 'POST' && u.searchParams.has('uploadId')) {
        got.objects.set(name, { size: uploads.get(u.searchParams.get('uploadId')), sha: null });
        res.writeHead(200); res.end('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>'); return;
      }
      if (req.method === 'PUT') { got.objects.set(name, { size: n, sha: h.digest('hex') }); res.writeHead(201); res.end(); return; }
      res.writeHead(204); res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, got, base: `http://127.0.0.1:${server.address().port}` })));
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-offsite-mem-'));
  const { server, got, base } = await sink();
  try {
    const json = path.join(dir, 'gatecontrol-20261109-030000.json');
    // the input in a child process: its memory never shows in this one's RSS
    require('node:child_process').execFileSync(process.execPath, [__filename, '--mb', String(PLUGIN_MB), '--write-input', json], { stdio: 'inherit' });
    const davCfg = { url: `${base}/dav/`, username: 'u', password: 'p' };
    const s3Cfg = { endpoint: base, region: 'us-east-1', bucket: 'bk', prefix: 'gc', access_key_id: 'AK', secret_access_key: 'SK', path_style: true };
    s3._limits.part = PART_MB * MB;
    const opts = { passphrase: 'memory check passphrase', kdf: { N: 1024, r: 8, p: 1 }, gcVersion: 'mem' };

    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 200));
    const baseline = rssMb();
    let peak = baseline;
    const timer = setInterval(() => { peak = Math.max(peak, rssMb()); }, 10);
    let archiveSize;
    let sha;
    try {
      if (LEGACY) {
        // up to 1.258.1: the archive as one Buffer, handed to every transport
        const buf = await gcbk.encryptBackupFile(json, opts);
        archiveSize = buf.length;
        sha = crypto.createHash('sha256').update(buf).digest('hex');
        await webdav.upload(davCfg, 'dav.gcbk', buf);
        await s3.upload(s3Cfg, 's3.gcbk', buf);
      } else {
        const file = path.join(dir, 'archive.gcbk');
        const r = await gcbk.writeBackupArchive(json, file, { ...opts, partSize: s3._limits.part });
        archiveSize = r.size;
        const archive = { path: file, ...r };
        await webdav.upload(davCfg, 'dav.gcbk', archive);
        await s3.upload(s3Cfg, 's3.gcbk', archive);
        sha = crypto.createHash('sha256');
        for await (const c of fs.createReadStream(file)) sha.update(c);
        sha = sha.digest('hex');
      }
    } finally { clearInterval(timer); }
    peak = Math.max(peak, rssMb());
    const dav = got.objects.get('dav.gcbk');
    const up = got.objects.get('s3.gcbk');
    const ok = !!dav && !!up && dav.size === archiveSize && up.size === archiveSize && dav.sha === sha;
    const r1 = (n) => Math.round(n * 10) / 10;
    process.stdout.write(JSON.stringify({
      mode: LEGACY ? 'legacy (Buffer)' : 'stream (file)',
      plugin_mb: PLUGIN_MB, archive_mb: r1(archiveSize / MB), part_mb: PART_MB,
      baseline_rss_mb: r1(baseline), peak_rss_mb: r1(peak), extra_mb: r1(peak - baseline),
      max_rss_mb: r1(process.resourceUsage().maxRSS / 1024), ok,
    }) + '\n');
    if (!ok) process.exitCode = 1;
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (args.includes('--write-input')) {
  writeBackup(args[args.indexOf('--write-input') + 1]).catch((err) => { process.stderr.write(`${err.stack || err}\n`); process.exit(1); });
} else {
  main().catch((err) => { process.stderr.write(`${err.stack || err}\n`); process.exit(1); });
}
