'use strict';

// "Fremden DNS und DoT sperren" of the DNS protection for VPN devices
// (services/vpnDns.js, setting `blockForeignDns`, off by default).
//
// A device that is filtered could simply ask another DNS server. With the
// option on, the server's firewall takes that way out — for exactly the
// devices the protection filters right now, and for nobody else:
//
//   port 53 (UDP and TCP) to any address but the server's own
//       → rewritten to the server's DNS (DNAT). The device gets its answer
//         from dnsmasq, i.e. filtered with its own profile; it does not
//         notice the difference.
//   port 853 (DNS over TLS / "Privates DNS" of Android, DNS over QUIC)
//       → refused at once (TCP reset / ICMP port unreachable), so a device
//         in the automatic mode falls back to plain DNS without waiting.
//
// Never touched: devices with a DNS server of their own, excluded devices,
// gateways and the networks behind them (only the tunnel addresses of the
// filtered peers are named as sources), the server's own traffic (the rules
// sit in PREROUTING / FORWARD and only match packets that come IN on the
// WireGuard interface).
//
// The server sets its firewall rules with plain `iptables` (entrypoint.sh, the
// PostUp lines of wg0.conf); so does this module, in two chains of its own so
// that everything it ever added can be taken away again without touching a
// foreign rule:
//
//   nat     GC_VPNDNS_NAT   ← PREROUTING -i <wg> -p udp|tcp --dport 53
//   filter  GC_VPNDNS_FWD   ← FORWARD    -i <wg> -p tcp|udp --dport 853
//
// The chains are filled with ONE `iptables-restore --noflush` (atomic per
// table: never a moment with half the devices). The jump in FORWARD has to
// stand before wg-quick's `-i <wg> -j ACCEPT`, which is inserted at position 1
// again whenever the interface is restarted — ensureHooks() puts the jumps
// back to the top (after a WireGuard restart and once a minute).
//
// IPv6: the VPN hands out IPv4 addresses only, there is nothing to rewrite.
// DNS over HTTPS cannot be told from any other HTTPS on the network level —
// see docs/feature-vpn-dns-filter.md "Blocking foreign DNS".
//
// Whatever fails here (no iptables, no permission) is reported in the status
// and logged once; it never stands in the way of name resolution — without the
// rules the devices simply are where they were before the option existed.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');

const NAT_CHAIN = 'GC_VPNDNS_NAT';
const FWD_CHAIN = 'GC_VPNDNS_FWD';
const MARKER = 'firewall.json';
const IFACE_RE = /^[A-Za-z0-9_.-]{1,15}$/;
const LOCK_WAIT_S = '5';
const CMD_TIMEOUT_MS = 10000;
const MAX_PEERS = 4096;

function logger() { return require('../utils/logger'); }

function ipv4s(list) {
  const out = [];
  for (const ip of Array.isArray(list) ? list : []) if (typeof ip === 'string' && net.isIPv4(ip) && !out.includes(ip)) out.push(ip);
  return out.sort((a, b) => num(a) - num(b)).slice(0, MAX_PEERS);
}

function num(ip) { return ip.split('.').reduce((a, o) => a * 256 + Number(o), 0); }

/** The jumps into the two chains: [{ table, chain, rule: [iptables arguments] }]. */
function hooks(iface) {
  return [
    { table: 'nat', chain: 'PREROUTING', rule: ['-i', iface, '-p', 'udp', '-m', 'udp', '--dport', '53', '-j', NAT_CHAIN] },
    { table: 'nat', chain: 'PREROUTING', rule: ['-i', iface, '-p', 'tcp', '-m', 'tcp', '--dport', '53', '-j', NAT_CHAIN] },
    { table: 'filter', chain: 'FORWARD', rule: ['-i', iface, '-p', 'tcp', '-m', 'tcp', '--dport', '853', '-j', FWD_CHAIN] },
    { table: 'filter', chain: 'FORWARD', rule: ['-i', iface, '-p', 'udp', '-m', 'udp', '--dport', '853', '-j', FWD_CHAIN] },
  ];
}

