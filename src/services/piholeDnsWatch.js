'use strict';

const nodeDns = require('node:dns');
const { buildDnsToken } = require('./piholeDnsChain');

let logger;
try {
  logger = require('../utils/logger');
} catch {
  logger = { info: () => {}, warn: () => {} };
}

// Probe cadence and hysteresis. A dead Pi-hole DNS is noticed after
// DOWN_AFTER failed rounds, the second one RETRY_MS after the first: at most
// INTERVAL_MS + TIMEOUT_MS + RETRY_MS + TIMEOUT_MS = 9 s, then dnsmasq
// restarts (about 1 s, scripts/wg-wrapper.sh). Going back takes UP_AFTER good
// rounds in a row, so a flapping resolver does not restart dnsmasq every few
// seconds. The interval is not shorter because every probe is a query in
// Pi-hole's own statistics (17 280 a day per instance at 5 s).
const INTERVAL_MS = 5000;
const RETRY_MS = 1000;
const TIMEOUT_MS = 1500;
const DOWN_AFTER = 2;
const UP_AFTER = 3;

/**
 * One real DNS query (NS of the root zone — every resolver answers it, no
 * blocklist touches it) to `<dns_ip>:<dns_port>`. True only for a usable
 * answer: a timeout, a refused port, SERVFAIL or REFUSED all mean that VPN
 * devices would not get names resolved through this upstream either.
 * @param {{ dns_ip?: string, dns_port?: number|string }} inst
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function probeDns(inst, timeoutMs = TIMEOUT_MS) {
  if (!inst || !inst.dns_ip) return false;
  let resolver;
  try {
    resolver = new nodeDns.promises.Resolver({ timeout: timeoutMs, tries: 1 });
    const host = String(inst.dns_ip).includes(':') ? `[${inst.dns_ip}]` : inst.dns_ip;
    resolver.setServers([host + ':' + (parseInt(inst.dns_port, 10) || 53)]);
  } catch {
    return false;
  }
  // c-ares' own timeout is the normal way out; the timer below is only the
  // backstop so a round can never hang and stall the watch.
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => { try { resolver.cancel(); } catch { /* already done */ } resolve(false); }, timeoutMs + 1000);
    if (timer.unref) timer.unref();
  });
  const query = resolver.resolveNs('.').then(
    () => true,
    (err) => !!err && (err.code === 'ENODATA' || err.code === 'ENOTFOUND'),
  );
  try {
    return await Promise.race([query, guard]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * createDnsWatch(deps) — keeps the managed DNS chain usable.
 *
 * The chain (piholeDnsChain) makes the Pi-hole instances the ONLY upstreams
 * of dnsmasq, so a dead Pi-hole DNS means no name resolution for any VPN
 * device. This watch asks every instance's DNS port directly every few
 * seconds — independent of the sync interval and of the Pi-hole API, which
 * can be up while the resolver is down and the other way round — and
 *   - reverts dnsmasq to the default upstreams once NO instance answers,
 *   - applies the chain again once an instance answers reliably.
 * While at least one instance answers, the default upstreams are not in the
 * conf at all: nothing gets past the filter.
 *
 * deps:
 *   loadConfig()  → { enabled, manage_dns_chain, instances[] }
 *   dnsChain      → { apply(tokens), revert() }
 *   probe(inst)   → Promise<boolean>
 *   onChange(state, status) — called on pihole ⇄ fallback transitions
 *   now()         → ms, injectable for tests
 */
function createDnsWatch(deps) {
  const {
    loadConfig,
    dnsChain,
    probe = probeDns,
    onChange = () => {},
    now = () => Date.now(),
    intervalMs = INTERVAL_MS,
    retryMs = RETRY_MS,
    downAfter = DOWN_AFTER,
    upAfter = UP_AFTER,
  } = deps;

  // 'off' (chain not managed) | 'pihole' | 'fallback'
  let state = 'off';
  let since = null;
  let fails = 0;
  let oks = 0;
  let targets = [];
  let checkedAt = null;
  let timer = null;
  let inflight = null;
  let stopped = true;

  function status() {
    return { state, since, checkedAt, targets };
  }

  function setState(next) {
    if (state === next) return;
    const prev = state;
    state = next;
    since = now();
    fails = 0;
    oks = 0;
    if (next === 'off') { targets = []; return; }
    if (prev === 'off' && next === 'pihole') return; // switched on by the admin, not a recovery
    try { onChange(next, status()); } catch (err) { logger.warn({ err: err.message }, 'pihole dns watch: onChange failed'); }
  }

  // One round at a time: a caller that arrives while a round is under way
  // (settings saved, start) gets that round instead of a second one.
  function tick() {
    if (!inflight) inflight = round().finally(() => { inflight = null; });
    return inflight;
  }

  async function round() {
    try {
      const config = loadConfig();
      const instances = (config.enabled && config.manage_dns_chain && config.instances) || [];
      const probed = instances.filter(buildDnsToken);
      if (!probed.length) {
        if (state !== 'off') dnsChain.revert();
        setState('off');
        return status();
      }

      const results = await Promise.all(probed.map((inst) => Promise.resolve()
        .then(() => probe(inst)).then(Boolean, () => false)));
      targets = probed.map((inst, i) => ({ id: inst.id, label: inst.label || '', dns: buildDnsToken(inst), ok: results[i] }));
      checkedAt = now();
      const anyOk = results.some(Boolean);
      const tokens = probed.map(buildDnsToken);

      if (state === 'off') {
        // Process start or freshly enabled: nothing is known yet, so there is
        // no hysteresis to wait for — a chain that does not answer must not
        // be (or stay) the only upstream. apply()/revert() are idempotent.
        if (anyOk) {
          dnsChain.apply(tokens);
          setState('pihole');
        } else {
          dnsChain.revert();
          logger.warn({ targets: tokens }, 'pihole dns watch: no Pi-hole DNS answers — dnsmasq uses the default upstreams');
          setState('fallback');
        }
        return status();
      }

      if (state === 'pihole') {
        fails = anyOk ? 0 : fails + 1;
        if (fails >= downAfter) {
          dnsChain.revert();
          logger.warn({ targets: tokens }, 'pihole dns watch: no Pi-hole DNS answers — dnsmasq falls back to the default upstreams');
          setState('fallback');
        }
      } else if (state === 'fallback') {
        oks = anyOk ? oks + 1 : 0;
        if (oks >= upAfter) {
          dnsChain.apply(tokens);
          logger.info({ targets: tokens }, 'pihole dns watch: Pi-hole DNS answers again — chain applied');
          setState('pihole');
        }
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'pihole dns watch round failed');
    }
    return status();
  }

  // Self-rescheduling instead of setInterval: a slow round (probe timeout)
  // never overlaps the next one.
  function schedule() {
    if (stopped) return;
    // A failed round is confirmed (or cleared) quickly instead of a full interval later.
    const delay = (state === 'pihole' && fails > 0) ? retryMs : intervalMs;
    timer = setTimeout(() => { tick().finally(schedule); }, delay);
    if (timer.unref) timer.unref();
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    tick().finally(schedule);
  }

  function stop() {
    stopped = true;
    if (timer !== null) { clearTimeout(timer); timer = null; }
  }

  return { tick, status, start, stop, isFallback: () => state === 'fallback' };
}

module.exports = { createDnsWatch, probeDns, INTERVAL_MS, RETRY_MS, TIMEOUT_MS, DOWN_AFTER, UP_AFTER };
