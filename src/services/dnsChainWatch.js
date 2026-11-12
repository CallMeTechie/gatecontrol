'use strict';

const nodeDns = require('node:dns');
const { buildDnsToken } = require('./dnsChainConf');

let logger;
try {
  logger = require('../utils/logger');
} catch {
  logger = { info: () => {}, warn: () => {} };
}

// Default probe cadence and hysteresis (a provider may bring its own). A dead
// upstream is noticed after DOWN_AFTER failed rounds, the second one RETRY_MS
// after the first: at most INTERVAL_MS + TIMEOUT_MS + RETRY_MS + TIMEOUT_MS =
// 9 s, then dnsmasq restarts (well under 1 s, scripts/wg-wrapper.sh). Going
// back takes UP_AFTER good rounds in a row, so a flapping resolver does not
// restart dnsmasq every few seconds. These defaults suit a resolver somewhere
// in the network, where every probe is a query in its own statistics; the
// local filter service brings a faster cadence (services/dnsChain.js).
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
 * createChainWatch(deps) — keeps the managed DNS chain usable.
 *
 * A chain (dnsChainConf) makes the DNS targets of ONE provider the only
 * upstreams of dnsmasq, so a dead target means no name resolution for any
 * VPN device. This watch asks every target's DNS port directly every few
 * seconds — independent of any sync interval or API, which can be up while
 * the resolver is down and the other way round — and
 *   - reverts dnsmasq to the default upstreams once NO target answers,
 *   - applies the chain again once a target answers reliably.
 * While at least one target answers, the default upstreams are not in the
 * conf at all: nothing gets past the filter.
 *
 * Exactly one provider owns the chain: the first one in `providers()` (rank
 * order) that names targets. The others are "displaced" — never probed,
 * never written. When the owner changes, the new one is asked first and its
 * chain replaces the old one in a single dnsmasq restart; the default
 * upstreams only come in when the new owner does not answer.
 *
 * deps:
 *   providers()   → provider[] in rank order (highest first)
 *   chain         → { apply(tokens, { provider, ecs }), revert() }
 *   onChange(status) — every change of owner or state
 *   now()         → ms, injectable for tests
 *
 * provider:
 *   id            'vpnfilter' | …  (also the name of its active state)
 *   label         for log lines
 *   ecs           forward the client address to the targets (default true)
 *   targets()     → [{ id, label, dns_ip, dns_port }]; none = chain not wanted
 *   probe(target) → Promise<boolean> (default: probeDns with timeoutMs)
 *   intervalMs, retryMs, timeoutMs, downAfter, upAfter — default: see above
 *   onChange(state, status) — called on <id> ⇄ fallback transitions
 */
