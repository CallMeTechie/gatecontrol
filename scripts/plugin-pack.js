#!/usr/bin/env node
'use strict';

// Build a .gcplugin from a plugin folder (docs/plugins.md "Paket bauen").
//
//   node scripts/plugin-pack.js <folder> [-o <file.gcplugin>]
//
// Signs the package when GC_PLUGIN_SIGNING_KEY is set (base64 32-byte Ed25519
// seed or a PEM private key) — that is what the gatecontrol-plugins CI does.
// Dot files/folders are skipped; symbolic links and anything that is not a
// regular file are refused. plugin.json is validated before packing.

const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../src/services/plugins/package');
const signature = require('../src/services/plugins/signature');
const manifestLib = require('../src/services/plugins/manifest');

function collect(root) {
  const files = new Map();
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) throw new Error('symbolic links are not allowed: ' + r);
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) {
        if (r === signature.SIGNATURE_FILE) continue;
        files.set(pkg.checkPath(r), fs.readFileSync(abs));
      } else throw new Error('not a regular file: ' + r);
    }
  };
  walk(path.resolve(root), '');
  return files;
}

/**
 * @param {string} dir
 * @param {{signingKey?: string, overrides?: object, extra?: Map}} [opts]
 * @returns {{buffer: Buffer, manifest: object, signed: boolean}}
 */
function packDir(dir, opts = {}) {
  let files = collect(dir);
  if (opts.overrides) {
    const raw = JSON.parse(files.get('plugin.json').toString('utf8'));
    files.set('plugin.json', Buffer.from(JSON.stringify({ ...raw, ...opts.overrides }, null, 2)));
  }
  if (opts.extra) for (const [k, v] of opts.extra) files.set(k, Buffer.isBuffer(v) ? v : Buffer.from(String(v)));
  const pj = files.get('plugin.json');
  if (!pj) throw new Error('plugin.json missing');
  const res = manifestLib.validate(JSON.parse(pj.toString('utf8')), { files: new Set(files.keys()) });
  if (!res.ok) throw new Error('plugin.json invalid: ' + res.errors.join(', '));
  const key = opts.signingKey !== undefined ? opts.signingKey : process.env.GC_PLUGIN_SIGNING_KEY;
  if (key) files = signature.sign(files, key);
  return { buffer: pkg.encode(files), manifest: res.manifest, signed: !!key };
}

module.exports = { packDir, collect };

if (require.main === module) {
  const args = process.argv.slice(2);
  const oi = args.indexOf('-o');
  const out = oi >= 0 ? args[oi + 1] : null;
  const dir = args.find((a, i) => !a.startsWith('-') && (oi < 0 || i !== oi + 1));
  if (!dir) {
    process.stderr.write('usage: node scripts/plugin-pack.js <folder> [-o <file.gcplugin>]\n');
    process.exit(2);
  }
  try {
    const r = packDir(dir);
    const target = out || `${r.manifest.id}-${r.manifest.version}.gcplugin`;
    fs.writeFileSync(target, r.buffer);
    process.stdout.write(`${target} (${r.buffer.length} bytes, ${r.signed ? 'signed' : 'UNSIGNED'})\n`);
  } catch (e) {
    process.stderr.write('plugin-pack: ' + e.message + '\n');
    process.exit(1);
  }
}
