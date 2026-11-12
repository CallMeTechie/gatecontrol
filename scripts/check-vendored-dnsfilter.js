#!/usr/bin/env node
'use strict';
// CI drift check: the DNS filter engine in src/services/vpnDnsFilter/dnsfilter-core/
// must be the whole directory src/dnsfilter-core/ of gatecontrol-gateway at
// the tag pinned in src/services/vpnDnsFilter/VENDORED.md — every file
// byte-identical, none missing, none extra.
// Exits 1 on any difference or when the tag cannot be fetched.
//
//   GC_GATEWAY_REPO=<path|url>  where to fetch the tag from (default: GitHub)
//   --update                    copy the tag's files over the local copy

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', 'src', 'services', 'vpnDnsFilter');
const VENDORED_MD = path.join(ROOT, 'VENDORED.md');
const LOCAL_DIR = path.join(ROOT, 'dnsfilter-core');
const UPSTREAM_DIR = 'src/dnsfilter-core';
const REPO = process.env.GC_GATEWAY_REPO || 'https://github.com/CallMeTechie/gatecontrol-gateway.git';

function parseTag(md) {
  const m = md.match(/^\s*-\s+tag:\s*(v\d+\.\d+\.\d+)\s*$/m);
  if (!m) throw new Error('Could not find "- tag: v<version>" line in VENDORED.md');
  return m[1];
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }).toString();
}

/** The files of the pinned tag: Map(name → Buffer). */
function upstreamFiles(tag) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-dnsfilter-'));
  try {
    git(tmp, ['init', '-q']);
    git(tmp, ['fetch', '-q', '--depth', '1', REPO, `refs/tags/${tag}`]);
    const names = git(tmp, ['ls-tree', '-r', '--name-only', 'FETCH_HEAD', UPSTREAM_DIR + '/']).split('\n').filter(Boolean);
    const out = new Map();
    for (const n of names) {
      const rel = n.slice(UPSTREAM_DIR.length + 1);
      out.set(rel, execFileSync('git', ['show', `FETCH_HEAD:${n}`], { cwd: tmp, maxBuffer: 16 * 1024 * 1024, timeout: 60000 }));
    }
    return out;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function localFiles(dir, prefix = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...localFiles(path.join(dir, e.name), prefix + e.name + '/'));
    else out.push(prefix + e.name);
  }
  return out;
}

function main() {
  let tag;
  try {
    tag = parseTag(fs.readFileSync(VENDORED_MD, 'utf8'));
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
  console.log(`Checking dnsfilter-core against gatecontrol-gateway@${tag}…`);

  let upstream;
  try {
    upstream = upstreamFiles(tag);
  } catch (e) {
    console.error(`ERROR: cannot fetch ${UPSTREAM_DIR} at ${tag}: ${String(e.stderr || e.message).trim()}`);
    process.exit(1);
  }
  if (!upstream.size) {
    console.error(`ERROR: gatecontrol-gateway@${tag} has no ${UPSTREAM_DIR}/`);
    process.exit(1);
  }

  if (process.argv.includes('--update')) {
    fs.rmSync(LOCAL_DIR, { recursive: true, force: true });
    for (const [rel, buf] of upstream) {
      const dest = path.join(LOCAL_DIR, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
    }
    console.log(`Updated: ${upstream.size} files copied from gatecontrol-gateway@${tag}`);
    return;
  }

  let failed = false;
  const local = new Set(localFiles(LOCAL_DIR));
  for (const [rel, buf] of upstream) {
    if (!local.has(rel)) {
      console.error(`FAIL [${rel}]: missing in the local copy`);
      failed = true;
      continue;
    }
    const mine = fs.readFileSync(path.join(LOCAL_DIR, rel));
    if (!mine.equals(buf)) {
      console.error(`FAIL [${rel}]: content differs from gatecontrol-gateway@${tag} (local ${mine.length} bytes, upstream ${buf.length} bytes)`);
      failed = true;
    } else {
      console.log(`  OK  ${rel}`);
    }
  }
  for (const rel of local) {
    if (!upstream.has(rel)) {
      console.error(`FAIL [${rel}]: not in gatecontrol-gateway@${tag} — the copy must not carry files of its own`);
      failed = true;
    }
  }
  if (failed) {
    console.error('\nDrift in dnsfilter-core — change the engine in gatecontrol-gateway, then raise the tag in VENDORED.md and copy it (--update).');
    process.exit(1);
  }
  console.log(`\nOK: ${upstream.size} files match gatecontrol-gateway@${tag}`);
}

main();
