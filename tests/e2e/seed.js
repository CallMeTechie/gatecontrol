#!/usr/bin/env node
'use strict';

// Baut die Test-Datenbank für die Browser-Tests auf: Migrationen, Admin,
// zwei Gateways, eine Zone mit drei Hosts und ein zweiter Admin mit
// aktiviertem zweiten Faktor.
//
// Warum ein eigener Schritt und nicht im Szenario: die App läuft danach als
// eigener Prozess (`node src/server.js`), und die Lizenz-Übersteuerung
// (`license._overrideForTest`) wirkt nur im Prozess, der sie aufruft. Alles,
// was zum Anlegen eine Pro-Funktion braucht, passiert deshalb hier; die
// Szenarien lesen anschliessend und kommen mit der Community-Ausstattung aus.
//
// Aufruf (GC_DB_PATH/GC_DATA_DIR müssen gesetzt sein):
//   node tests/e2e/seed.js [ausgabedatei.json]
// Schreibt die Zugangsdaten und die IDs als JSON (Vorgabe:
// $GC_DATA_DIR/e2e-fixtures.json), damit run.js sie lesen kann.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';

const ADMIN = { username: process.env.GC_ADMIN_USER || 'e2e_admin', password: process.env.GC_ADMIN_PASSWORD || 'E2eTest!Pass123' };
const TFA = { username: 'e2e_tfa', password: 'E2eTest!Pass123' };
const ZONE = 'e2e.example.com';

async function main() {
  const out = process.argv[2] || path.join(process.env.GC_DATA_DIR || '.', 'e2e-fixtures.json');

  // Die App legt diese Verzeichnisse beim ersten Schreiben nicht selbst an.
  for (const d of [process.env.GC_DATA_DIR, process.env.GC_CADDY_DATA_DIR, process.env.GC_BACKUP_DIR,
    process.env.GC_DNS_HOSTS_FILE && path.dirname(process.env.GC_DNS_HOSTS_FILE)]) {
    if (d) fs.mkdirSync(d, { recursive: true });
  }

  require('../../src/db/migrations').runMigrations();
  await require('../../src/db/seed').seedAdminUser();

  const db = require('../../src/db/connection').getDb();
  const license = require('../../src/services/license');
  // Nur für diesen Prozess: die Fixtures brauchen Gateway-TCP und mehrere
  // HTTP-Ziele. Die App startet danach ohne Übersteuerung.
  license._overrideForTest({
    http_routes: -1, l4_routes: -1, gateway_peers: 10, gateway_http_targets: -1,
    gateway_tcp_routing: true, gateway_wol: true, internal_dns: true,
  });

  // Caddy nie anfassen: die App läuft ohne Caddy, und ein Sync würde auf die
  // Admin-API eines fremden Caddy zielen.
  const caddy = require('../../src/services/caddyConfig');
  caddy.syncToCaddy = async () => true;

  const gateway = (name, ip, lan) => {
    const id = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES (?, ?, ?, 1, 'gateway')")
      .run(name, crypto.randomBytes(16).toString('base64'), ip + '/32').lastInsertRowid;
    db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, last_health, alive)
      VALUES (?, 9876, ?, 'e', strftime('%s','now')*1000, ?, 1)`)
      .run(id, 'h' + id, JSON.stringify({ telemetry: { lan_subnets: [{ cidr: lan }] } }));
    return id;
  };

  const gwHome = gateway('e2e-gw-home', '10.8.0.2', '192.168.10.0/24');
  const gwNas = gateway('e2e-gw-nas', '10.8.0.3', '192.168.20.0/24');

  const zoneId = db.prepare(
    `INSERT INTO domains (domain, status, gateway_kind, gateway_peer_id, default_external_enabled)
     VALUES (?, 'verified', 'gateway', ?, 1)`).run(ZONE, gwHome).lastInsertRowid;

  const hosts = require('../../src/services/hosts');
  const nas = await hosts.create(zoneId, {
    subdomain: 'nas', description: 'Storage', lan_host: '192.168.10.10',
    entries: [{ type: 'http', target_port: 5001, backend_https: true }, { type: 'tcp', target_port: 22, listen_port: 2022 }],
  });
  const wiki = await hosts.create(zoneId, {
    subdomain: 'wiki', description: 'Wiki', lan_host: '192.168.10.11',
    entries: [{ type: 'http', target_port: 8080 }],
  });
  const apex = await hosts.create(zoneId, {
    subdomain: '@', description: 'Landing', lan_host: '192.168.10.12',
    entries: [{ type: 'http', target_port: 80 }],
  });

  // Zweiter Admin MIT zweitem Faktor — der erste bleibt ohne, damit die
  // Anmeldung ohne zweiten Schritt ebenfalls geprüft werden kann.
  const users = require('../../src/services/users');
  const tfaUser = await users.create({ username: TFA.username, password: TFA.password, role: 'admin' });
  const twoFactor = require('../../src/services/adminTwoFactor');
  const { secret } = twoFactor.beginSetup(tfaUser.id);
  const OTPAuth = require('otpauth');
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const confirmed = await twoFactor.confirmSetup(tfaUser.id, code, '127.0.0.1');
  if (!confirmed.ok) throw new Error('seed: could not enable 2FA for the fixture user');

  const fixtures = {
    admin: ADMIN,
    tfa: { ...TFA, secret, recovery_codes: confirmed.recovery_codes },
    zone: { domain: ZONE, id: zoneId },
    hosts: { nas: nas.id, wiki: wiki.id, apex: apex.id },
    gateways: { home: gwHome, nas: gwNas },
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(fixtures, null, 2));
  fs.chmodSync(out, 0o600);
  // Kein Geheimnis in die Ausgabe — die Datei liegt im Datenverzeichnis des Laufs.
  console.log(`seed: zone ${ZONE} with 3 hosts, 2 gateways, 2FA user ${TFA.username}; fixtures → ${out}`);

  require('../../src/db/connection').closeDb();
}

main().catch((err) => { console.error('seed failed:', err); process.exit(1); });
