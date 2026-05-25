#!/usr/bin/env node
'use strict';
// CI drift check: byte-compares each vendored template against the upstream
// raw.githubusercontent.com release at the tag pinned in VENDORED.md.
// Exits 1 on any mismatch, fetch error, or non-200 response.
// Exits 0 when all files match (prints count + tag).

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const VENDORED_MD = path.join(__dirname, '..', 'src', 'services', 'gatewaySetup', 'templates', 'VENDORED.md');
const TEMPLATES_DIR = path.join(__dirname, '..', 'src', 'services', 'gatewaySetup', 'templates');

// Files to check: local path relative to templates/ → upstream path relative to deploy/
const VENDORED_FILES = [
  { local: 'update.sh', upstream: 'update.sh' },
];

function parseTag(md) {
  const m = md.match(/^\s*-\s+tag:\s*(\S+)\s*$/m);
  if (!m) throw new Error('Could not find "- tag: <version>" line in VENDORED.md');
  return m[1];
}

function fetchRaw(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  let vendoredMd;
  try {
    vendoredMd = fs.readFileSync(VENDORED_MD, 'utf8');
  } catch (e) {
    console.error(`ERROR: Cannot read VENDORED.md: ${e.message}`);
    process.exit(1);
  }

  let tag;
  try {
    tag = parseTag(vendoredMd);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }

  console.log(`Checking ${VENDORED_FILES.length} vendored files against gatecontrol-gateway@${tag}…`);

  let failed = false;

  for (const { local, upstream } of VENDORED_FILES) {
    const localPath = path.join(TEMPLATES_DIR, local);
    const url = `https://raw.githubusercontent.com/CallMeTechie/gatecontrol-gateway/${tag}/deploy/${upstream}`;

    let localBuf;
    try {
      localBuf = fs.readFileSync(localPath);
    } catch (e) {
      console.error(`FAIL [${local}]: Cannot read local file: ${e.message}`);
      failed = true;
      continue;
    }

    let remoteBuf;
    try {
      remoteBuf = await fetchRaw(url);
    } catch (e) {
      console.error(`FAIL [${local}]: Fetch error (${url}): ${e.message}`);
      failed = true;
      continue;
    }

    if (!localBuf.equals(remoteBuf)) {
      console.error(`FAIL [${local}]: Content mismatch vs gatecontrol-gateway@${tag}/deploy/${upstream}`);
      console.error(`  local  bytes: ${localBuf.length}`);
      console.error(`  remote bytes: ${remoteBuf.length}`);
      failed = true;
    } else {
      console.log(`  OK  ${local}`);
    }
  }

  if (failed) {
    console.error(`\nVendored template drift detected — update local copies or bump the tag in VENDORED.md.`);
    process.exit(1);
  }

  console.log(`\nOK: ${VENDORED_FILES.length} vendored files match gatecontrol-gateway@${tag}`);
}

main().catch((e) => {
  console.error(`ERROR: Unexpected error: ${e.message}`);
  process.exit(1);
});
