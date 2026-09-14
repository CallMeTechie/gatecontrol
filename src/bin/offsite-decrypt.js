#!/usr/bin/env node
'use strict';

// Decrypt a GateControl off-site backup archive (GCBK1, *.gcbk) —
// docs/feature-release-b.md §7. Stand-alone: needs no GateControl
// configuration, database or GC_ENCRYPTION_KEY, only Node ≥ 18.
//
//   node src/bin/offsite-decrypt.js <archive.gcbk> [options]
//
//   -o, --out <file>          write the JSON backup there (mode 0600) instead of stdout
//   -k, --key-out <file>      write the archived GC_ENCRYPTION_KEY there (0600), if included
//   -p, --passphrase-file <f> read the passphrase from a file (first line)
//   -i, --info                only show the (unencrypted) header
//
// Passphrase sources, in this order: --passphrase-file, the environment
// variable GC_OFFSITE_PASSPHRASE, an interactive prompt (no echo).
//
// The JSON backup can be restored in the UI (Settings → Backup → Restore).
// Simpler: upload the .gcbk itself there — the UI asks for the passphrase and
// re-encrypts the secrets to the new installation's key automatically.
//
// Exit: 0 ok, 1 wrong passphrase / damaged file, 2 usage error.

const fs = require('node:fs');
const path = require('node:path');

const { decryptBackup, readHeader, GcbkError } = require('../services/offsite/gcbk');

function usage(msg) {
  if (msg) process.stderr.write(`offsite-decrypt: ${msg}\n`);
  process.stderr.write('usage: node src/bin/offsite-decrypt.js <archive.gcbk> [-o backup.json] [-k keyfile] [-p passphrase-file] [-i]\n');
  process.exit(2);
}

function parseArgs(argv) {
  const o = { file: null, out: null, keyOut: null, passFile: null, info: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) usage(`${a} needs a value`); return argv[++i]; };
    if (a === '-o' || a === '--out') o.out = next();
    else if (a === '-k' || a === '--key-out') o.keyOut = next();
    else if (a === '-p' || a === '--passphrase-file') o.passFile = next();
    else if (a === '-i' || a === '--info') o.info = true;
    else if (a === '-h' || a === '--help') usage();
    else if (a.startsWith('-')) usage(`unknown option ${a}`);
    else if (!o.file) o.file = a;
    else usage('only one archive');
  }
  if (!o.file) usage('archive missing');
  return o;
}

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      // Piped: read the first line.
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (d) => { buf += d; });
      stdin.on('end', () => resolve(buf.split(/\r?\n/)[0]));
      stdin.on('error', reject);
      return;
    }
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let pass = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
          process.stderr.write('\n');
          resolve(pass);
          return;
        }
        if (c === '\u0003') { stdin.setRawMode(false); process.stderr.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') pass = pass.slice(0, -1);
        else pass += c;
      }
    };
    stdin.on('data', onData);
  });
}

function writePrivate(file, content) {
  const p = path.resolve(file);
  fs.writeFileSync(p, content, { mode: 0o600 });
  fs.chmodSync(p, 0o600);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  let buf;
  try { buf = fs.readFileSync(o.file); } catch (err) { usage(`cannot read ${o.file}: ${err.message}`); }

  if (o.info) {
    const { header } = readHeader(buf);
    process.stdout.write(JSON.stringify(header, null, 2) + '\n');
    return;
  }

  let passphrase;
  if (o.passFile) passphrase = fs.readFileSync(o.passFile, 'utf8').split(/\r?\n/)[0];
  else if (process.env.GC_OFFSITE_PASSPHRASE) passphrase = process.env.GC_OFFSITE_PASSPHRASE;
  else passphrase = await promptHidden('Passphrase: ');

  const { header, payload } = await decryptBackup(buf, passphrase);
  const json = JSON.stringify(payload.backup, null, 2) + '\n';
  if (o.out) {
    writePrivate(o.out, json);
    process.stderr.write(`backup written to ${o.out} (GateControl ${header.gc_version || '?'}, created ${header.created_at || '?'})\n`);
  } else {
    process.stdout.write(json);
  }
  if (payload.encryption_key) {
    if (o.keyOut) {
      writePrivate(o.keyOut, payload.encryption_key + '\n');
      process.stderr.write(`GC_ENCRYPTION_KEY written to ${o.keyOut}\n`);
    } else {
      process.stderr.write('note: the archive contains the GC_ENCRYPTION_KEY of the source installation (use --key-out to extract it)\n');
    }
  } else {
    process.stderr.write('note: the archive does not contain the GC_ENCRYPTION_KEY — restore it on an installation with the same key\n');
  }
}

main().catch((err) => {
  if (err instanceof GcbkError) {
    process.stderr.write(`offsite-decrypt: ${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`offsite-decrypt: ${err.message}\n`);
  process.exit(1);
});
