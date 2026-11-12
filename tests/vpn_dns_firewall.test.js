'use strict';

// "Fremden DNS und DoT sperren" (src/services/vpnDnsFirewall.js): the rules it
// asks iptables for, exactly — with a stand-in for iptables that keeps the
// rule set like the real one does (-S, -I at a position, -D, -F, -X, restore
// with --noflush). That the kernel then does what the rules say is shown in
// tests/vpn_dns_firewall_live.test.js (real netfilter, needs root).

require('./helpers/test-env');

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fw = require('../src/services/vpnDnsFirewall');
const { fakeIptables } = require('./helpers/fakeIptables');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-vpndnsfw-'));
const IFACE = 'wg0';
const SERVER = '10.8.0.1';

const opts = (extra = {}) => ({ dir: DIR, iface: IFACE, ...extra });
const want = (peers) => ({ iface: IFACE, serverIp: SERVER, peers });

beforeEach(() => { fw._resetForTest(); fs.rmSync(path.join(DIR, fw.MARKER), { force: true }); });
after(() => { fw._resetForTest(); fs.rmSync(DIR, { recursive: true, force: true }); });

describe('the plan', () => {
  it('the exact rules: port 53 to the server’s DNS, port 853 refused — per filtered device, nothing else', () => {
    const p = fw.plan({ iface: 'wg0', serverIp: '10.8.0.1', peers: ['10.8.0.21', '10.8.0.12'] });
    assert.equal(p.restore, [
      '*nat',
      ':GC_VPNDNS_NAT - [0:0]',
      '-A GC_VPNDNS_NAT -d 10.8.0.1/32 -j RETURN',
      '-A GC_VPNDNS_NAT -s 10.8.0.12/32 -p udp -m udp --dport 53 -j DNAT --to-destination 10.8.0.1:53',
      '-A GC_VPNDNS_NAT -s 10.8.0.12/32 -p tcp -m tcp --dport 53 -j DNAT --to-destination 10.8.0.1:53',
      '-A GC_VPNDNS_NAT -s 10.8.0.21/32 -p udp -m udp --dport 53 -j DNAT --to-destination 10.8.0.1:53',
      '-A GC_VPNDNS_NAT -s 10.8.0.21/32 -p tcp -m tcp --dport 53 -j DNAT --to-destination 10.8.0.1:53',
      'COMMIT',
      '*filter',
      ':GC_VPNDNS_FWD - [0:0]',
      '-A GC_VPNDNS_FWD -s 10.8.0.12/32 -p tcp -m tcp --dport 853 -j REJECT --reject-with tcp-reset',
      '-A GC_VPNDNS_FWD -s 10.8.0.12/32 -p udp -m udp --dport 853 -j REJECT --reject-with icmp-port-unreachable',
      '-A GC_VPNDNS_FWD -s 10.8.0.21/32 -p tcp -m tcp --dport 853 -j REJECT --reject-with tcp-reset',
      '-A GC_VPNDNS_FWD -s 10.8.0.21/32 -p udp -m udp --dport 853 -j REJECT --reject-with icmp-port-unreachable',
      'COMMIT',
      '',
    ].join('\n'));
    assert.deepEqual(p.hooks.map((h) => `${h.table} ${h.chain} ${h.rule.join(' ')}`), [
      'nat PREROUTING -i wg0 -p udp -m udp --dport 53 -j GC_VPNDNS_NAT',
      'nat PREROUTING -i wg0 -p tcp -m tcp --dport 53 -j GC_VPNDNS_NAT',
      'filter FORWARD -i wg0 -p tcp -m tcp --dport 853 -j GC_VPNDNS_FWD',
      'filter FORWARD -i wg0 -p udp -m udp --dport 853 -j GC_VPNDNS_FWD',
    ]);
    assert.deepEqual(p.peers, ['10.8.0.12', '10.8.0.21']);
  });

  it('only what is an IPv4 address gets into a rule; the server itself never is a source', () => {
    const p = fw.plan({ iface: 'wg0', serverIp: '10.8.0.1', peers: ['10.8.0.9', '10.8.0.9', '10.8.0.1', 'fd00::1', '10.8.0.300', '1.1.1.1; rm -rf /', null, 7, '10.8.0.10'] });
    assert.deepEqual(p.peers, ['10.8.0.9', '10.8.0.10']);
    assert.doesNotMatch(p.restore, /rm -rf|fd00|300/);
    assert.throws(() => fw.plan({ iface: 'wg0; reboot', serverIp: '10.8.0.1', peers: [] }), /interface/);
    assert.throws(() => fw.plan({ iface: 'wg0', serverIp: 'server', peers: [] }), /server address/);
    assert.throws(() => fw.plan({ iface: '', serverIp: '10.8.0.1', peers: [] }), /interface/);
    // no device: the chains exist and are empty (but for the server's own address)
    assert.equal(fw.plan(want([])).restore, '*nat\n:GC_VPNDNS_NAT - [0:0]\n-A GC_VPNDNS_NAT -d 10.8.0.1/32 -j RETURN\nCOMMIT\n*filter\n:GC_VPNDNS_FWD - [0:0]\nCOMMIT\n');
  });

  it('the script that clears the rules at container start and stop names the same jumps and chains', () => {
    const sh = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'vpndns-firewall-clear.sh'), 'utf8');
    for (const h of fw.hooks('$IFACE')) {
      assert.ok(sh.includes(`del ${h.table} ${h.chain} ${h.rule.join(' ').replace('-i $IFACE', '-i "$IFACE"')}`), `${h.table} ${h.chain} ${h.rule.join(' ')}`);
    }
    assert.ok(sh.includes(`drop nat ${fw.NAT_CHAIN}`) && sh.includes(`drop filter ${fw.FWD_CHAIN}`));
    for (const f of ['entrypoint.sh', path.join('scripts', 'wg-wrapper.sh')]) {
      assert.match(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), /vpndns-firewall-clear\.sh/, f);
    }
  });
});

