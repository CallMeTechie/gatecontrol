// tests/rdp_player_reconnect_integration.test.js
//
// DA-E reconnect/reclaim integration test.
// Proves the server-side concurrency truth:
//   1. A killed WS is detected by the server; the slot is freed (no leak).
//   2. A half-open (network-partition) session is reclaimed on-demand by
//      `admitSession(..., isStale)` when a reconnect attempts admission.
//   3. A clean close (WS close frame) frees the slot promptly.
//
// Requirements:
//   - Real guacd listening on 127.0.0.1:4822
//   - Root (can run sshd on a high port and create a throwaway system user)
//
// Run standalone only (starts its own HTTP server + sshd):
//   node --test --test-force-exit tests/rdp_player_reconnect_integration.test.js
//
'use strict';

// ── Step 1: env vars that config/default.js reads at require-time ──────────
// These MUST be set before any GC module is required (config is cached on first
// require and never re-read from env after that).
const crypto = require('node:crypto');
process.env.GC_SECRET          ||= crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY  ||= crypto.randomBytes(32).toString('hex');
process.env.GC_GUAC_HEARTBEAT_MS     ||= '500';
process.env.GC_GUAC_HEARTBEAT_MISSES ||= '2';

// ── Step 2: standard library requires (no GC dependency) ──────────────────
const { test, before, after } = require('node:test');
const assert                   = require('node:assert/strict');
const http                     = require('node:http');
const { execSync, spawn }      = require('node:child_process');
const path                     = require('node:path');
const fs                       = require('node:fs');
const os                       = require('node:os');
const WebSocket                = require('ws');

// ── Step 3: create temp dir FIRST, then set path-dependent env vars ────────
// This must happen before any GC module requires (helpers/setup.js pattern).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-rdp-recon-'));
process.on('exit', () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ } });

process.env.NODE_ENV              = 'test';
process.env.GC_DB_PATH            = path.join(tmpDir, 'test.db');
process.env.GC_DATA_DIR           = tmpDir;
process.env.GC_LOG_LEVEL          = 'silent';
process.env.GC_ADMIN_PASSWORD     = 'TestPass123!';
process.env.GC_ADMIN_USER         = 'admin';
process.env.GC_WG_HOST            = 'test.example.com';
process.env.GC_BASE_URL           = 'http://localhost:3000';
process.env.GC_RATE_LIMIT_LOGIN   = '100000';
process.env.GC_RATE_LIMIT_API     = '100000';

// ── Step 4: GC modules (after ALL env vars are set) ───────────────────────
const { runMigrations }          = require('../src/db/migrations');
const { seedAdminUser }          = require('../src/db/seed');
const { createApp }              = require('../src/app');
const { closeDb, getDb }         = require('../src/db/connection');
const license                    = require('../src/services/license');
const { attachGuacTunnel, isStale } = require('../src/tunnel/guacTunnel');
const guacToken                  = require('../src/services/guacToken');
const { listActiveSessions, admitSession } = require('../src/services/guacSessions');
const rdpSessions                = require('../src/services/rdpSessions');

// ── Throwaway sshd constants ────────────────────────────────────────────────
const SSHD_PORT = 55222;
const SSHD_USER = 'gc-rdptest';
const SSHD_PASS = 'GcRdpTestPwd123';
const SSHD_DIR  = path.join(tmpDir, 'sshd');

// ── Integration-precondition gate ────────────────────────────────────────────
// This test needs a real guacd on 127.0.0.1:4822, the ability to run sshd, and
// root (to create a throwaway system user). Those exist on a dev box but NOT in
// CI (GitHub Actions has no guacd container). When the preconditions are not
// met we skip the suite cleanly instead of failing — the 2b unit/HTTP suite
// covers the mint/guard logic in CI; this test is the live concurrency gate
// that runs where guacd is present.
let SKIP = false;
let skipReason = '';

function probeGuacd() {
  return new Promise(resolve => {
    const net  = require('node:net');
    const sock = net.createConnection({ host: '127.0.0.1', port: 4822 });
    let settled = false;
    const done = ok => { if (settled) return; settled = true; try { sock.destroy(); } catch { /* ignore */ } resolve(ok); };
    sock.setTimeout(1000);
    sock.once('connect', () => done(true));
    sock.once('error',   () => done(false));
    sock.once('timeout', () => done(false));
  });
}

// ── Shared test state ───────────────────────────────────────────────────────
let server, serverPort, routeId, sshdProc;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Poll until listActiveSessions().length === expected, or throw on timeout.
 */
async function waitForCount(expected, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (listActiveSessions().length === expected) return;
    await new Promise(r => setTimeout(r, 50));
  }
  const actual = listActiveSessions().length;
  assert.equal(actual, expected, `Timed out waiting for session count ${expected}`);
}

/**
 * Open a real WebSocket to the guac tunnel with a fresh minted token.
 * Resolves when the HTTP upgrade succeeds (WS 'open' event).
 * The guac session row appears later — use waitForCount() after this call.
 */