/**
 * What the firewall has to look like for these devices.
 *   iface     the WireGuard interface (GC_WG_INTERFACE)
 *   serverIp  the server's address in the VPN — where its DNS answers
 *   peers     tunnel addresses of the devices that are filtered right now
 * → { key, iface, serverIp, peers, hooks, restore } — `restore` is the input
 *   of `iptables-restore --noflush` (naming a chain there empties it first).
 * Throws on an interface name or server address that is none: nothing of it
 * may reach a command line unchecked.
 */
function plan({ iface, serverIp, peers }) {
  if (typeof iface !== 'string' || !IFACE_RE.test(iface)) throw new Error('vpn dns firewall: invalid interface name');
  if (typeof serverIp !== 'string' || !net.isIPv4(serverIp)) throw new Error('vpn dns firewall: invalid server address');
  const list = ipv4s(peers).filter((ip) => ip !== serverIp);
  const nat = [`:${NAT_CHAIN} - [0:0]`, `-A ${NAT_CHAIN} -d ${serverIp}/32 -j RETURN`];
  const fwd = [`:${FWD_CHAIN} - [0:0]`];
  for (const ip of list) {
    nat.push(`-A ${NAT_CHAIN} -s ${ip}/32 -p udp -m udp --dport 53 -j DNAT --to-destination ${serverIp}:53`);
    nat.push(`-A ${NAT_CHAIN} -s ${ip}/32 -p tcp -m tcp --dport 53 -j DNAT --to-destination ${serverIp}:53`);
    fwd.push(`-A ${FWD_CHAIN} -s ${ip}/32 -p tcp -m tcp --dport 853 -j REJECT --reject-with tcp-reset`);
    fwd.push(`-A ${FWD_CHAIN} -s ${ip}/32 -p udp -m udp --dport 853 -j REJECT --reject-with icmp-port-unreachable`);
  }
  const restore = ['*nat', ...nat, 'COMMIT', '*filter', ...fwd, 'COMMIT', ''].join('\n');
  return { key: `${iface}|${serverIp}|${list.join(',')}`, iface, serverIp, peers: list, hooks: hooks(iface), restore };
}

// ─── Running iptables ──────────────────────────────────────────────────

/** exec(cmd, args, stdin?) → { code, stdout, stderr }; never rejects. Replaceable (tests). */
function realExec(cmd, args, stdin) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: CMD_TIMEOUT_MS }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || (err && err.message) || '') });
    });
    child.on('error', () => { /* reported through the callback */ });
    if (stdin !== undefined && child.stdin) child.stdin.end(stdin);
  });
}

const state = {
  exec: realExec,
  applied: null,       // key of the plan in force
  active: false,
  peers: 0,
  since: null,
  error: null,
  checkedAt: 0,
  busy: Promise.resolve(),
};

function ipt(table, ...args) { return state.exec('iptables', ['-w', LOCK_WAIT_S, '-t', table, ...args]); }

function markerPath(dir) { return path.join(dir, MARKER); }

/** The positions (1-based) of rules in `iptables -S <chain>` output that equal `rule`. */
function positionsOf(listing, chain, rule) {
  const want = `-A ${chain} ${rule.join(' ')}`;
  const out = [];
  let n = 0;
  for (const line of String(listing || '').split('\n')) {
    if (!line.startsWith('-A ')) continue;
    n += 1;
    if (line.trim() === want) out.push(n);
  }
  return out;
}

/**
 * The jumps exist once each and stand at the top of their chain, in order.
 * Anything else (missing, twice, pushed down by a rule somebody inserted
 * above) is put right: ours are taken out and inserted at the top again.
 */
async function ensureHooks(p) {
  for (const [table, chain] of [['nat', 'PREROUTING'], ['filter', 'FORWARD']]) {
    const mine = p.hooks.filter((h) => h.table === table && h.chain === chain);
    const res = await ipt(table, '-S', chain);
    if (res.code !== 0) throw new Error(`iptables -t ${table} -S ${chain}: ${res.stderr.trim().slice(0, 200) || 'failed'}`);
    const pos = mine.map((h) => positionsOf(res.stdout, chain, h.rule));
    if (pos.every((list, i) => list.length === 1 && list[0] === i + 1)) continue;
    for (const h of mine) await removeHook(h);
    for (let i = 0; i < mine.length; i++) {
      const r = await ipt(table, '-I', chain, String(i + 1), ...mine[i].rule);
      if (r.code !== 0) throw new Error(`iptables -t ${table} -I ${chain}: ${r.stderr.trim().slice(0, 200) || 'failed'}`);
    }
  }
}

