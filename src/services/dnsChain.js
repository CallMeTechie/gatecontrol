'use strict';

const { makeChain } = require('./dnsChainConf');
const { createChainWatch } = require('./dnsChainWatch');

/**
 * The DNS chain of the VPN — the ONE owner of dnsmasq's upstream `server=`
 * lines (and of `add-subnet`). Whoever wants the DNS of the VPN devices to go
 * through a filter registers here as a provider; nobody else writes those
 * lines or restarts dnsmasq for them.
 *
 * Providers, highest rank first. Exactly one of them is active at a time: the
 * first one that names DNS targets. A lower one is displaced until the higher
 * one is switched off — it is not a second fallback: when the active
 * provider's DNS does not answer, dnsmasq goes back to the default upstreams
 * (GC_DNSMASQ_UPSTREAMS), never to another filter.
 *   vpnfilter — GateControl's own filter service on 127.0.0.1#<port>
 *   pihole    — the Pi-hole instances (services/pihole.js)
 */
const RANK = ['vpnfilter', 'pihole'];

// Cadence for the local filter service: no foreign statistics to spoil and no
// network in between, so it is asked more often and with a shorter timeout
// than Pi-hole. Dead filter → default upstreams after at most
// 2000 + 1000 + 500 + 1000 ms, then one dnsmasq restart.
const VPNFILTER_INTERVAL_MS = 2000;
const VPNFILTER_RETRY_MS = 500;
const VPNFILTER_TIMEOUT_MS = 1000;
const VPNFILTER_PORT = 5354;

const providers = new Map();
const listeners = new Set();
let chain = null;
let watch = null;

function log() {
  return require('../utils/logger');
}

function init() {
  if (watch) return;
  chain = makeChain({
    confPath: process.env.GC_DNSMASQ_CONF || '/app/config/dnsmasq.conf',
    defaults: (process.env.GC_DNSMASQ_UPSTREAMS || '1.1.1.1,8.8.8.8').split(','),
    // Chain apply/revert changes upstream `server=` lines, which dnsmasq only
    // picks up on a real restart (SIGHUP is insufficient) — use restartDnsmasq.
    reload: () => {
      const dns = require('./dns');
      if (typeof dns.restartDnsmasq === 'function') dns.restartDnsmasq();
    },
  });
  watch = createChainWatch({
    providers: () => RANK.map((id) => providers.get(id)).filter(Boolean),
    chain,
    onChange: (status) => {
      for (const fn of listeners) {
        try { fn(status); } catch (err) { log().warn({ err: err.message }, 'dns chain: listener failed'); }
      }
    },
  });
}

/**
 * Register (or replace) a provider. See dnsChainWatch.js for its fields.
 * The id decides the rank — only the providers named in RANK exist.
 */
function register(provider) {
  if (!provider || !RANK.includes(provider.id)) throw new Error('dns chain: unknown provider');
  if (typeof provider.targets !== 'function') throw new Error('dns chain: provider without targets()');
  providers.set(provider.id, provider);
}

/**
 * A provider's wishes changed (settings saved, service switched on or off).
 *   - nobody wants the chain: default upstreams, at once;
 *   - the active provider only changed its addresses: taken over at once
 *     (they are known to answer);
 *   - otherwise the watch asks the wanted provider's DNS first and only then
 *     makes it the upstream — a resolver that does not answer must never
 *     become the only one.
 */
function refresh() {
  init();
  try {
    const want = watch.wanted()[0];
    const now = watch.status();
    if (!want) {
      chain.revert();
    } else if (now.state === 'active' && now.provider === want.provider.id) {
      chain.apply(want.tokens, { provider: want.provider.id, ecs: want.provider.ecs !== false });
      return;
    }
    watch.tick().catch(() => { /* tick() logs and never rejects */ });
  } catch (err) {
    log().warn({ err: err.message }, 'dns chain refresh failed (conf missing?)');
  }
}

/**
 * { provider: 'vpnfilter'|'pihole'|null, state: 'off'|'active'|'fallback',
 *   since, checkedAt, targets: [{ id, label, dns, ok }], displaced: [ids] }
 */
function status() {
  init();
  return watch.status();
}

/** One provider's view: { state: 'off'|'<id>'|'fallback', since, checkedAt, targets[, displacedBy] }. */
function statusFor(id) {
  init();
  return watch.statusFor(id);
}

/** One probe round now; resolves with status(). Never rejects. */
function tick() {
  init();
  return watch.tick();
}

/** fn(status) on every change of owner or state. Returns the unsubscribe function. */
function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function start() {
  init();
  watch.start();
}

function stop() {
  if (watch) watch.stop();
}

// ─── Provider 'vpnfilter' ────────────────────────────────────────────────────
// Prepared for the filter service of the DNS protection: only the chain side
// lives here. Off until enable() is called; nothing is persisted — the
// service says on every start whether it wants the chain.
//
// Measured with dnsmasq 2.91 (the version in the image): with add-subnet
// dnsmasq caches nothing, so one device never gets another one's answer from
// the cache — but identical UDP queries that are under way at the same time
// are merged into one upstream query and the single answer goes to all of
// them. The filter therefore has to answer over UDP with TC=1 whenever its
// answer depends on who asks; the devices then repeat over TCP, which dnsmasq
// forwards one by one with the right client address.
const vpnFilterState = { enabled: false, port: VPNFILTER_PORT, onChange: null };

register({
  id: 'vpnfilter',
  label: 'filter service',
  ecs: true,
  targets: () => (vpnFilterState.enabled
    ? [{ id: 'vpnfilter', label: '', dns_ip: '127.0.0.1', dns_port: vpnFilterState.port }]
    : []),
  intervalMs: VPNFILTER_INTERVAL_MS,
  retryMs: VPNFILTER_RETRY_MS,
  timeoutMs: VPNFILTER_TIMEOUT_MS,
  onChange: (state, st) => { if (vpnFilterState.onChange) vpnFilterState.onChange(state, st); },
});

const vpnFilter = {
  /**
   * The filter service listens on 127.0.0.1#port and wants the chain.
   * onChange(state, status) is called on vpnfilter ⇄ fallback transitions.
   */
  enable({ port = VPNFILTER_PORT, onChange = null } = {}) {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535 || p === 53) throw new Error('dns chain: invalid filter port');
    vpnFilterState.enabled = true;
    vpnFilterState.port = p;
    vpnFilterState.onChange = typeof onChange === 'function' ? onChange : null;
    refresh();
  },
  disable() {
    vpnFilterState.enabled = false;
    vpnFilterState.onChange = null;
    refresh();
  },
  status: () => statusFor('vpnfilter'),
};

module.exports = { RANK, register, refresh, status, statusFor, tick, onChange, start, stop, vpnFilter, VPNFILTER_PORT };