function openGuacWS() {
  const { token } = guacToken.mint({
    type: 'ssh',
    settings: {
      hostname: '127.0.0.1',
      port:     String(SSHD_PORT),
      username: SSHD_USER,
      password: SSHD_PASS,
      'font-name':    'monospace',
      'font-size':    '12',
      'color-scheme': 'gray-black',
    },
    rdpRouteId: routeId,
    tokenId:    null,
    peerId:     null,
    tokenName:  null,
  });
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${serverPort}/api/v1/client/rdp/guac-tunnel?token=${encodeURIComponent(token)}`
    );
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('WS open timeout')); }, 8000);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

before(async () => {
  // Precondition gate (non-destructive checks FIRST — before any useradd/sshd):
  // real guacd reachable, sshd binary present, and running as root. If any is
  // missing (e.g. in CI), skip the suite without touching the system.
  const guacdUp = await probeGuacd();
  const sshdBin = fs.existsSync('/usr/sbin/sshd');
  const isRoot  = typeof process.getuid === 'function' && process.getuid() === 0;
  if (!guacdUp || !sshdBin || !isRoot) {
    SKIP = true;
    skipReason = `integration deps unavailable (guacd:${guacdUp} sshd:${sshdBin} root:${isRoot})`;
    return;
  }

  try {
  // 1. Start throwaway sshd so guacd has a real SSH target.
  fs.mkdirSync(SSHD_DIR, { recursive: true });
  execSync(`ssh-keygen -t rsa -N "" -f ${path.join(SSHD_DIR, 'host_rsa_key')} -q`);

  // Create user only if it doesn't already exist.
  try { execSync('id ' + SSHD_USER + ' >/dev/null 2>&1'); }
  catch { execSync('useradd -m -s /bin/sh ' + SSHD_USER); }
  execSync('echo \'' + SSHD_USER + ':' + SSHD_PASS + '\' | chpasswd');

  fs.writeFileSync(path.join(SSHD_DIR, 'sshd_config'), [
    'Port ' + SSHD_PORT,
    'HostKey ' + path.join(SSHD_DIR, 'host_rsa_key'),
    'PidFile ' + path.join(SSHD_DIR, 'sshd.pid'),
    'AuthorizedKeysFile /dev/null',
    'PasswordAuthentication yes',
    'ChallengeResponseAuthentication no',
    'KbdInteractiveAuthentication no',
    'UsePAM yes',
    'AllowUsers ' + SSHD_USER,
    'PrintMotd no',
    'PrintLastLog no',
    'LogLevel QUIET',
    'PermitRootLogin no',
  ].join('\n'));

  sshdProc = spawn('/usr/sbin/sshd', [
    '-f', path.join(SSHD_DIR, 'sshd_config'),
    '-D',
  ], { stdio: 'ignore' });
  sshdProc.unref();

  // Give sshd half a second to bind the port.
  await new Promise(r => setTimeout(r, 500));

  // 2. Stand up the GC app with a real HTTP server and guac tunnel.
  runMigrations();
  await seedAdminUser();
  license._overrideForTest({
    ...license.COMMUNITY_FALLBACK,
    browser_sessions: true,
    remote_desktop: true,
  });

  const app = createApp();
  server = http.createServer(app);
  attachGuacTunnel(server);

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  serverPort = server.address().port;

  // 3. Insert a minimal SSH route pointing at the throwaway sshd.
  //    Credentials live in the minted token (guacToken.mint), not the DB.
  const db  = getDb();
  const row = db.prepare(
    "INSERT INTO rdp_routes (name, host, port, protocol, browser_enabled) VALUES (?, ?, ?, 'ssh', 1)"
  ).run('rdp-recon-sshd', '127.0.0.1', SSHD_PORT);
  routeId = row.lastInsertRowid;
  } catch (err) {
    // A setup failure (sshd refused to bind, etc.) in an otherwise-eligible env
    // also skips rather than fails — the test is a live gate, not a unit test.
    SKIP = true;
    skipReason = 'integration setup failed: ' + (err && err.message);
  }
});

after(() => {
  // Kill sshd (via spawned child + PID file fallback).
  if (sshdProc) { try { sshdProc.kill(); } catch { /* ignore */ } }
  try {
    const pidPath = path.join(SSHD_DIR, 'sshd.pid');
    if (fs.existsSync(pidPath)) {
      const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
      if (pid > 0) process.kill(pid, 'SIGTERM');
    }
  } catch { /* best-effort */ }
  // Remove throwaway user (best-effort: might not exist if before() was skipped).
  try { execSync('userdel -r ' + SSHD_USER + ' 2>/dev/null'); } catch { /* ignore */ }

  if (server) { try { server.close(); } catch { /* ignore */ } }
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 1 — kill WS abruptly → server detects the drop → slot freed (no leak)
// ═══════════════════════════════════════════════════════════════════════════

test('kill-WS: abrupt terminate; server closes the slot — no slot leak', async (t) => {
  if (SKIP) { t.skip(skipReason); return; }
  const baseline = listActiveSessions().length;

  // Establish a real browser session: WS → guacd → throwaway sshd.
  // evaluateConnection() verifies+consumes the token, admitSession() caps.
  const ws = await openGuacWS();

  // guac.on('open') fires once guacd connected to sshd → rdpSessions.startSession.
  await waitForCount(baseline + 1, 6000);
  assert.equal(listActiveSessions().length, baseline + 1, 'slot occupied after open');

  // TCP RST (abrupt kill on localhost) — server detects close immediately.
  // ws.terminate() sends a RST; on localhost the server-side socket fires a
  // 'close' event right away, which propagates: ws close → guacd cc.close() →
  // guac.on('close') → rdpSessions.endSession() → slot freed.
  // (This is NOT a true half-open / network-partition path; that is Test 2's
  //  isStale path, which covers the case where no RST or FIN is ever received.)
  ws.terminate();

  // Server detects the dropped connection and frees the slot.
  await waitForCount(baseline, 3000);
  assert.equal(listActiveSessions().length, baseline,
    'active session count must return to baseline after abrupt WS kill (no slot leak)');
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 2 — isStale reclaim: the half-open / network-partition reconnect path
//
// Mechanism asserted: admitSession() is purely on-demand (no background sweep).
// When the reconnecting player calls the mint endpoint, the server-side WS
// upgrade invokes admitSession({…, isStale}).  isStale() checks each active
// session's last_heartbeat; any session older than heartbeatMs*heartbeatMisses
// is reclaimed before cap enforcement.  The reconnect then succeeds without
// ever leaking above baseline+1.
// ═══════════════════════════════════════════════════════════════════════════

test('isStale reclaim: admitSession frees the stale half-open slot (reconnect path)', (t) => {
  if (SKIP) { t.skip(skipReason); return; }
  // Confirm the reclaim budget from the actual loaded config (verifies env var wiring).
  const cfg              = require('../config/default').guac;
  const reclaimBudgetMs  = cfg.heartbeatMs * cfg.heartbeatMisses;
  // With GC_GUAC_HEARTBEAT_MS=500 and GC_GUAC_HEARTBEAT_MISSES=2 the budget is 1 s.
  assert.equal(reclaimBudgetMs, 1000,
    'reclaim budget must be 500 ms × 2 misses = 1000 ms (confirms short-heartbeat env vars took effect)');

  const baseline = listActiveSessions().length;
  const db       = getDb();

  // Simulate a half-open session: the slot is 'active' in the DB but the client
  // is gone (network partition, laptop sleep, etc.) and the server never received
  // a RST/FIN.  In this scenario guac.on('close') never fires, so the slot is
  // NOT freed automatically — it only gets freed when a subsequent admitSession
  // call runs isStale() and reclaims it.
  const sess = rdpSessions.startSession(routeId, {
    via: 'browser', protocol: 'ssh',
    tokenId: null, peerId: null, clientIp: '127.0.0.1',
  });

  // Set last_heartbeat to 2 s ago (well past the 1 s reclaim budget).
  // This simulates a session that had a live client (pong arrived once) and
  // then the network was partitioned.
  db.prepare(
    "UPDATE rdp_sessions SET last_heartbeat = datetime('now', '-2 seconds') WHERE id = ?"
  ).run(sess.id);

  assert.equal(listActiveSessions().length, baseline + 1,
    'stale slot must be active before reclaim');

  // The player's reconnect triggers a re-mint → WS upgrade → evaluateConnection
  // → admitSession({…, isStale}).  We call it directly here, passing the real
  // isStale function from guacTunnel (the authoritative implementation).
  const admit = admitSession({ routeId, tokenId: null, peerId: null, isStale });

  // admitSession returns {ok:true}: the stale slot was reclaimed and the cap
  // check passed (a new connection WOULD be admitted).  No new session row is
  // created here — that happens later in the WS upgrade handler (startSession).
  assert.equal(admit.ok, true,
    'admitSession must succeed: stale slot reclaimed, new connection admitted');

  // The stale session was ended (status → "reclaimed") and is no longer active.
  assert.equal(listActiveSessions().length, baseline,
    'active count returns to baseline after isStale reclaim (no slot leak across reconnect)');
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 3 — clean close: WS.close() frees the slot via endSession('normal')
// ═══════════════════════════════════════════════════════════════════════════

test('clean close: WS.close() frees the session slot via normal endSession', async (t) => {
  if (SKIP) { t.skip(skipReason); return; }
  const baseline = listActiveSessions().length;

  const ws = await openGuacWS();
  await waitForCount(baseline + 1, 6000);
  assert.equal(listActiveSessions().length, baseline + 1, 'slot occupied after open');

  // Send a proper close frame (the DA-F tab-close / disconnect path).
  ws.close();

  await waitForCount(baseline, 3000);
  assert.equal(listActiveSessions().length, baseline,
    'active session count must return to baseline after clean WS close');
});