describe('applied to the firewall', () => {
  it('the jumps go to the top — the one in FORWARD before wg-quick’s ACCEPT — and nothing foreign is touched', async () => {
    const ipt = fakeIptables();
    fw._setExecForTest(ipt.exec);
    await fw.sync(want(['10.8.0.12']), opts());
    assert.deepEqual(ipt.tables.filter.FORWARD, [
      '-i wg0 -p tcp -m tcp --dport 853 -j GC_VPNDNS_FWD',
      '-i wg0 -p udp -m udp --dport 853 -j GC_VPNDNS_FWD',
      '-i wg0 -j ACCEPT',
      '-i eth0 -o wg0 -m state --state RELATED,ESTABLISHED -j ACCEPT',
    ]);
    assert.deepEqual(ipt.tables.nat.PREROUTING, ['-i wg0 -p udp -m udp --dport 53 -j GC_VPNDNS_NAT', '-i wg0 -p tcp -m tcp --dport 53 -j GC_VPNDNS_NAT']);
    assert.deepEqual(ipt.tables.nat.POSTROUTING, ['-s 10.8.0.0/24 -o eth0 -j MASQUERADE']);
    assert.equal(ipt.tables.nat.GC_VPNDNS_NAT.length, 3);
    assert.equal(ipt.tables.filter.GC_VPNDNS_FWD.length, 2);
    assert.deepEqual([fw.status().active, fw.status().devices, fw.status().error], [true, 1, null]);
    assert.ok(Date.parse(fw.status().since) > 0);
    assert.ok(fs.existsSync(path.join(DIR, fw.MARKER)));
    assert.equal(ipt.calls[0], 'iptables-restore -w 5 --noflush');
  });

  it('nothing changed → no command; other devices → the chains are refilled in one go, the jumps stay', async () => {
    const ipt = fakeIptables();
    fw._setExecForTest(ipt.exec);
    await fw.sync(want(['10.8.0.12']), opts());
    const n = ipt.calls.length;
    await fw.sync(want(['10.8.0.12']), opts());
    assert.equal(ipt.calls.length, n, 'the same devices: nothing runs');
    await fw.sync(want(['10.8.0.21', '10.8.0.30']), opts());
    assert.deepEqual(ipt.tables.filter.GC_VPNDNS_FWD.map((r) => r.split(' ')[1]), ['10.8.0.21/32', '10.8.0.21/32', '10.8.0.30/32', '10.8.0.30/32']);
    assert.doesNotMatch(ipt.tables.nat.GC_VPNDNS_NAT.join('\n'), /10\.8\.0\.12/);
    assert.equal(ipt.tables.filter.FORWARD.filter((r) => r.includes('GC_VPNDNS_FWD')).length, 2, 'not hooked twice');
    assert.equal(ipt.calls.filter((c) => c.includes(' -I ')).length, 4, 'the jumps were inserted once');
    assert.equal(fw.status().devices, 2);
  });

  it('WireGuard was restarted (its ACCEPT is first again) → the check puts the jumps back to the top', async () => {
    const ipt = fakeIptables();
    fw._setExecForTest(ipt.exec);
    await fw.sync(want(['10.8.0.12']), opts());
    // wg-quick down/up: PostDown deletes its rules, PostUp inserts them at 1 and 2
    ipt.tables.filter.FORWARD = ['-i wg0 -j ACCEPT', '-i eth0 -o wg0 -m state --state RELATED,ESTABLISHED -j ACCEPT', ...ipt.tables.filter.FORWARD.filter((r) => r.includes('GC_VPNDNS'))];
    await fw.sync(want(['10.8.0.12']), opts());
    assert.equal(ipt.tables.filter.FORWARD[0], '-i wg0 -j ACCEPT', 'without the check nothing is looked at');
    await fw.sync(want(['10.8.0.12']), opts({ check: true }));
    assert.deepEqual(ipt.tables.filter.FORWARD.slice(0, 3), ['-i wg0 -p tcp -m tcp --dport 853 -j GC_VPNDNS_FWD', '-i wg0 -p udp -m udp --dport 853 -j GC_VPNDNS_FWD', '-i wg0 -j ACCEPT']);
    assert.equal(ipt.tables.filter.FORWARD.length, 4);
    // a jump that went missing (somebody flushed PREROUTING) comes back as well
    ipt.tables.nat.PREROUTING = ['-i wg0 -p tcp -m tcp --dport 53 -j GC_VPNDNS_NAT'];
    await fw.sync(want(['10.8.0.12']), opts({ check: true }));
    assert.deepEqual(ipt.tables.nat.PREROUTING, ['-i wg0 -p udp -m udp --dport 53 -j GC_VPNDNS_NAT', '-i wg0 -p tcp -m tcp --dport 53 -j GC_VPNDNS_NAT']);
  });

  it('switched off → the jumps and both chains are gone, every foreign rule is still there', async () => {
    const ipt = fakeIptables();
    fw._setExecForTest(ipt.exec);
    await fw.sync(want(['10.8.0.12', '10.8.0.21']), opts());
    await fw.sync(null, opts());
    assert.deepEqual(ipt.tables, {
      nat: { PREROUTING: [], POSTROUTING: ['-s 10.8.0.0/24 -o eth0 -j MASQUERADE'] },
      filter: { INPUT: [], FORWARD: ['-i wg0 -j ACCEPT', '-i eth0 -o wg0 -m state --state RELATED,ESTABLISHED -j ACCEPT'] },
    });
    assert.deepEqual(fw.status(), { active: false, devices: 0, since: null, error: null });
    assert.equal(fs.existsSync(path.join(DIR, fw.MARKER)), false);
  });

  it('never used → not one iptables command; rules left by a server that died are taken away at the next start', async () => {
    const ipt = fakeIptables();
    fw._setExecForTest(ipt.exec);
    await fw.sync(null, opts());
    assert.deepEqual(ipt.calls, []);
    // the server before applied rules and was killed: only the marker tells
    await fw.sync(want(['10.8.0.12']), opts());
    fw._resetForTest();
    fw._setExecForTest(ipt.exec);
    assert.ok(fs.existsSync(path.join(DIR, fw.MARKER)));
    await fw.sync(null, opts());
    assert.equal(ipt.tables.nat.GC_VPNDNS_NAT, undefined);
    assert.equal(ipt.tables.filter.GC_VPNDNS_FWD, undefined);
    assert.deepEqual(ipt.tables.nat.PREROUTING, []);
    assert.equal(fs.existsSync(path.join(DIR, fw.MARKER)), false);
  });

  it('iptables refuses → reported, nothing half-way stays behind, the next round tries again', async () => {
    let broken = true;
    const ipt = fakeIptables({ failOn: (cmd, args) => broken && cmd === 'iptables' && args.includes('-I') && args.includes('FORWARD') });
    fw._setExecForTest(ipt.exec);
    await fw.sync(want(['10.8.0.12']), opts());
    assert.equal(fw.status().active, false);
    assert.match(fw.status().error, /Permission denied/);
    assert.equal(ipt.tables.nat.GC_VPNDNS_NAT, undefined, 'what was set is taken away again');
    assert.deepEqual(ipt.tables.nat.PREROUTING, []);
    assert.deepEqual(ipt.tables.filter.FORWARD, ['-i wg0 -j ACCEPT', '-i eth0 -o wg0 -m state --state RELATED,ESTABLISHED -j ACCEPT']);
    broken = false;
    await fw.sync(want(['10.8.0.12']), opts());
    assert.deepEqual([fw.status().active, fw.status().error], [true, null]);
    // no iptables at all
    fw._resetForTest();
    fw._setExecForTest(async () => ({ code: 1, stdout: '', stderr: 'spawn iptables-restore ENOENT' }));
    await fw.sync(want(['10.8.0.12']), opts());
    assert.match(fw.status().error, /ENOENT/);
    assert.equal(fw.status().active, false);
  });
});