async function removeHook(h) {
  // -D takes one rule at a time; more than a few of the same never exist
  for (let i = 0; i < 8; i++) if ((await ipt(h.table, '-D', h.chain, ...h.rule)).code !== 0) break;
}

async function applyPlan(p, dir) {
  // The marker first: should the server die half-way, the next start knows there is something to take away.
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(markerPath(dir), JSON.stringify({ iface: p.iface, at: Date.now() }), { mode: 0o600 }); } catch { /* cleared by entrypoint.sh anyway */ }
  const r = await state.exec('iptables-restore', ['-w', LOCK_WAIT_S, '--noflush'], p.restore);
  if (r.code !== 0) throw new Error(`iptables-restore: ${r.stderr.trim().slice(0, 200) || 'failed'}`);
  await ensureHooks(p);
}

/** Take everything away again: the jumps, then the chains. Missing pieces are no error. */
async function clearRules(iface) {
  if (typeof iface !== 'string' || !IFACE_RE.test(iface)) return;
  for (const h of hooks(iface)) await removeHook(h);
  for (const [table, chain] of [['nat', NAT_CHAIN], ['filter', FWD_CHAIN]]) {
    await ipt(table, '-F', chain);
    await ipt(table, '-X', chain);
  }
}

function fail(err, what) {
  const msg = String((err && err.message) || err).slice(0, 300);
  if (state.error !== msg) logger().warn({ err: msg }, `vpn dns firewall: ${what} — foreign DNS is not blocked`);
  state.error = msg;
}

/**
 * Bring the firewall in line: `want` = { iface, serverIp, peers } or null (no
 * rules). One run at a time; resolves when it is done, never rejects.
 *   dir    the state directory of the DNS protection (marker file)
 *   iface  the WireGuard interface, also needed to take the rules away
 *   check  true: look at the jumps even when nothing changed
 */
function sync(want, { dir, iface, check = false, now = Date.now() } = {}) {
  const run = async () => {
    if (!want) {
      // Nothing was ever applied by this process and no marker: a server that
      // never used the option runs no iptables command at all.
      let marked = false;
      try { marked = fs.existsSync(markerPath(dir)); } catch { marked = false; }
      if (state.applied === null && !state.active && !marked) return;
      try {
        await clearRules(iface);
        try { fs.rmSync(markerPath(dir), { force: true }); } catch { /* gone */ }
        Object.assign(state, { applied: null, active: false, peers: 0, since: null, error: null });
      } catch (e) { fail(e, 'rules not removed'); }
      return;
    }
    let p;
    try { p = plan(want); } catch (e) { fail(e, 'no rules'); return; }
    try {
      if (p.key !== state.applied) {
        await applyPlan(p, dir);
        Object.assign(state, { applied: p.key, active: true, peers: p.peers.length, since: state.active && state.since ? state.since : now, error: null, checkedAt: now });
      } else if (check) {
        await ensureHooks(p);
        state.checkedAt = now;
        state.error = null;
      }
    } catch (e) {
      // Half a rule set helps nobody: take away what there is and try again with the next round.
      fail(e, 'rules not set');
      try { await clearRules(p.iface); } catch { /* reported above */ }
      Object.assign(state, { applied: null, active: false, peers: 0, since: null });
    }
  };
  state.busy = state.busy.then(run, run);
  return state.busy;
}

/** { active, devices, since, error } — what the status of the DNS protection shows. */
function status() {
  return { active: state.active, devices: state.peers, since: state.since ? new Date(state.since).toISOString() : null, error: state.error };
}

function _setExecForTest(fn) { state.exec = fn || realExec; }
function _resetForTest() { Object.assign(state, { exec: realExec, applied: null, active: false, peers: 0, since: null, error: null, checkedAt: 0, busy: Promise.resolve() }); }

module.exports = { NAT_CHAIN, FWD_CHAIN, MARKER, plan, hooks, sync, status, positionsOf, clearRules, _state: state, _setExecForTest, _resetForTest };
