#!/usr/bin/env node
'use strict';

// Export Caddy JSON config from DB — used by entrypoint.sh to start
// Caddy directly with the final configuration instead of the minimal
// Caddyfile that Node later had to replace via POST /load. The /load
// transition opened a TLS-alert-80 race window on every image deploy
// (Caddy re-initialises its TLS stack mid-flight; new connections got
// `internal error` until the transition settled, sometimes permanently
// until a second restart). Generating the final JSON up-front and
// booting Caddy directly with it removes the race.
//
// Usage: node export-caddy-config.js <output-path>
// Exit:  0 on success, non-zero on failure — caller falls back to the
//        static Caddyfile so the admin UI always stays reachable.

const fs = require('node:fs');
const path = require('node:path');

function main() {
  const outPath = process.argv[2];
  if (!outPath) {
    console.error('usage: export-caddy-config.js <output-path>');
    process.exit(2);
  }

  try {
    const { runMigrations } = require('../db/migrations');
    runMigrations();

    const { buildCaddyConfig } = require('../services/caddyConfig');
    const cfg = buildCaddyConfig();

    const httpServers = cfg && cfg.apps && cfg.apps.http && cfg.apps.http.servers;
    if (!httpServers || Object.keys(httpServers).length === 0) {
      console.error('no HTTP servers in generated config (empty DB + no GC_BASE_URL?)');
      process.exit(4);
    }

    const tmp = outPath + '.tmp';
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, outPath);

    const l4Count = cfg.apps.layer4 ? Object.keys(cfg.apps.layer4.servers || {}).length : 0;
    console.log(`wrote ${outPath} — ${Object.keys(httpServers).length} HTTP server(s), ${l4Count} L4 server(s)`);
    process.exit(0);
  } catch (err) {
    console.error('export failed:', err.message);
    process.exit(1);
  }
}

main();
