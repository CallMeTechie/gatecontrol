'use strict';

/**
 * Background poller that detects silently-dead gateways by TCP-probing
 * their API port when heartbeats stop arriving, and drives the health
 * state machine accordingly. Fills the gap left by the heartbeat-only
 * health signal: without probes, a gateway that crashes without sending
 * a farewell heartbeat stays "online" forever because the state machine
 * is only fed on heartbeat arrival.
 *
 * Cycle:
 *   every PROBE_INTERVAL_MS:
 *     for each enabled gateway whose last_seen_at is older than
 *     HEARTBEAT_GRACE_MS ago:
 *       TCP-connect to (peer_ip, api_port), PROBE_TIMEOUT_MS deadline
 *       record result as synthetic heartbeat into the health machine
 *         (but do NOT touch last_seen_at — stale-detection must keep
 *         working)
 *
 * The heartbeat grace window tolerates one missed heartbeat (default
 * heartbeat interval is 30s; grace is 60s = ~2 intervals). Probing
 * sooner would spam healthy gateways that are just between heartbeats.
 */

const net = require('node:net');

const PROBE_INTERVAL_MS = 15_000;     // 15s between probe cycles
const HEARTBEAT_GRACE_MS = 60_000;    // skip probe if heartbeat arrived <60s ago
const PROBE_TIMEOUT_MS = 2_000;       // individual TCP-connect timeout

let pollerInterval = null;

/**
 * TCP-probe host:port with a timeout. Resolves to boolean:
 *   true  = connection established within timeout
 *   false = connect error, timeout, or anything else
 */
function tcpProbe(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
    try {
      sock.connect(port, host);
    } catch { done(false); }
  });
}

/**
 * Run a single probe cycle. Exposed for testing — startProbe schedules
 * this on setInterval.
 *
 * @param {object} deps — injected for testability:
 *   listGateways(): [{peer_id, ip, api_port, last_seen_at}]
 *   recordProbeResult(peerId, healthy): void
 *   probe(host, port): Promise<boolean>   // defaults to tcpProbe
 *   now(): number                          // defaults to Date.now()
 *   heartbeatGraceMs: number               // defaults to HEARTBEAT_GRACE_MS
 */
async function runProbeCycle(deps) {
  const {
    listGateways,
    recordProbeResult,
    probe = tcpProbe,
    now = () => Date.now(),
    heartbeatGraceMs = HEARTBEAT_GRACE_MS,
    logger,
  } = deps;

  const gateways = listGateways();
  const staleThreshold = now() - heartbeatGraceMs;

  // Only probe gateways whose last heartbeat is stale. Skipping fresh
  // ones prevents probe traffic to healthy gateways between heartbeats.
  const stale = gateways.filter(g =>
    !g.last_seen_at || g.last_seen_at < staleThreshold
  );

  if (stale.length === 0) return { probed: 0, alive: 0, dead: 0 };

  let alive = 0;
  let dead = 0;
  await Promise.all(stale.map(async (g) => {
    if (!g.ip || !g.api_port) return;
    try {
      const ok = await probe(g.ip, g.api_port);
      recordProbeResult(g.peer_id, ok);
      if (ok) alive++; else dead++;
    } catch (err) {
      if (logger) logger.warn({ err: err.message, peerId: g.peer_id }, 'Probe cycle entry failed');
    }
  }));

  return { probed: stale.length, alive, dead };
}

function startProbe(deps) {
  if (pollerInterval) return;
  const intervalMs = deps.intervalMs || PROBE_INTERVAL_MS;
  if (deps.logger) deps.logger.info({ intervalMs }, 'Starting gateway probe poller');
  pollerInterval = setInterval(() => {
    runProbeCycle(deps).catch(err => {
      if (deps.logger) deps.logger.error({ err: err.message }, 'Gateway probe cycle failed');
    });
  }, intervalMs);
  // .unref() so the probe timer does not keep Node alive at shutdown —
  // graceful shutdown must win.
  if (typeof pollerInterval.unref === 'function') pollerInterval.unref();
}

function stopProbe() {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
  }
}

module.exports = {
  tcpProbe,
  runProbeCycle,
  startProbe,
  stopProbe,
  PROBE_INTERVAL_MS,
  HEARTBEAT_GRACE_MS,
  PROBE_TIMEOUT_MS,
};