function createChainWatch(deps) {
  const {
    providers,
    chain,
    onChange = () => {},
    now = () => Date.now(),
    intervalMs = INTERVAL_MS,
  } = deps;

  // 'off' (no provider wants the chain) | 'active' | 'fallback'
  let state = 'off';
  let owner = null;
  let since = null;
  let fails = 0;
  let oks = 0;
  let targets = [];
  let displaced = [];
  let checkedAt = null;
  let timer = null;
  let inflight = null;
  let lastError = null;
  let stopped = true;

  const opt = (p, key, fallback) => (p[key] === undefined ? fallback : p[key]);

  function status() {
    return { provider: owner ? owner.id : null, state, since, checkedAt, targets, displaced };
  }

  // What one provider sees: state 'off' | '<id>' | 'fallback'.
  function statusFor(id) {
    if (owner && owner.id === id) return { state: state === 'active' ? id : 'fallback', since, checkedAt, targets };
    if (owner) return { state: 'off', since, checkedAt: null, targets: [], displacedBy: owner.id };
    return { state: 'off', since, checkedAt, targets: [] };
  }

  function setState(provider, next) {
    if (state === next) return;
    const prev = state;
    state = next;
    owner = next === 'off' ? null : provider;
    since = now();
    fails = 0;
    oks = 0;
    if (next === 'off') targets = [];
    try { onChange(status()); } catch (err) { logger.warn({ err: err.message }, 'dns chain watch: onChange failed'); }
    if (next === 'off') return;
    if (prev === 'off' && next === 'active') return; // switched on by the admin, not a recovery
    if (typeof provider.onChange !== 'function') return;
    try { provider.onChange(next === 'active' ? provider.id : next, statusFor(provider.id)); }
    catch (err) { logger.warn({ err: err.message }, `${provider.id} dns watch: onChange failed`); }
  }

  // The provider that owns the chain right now: the highest-ranked one that
  // names at least one usable DNS target.
  function wanted() {
    const all = [];
    for (const provider of providers()) {
      const probed = (provider.targets() || []).filter(buildDnsToken);
      if (probed.length) all.push({ provider, probed, tokens: probed.map(buildDnsToken) });
    }
    return all;
  }

  // One round at a time: a caller that arrives while a round is under way
  // (settings saved, start) gets that round instead of a second one.
  function tick() {
    if (!inflight) inflight = round().finally(() => { inflight = null; });
    return inflight;
  }

  async function round() {
    try {
      const all = wanted();
      displaced = all.slice(1).map((w) => w.provider.id);
      if (!all.length) {
        if (state !== 'off') chain.revert();
        setState(null, 'off');
        return status();
      }
      const { provider, probed, tokens } = all[0];
      const label = provider.label || provider.id;
      const chainOpts = { provider: provider.id, ecs: provider.ecs !== false };

      if (owner && owner.id !== provider.id) {
        // Another provider takes over. Decided afresh below, exactly like a
        // start: the conf keeps the old chain until the new owner was asked.
        logger.info({ from: owner.id, to: provider.id }, 'dns chain watch: owner changes');
        state = 'off';
        owner = null;
        fails = 0;
        oks = 0;
        targets = [];
      }

      const probe = provider.probe || ((target) => probeDns(target, opt(provider, 'timeoutMs', TIMEOUT_MS)));
      const results = await Promise.all(probed.map((inst) => Promise.resolve()
        .then(() => probe(inst)).then(Boolean, () => false)));
      const probedTargets = probed.map((inst, i) => ({ id: inst.id, label: inst.label || '', dns: buildDnsToken(inst), ok: results[i] }));
      const anyOk = results.some(Boolean);

      if (state === 'off') {
        // Process start, freshly enabled or taken over: nothing is known yet,
        // so there is no hysteresis to wait for — a chain that does not answer
        // must not be (or stay) the only upstream. apply()/revert() are idempotent.
        if (anyOk) {
          chain.apply(tokens, chainOpts);
          targets = probedTargets;
          checkedAt = now();
          setState(provider, 'active');
        } else {
          chain.revert();
          targets = probedTargets;
          checkedAt = now();
          logger.warn({ targets: tokens }, `${provider.id} dns watch: no ${label} DNS answers — dnsmasq uses the default upstreams`);
          setState(provider, 'fallback');
        }
        return status();
      }

      targets = probedTargets;
      checkedAt = now();
      if (state === 'active') {
        fails = anyOk ? 0 : fails + 1;
        if (fails >= opt(provider, 'downAfter', DOWN_AFTER)) {
          chain.revert();
          logger.warn({ targets: tokens }, `${provider.id} dns watch: no ${label} DNS answers — dnsmasq falls back to the default upstreams`);
          setState(provider, 'fallback');
        }
      } else if (state === 'fallback') {
        oks = anyOk ? oks + 1 : 0;
        if (oks >= opt(provider, 'upAfter', UP_AFTER)) {
          chain.apply(tokens, chainOpts);
          logger.info({ targets: tokens }, `${provider.id} dns watch: ${label} DNS answers again — chain applied`);
          setState(provider, 'active');
        }
      }
    } catch (err) {
      // e.g. no dnsmasq.conf on this host: say it once, not every round
      if (lastError !== err.message) logger.warn({ err: err.message }, 'dns chain watch round failed');
      lastError = err.message;
      return status();
    }
    lastError = null;
    return status();
  }

  // Self-rescheduling instead of setInterval: a slow round (probe timeout)
  // never overlaps the next one.
  function schedule() {
    if (stopped) return;
    // A failed round is confirmed (or cleared) quickly instead of a full interval later.
    const delay = !owner ? intervalMs
      : (state === 'active' && fails > 0) ? opt(owner, 'retryMs', RETRY_MS) : opt(owner, 'intervalMs', INTERVAL_MS);
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

  return { tick, status, statusFor, wanted, start, stop };
}

module.exports = { createChainWatch, probeDns, INTERVAL_MS, RETRY_MS, TIMEOUT_MS, DOWN_AFTER, UP_AFTER };
