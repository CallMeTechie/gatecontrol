'use strict';

// public/js/gateway-kit.js — the pure helpers of the gateway assistant
// (docs/feature-gateway-wizard.md): input checks of the Raspberry-Pi step,
// settings.txt per the Pi-image contract, the stored ZIP writer the browser
// builds gatecontrol-setup.zip with (and the server the Synology package),
// the onboarding compose.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const kit = require('../public/js/gateway-kit');
const { unzip } = require('./helpers/unzip');

function sshString(buf) { const l = Buffer.alloc(4); l.writeUInt32BE(buf.length); return Buffer.concat([l, buf]); }
function mpint(buf) { let b = buf; if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return sshString(b); }
function ed25519Line() {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const x = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return 'ssh-ed25519 ' + Buffer.concat([sshString(Buffer.from('ssh-ed25519')), sshString(x)]).toString('base64') + ' admin@laptop';
}
function rsaLine(bits) {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits });
  const j = publicKey.export({ format: 'jwk' });
  const blob = Buffer.concat([sshString(Buffer.from('ssh-rsa')), mpint(Buffer.from(j.e, 'base64url')), mpint(Buffer.from(j.n, 'base64url'))]);
  return 'ssh-rsa ' + blob.toString('base64');
}

describe('input checks (WLAN, host name, SSH key)', () => {
  it('SSID: 1–32 bytes UTF-8, no control characters, no edge spaces/quotes', () => {
    assert.equal(kit.checkSsid('FRITZ!Box 7590 XY'), null);
    assert.equal(kit.checkSsid('Café #1 = gut'), null);
    assert.equal(kit.checkSsid(''), 'ssid_required');
    assert.equal(kit.checkSsid('a'.repeat(32)), null);
    assert.equal(kit.checkSsid('a'.repeat(33)), 'ssid_too_long');
    assert.equal(kit.checkSsid('ä'.repeat(17)), 'ssid_too_long', '34 bytes');
    assert.equal(kit.checkSsid('ä'.repeat(16)), null, '32 bytes');
    assert.equal(kit.checkSsid('line\nbreak'), 'ssid_chars');
    assert.equal(kit.checkSsid(' leading'), 'ssid_chars');
    assert.equal(kit.checkSsid('"quoted"'), 'ssid_chars');
  });
  it('PSK: empty (open), 8–63 printable ASCII or 64 hex', () => {
    assert.equal(kit.checkPsk(''), null);
    assert.equal(kit.checkPsk('12345678'), null);
    assert.equal(kit.checkPsk('1234567'), 'psk_length');
    assert.equal(kit.checkPsk('x'.repeat(63)), null);
    assert.equal(kit.checkPsk('x'.repeat(64)), 'psk_length');
    assert.equal(kit.checkPsk('ab'.repeat(32)), null, '64 hex = raw key');
    assert.equal(kit.checkPsk('passwört123'), 'psk_chars');
    assert.equal(kit.checkPsk('geheim 123 '), 'psk_chars');
  });
  it('host name: one RFC-1123 label', () => {
    assert.equal(kit.checkHostname('gc-pi-keller'), null);
    assert.equal(kit.checkHostname(''), null);
    assert.equal(kit.checkHostname('a'.repeat(63)), null);
    assert.equal(kit.checkHostname('a'.repeat(64)), 'hostname_invalid');
    assert.equal(kit.checkHostname('-pi'), 'hostname_invalid');
    assert.equal(kit.checkHostname('pi-'), 'hostname_invalid');
    assert.equal(kit.checkHostname('pi.keller'), 'hostname_invalid');
    assert.equal(kit.checkHostname('pi_keller'), 'hostname_invalid');
  });
  it('time zone and WLAN country', () => {
    assert.equal(kit.checkTimezone('Europe/Berlin', ['Europe/Berlin']), null);
    assert.equal(kit.checkTimezone('Mars/Olympus', ['Europe/Berlin']), 'timezone_invalid');
    assert.equal(kit.checkTimezone('Europe/Berlin\nX=1'), 'timezone_invalid');
    assert.equal(kit.checkCountry('DE'), null);
    assert.equal(kit.checkCountry('de'), 'country_invalid');
  });
  it('SSH key: ed25519 / rsa ≥ 3072, one line, type matches the blob', () => {
    assert.equal(kit.checkSshKey(''), null);
    assert.equal(kit.checkSshKey(ed25519Line()), null);
    assert.equal(kit.checkSshKey(rsaLine(3072)), null);
    assert.equal(kit.checkSshKey(rsaLine(2048)), 'ssh_rsa_short');
    const ed = ed25519Line();
    assert.equal(kit.checkSshKey(ed.replace('ssh-ed25519', 'ssh-rsa')), 'ssh_invalid', 'type does not match the blob');
    assert.equal(kit.checkSshKey(ed + '\nssh-ed25519 AAAA'), 'ssh_invalid', 'two lines');
    assert.equal(kit.checkSshKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5'), 'ssh_invalid', 'truncated');
    assert.equal(kit.checkSshKey('ssh-rsa AAAAB3NzaC1yc2E'), 'ssh_invalid', 'type only, no key');
    assert.equal(kit.checkSshKey('-----BEGIN OPENSSH PRIVATE KEY-----'), 'ssh_invalid');
  });
  it('suggested host name', () => {
    assert.equal(kit.suggestHostname('Pi Keller'), 'gc-pi-keller');
    assert.equal(kit.suggestHostname('Gartenhäuschen 2'), 'gc-gartenhaeuschen-2');
    assert.equal(kit.suggestHostname('gc-nas'), 'gc-nas');
    assert.equal(kit.checkHostname(kit.suggestHostname('x'.repeat(80))), null);
  });
});

describe('settings.txt (Pi-image contract)', () => {
  it('LAN: HOSTNAME, ZIGBEE, TIMEZONE — no WLAN keys, no SSH', () => {
    const r = kit.buildSettingsTxt({ hostname: 'gc-pi-keller', zigbee: 'auto', timezone: 'Europe/Berlin', network: 'lan' });
    assert.ok(!r.errors);
    const keys = r.text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('=')[0]);
    assert.deepEqual(keys, ['HOSTNAME', 'ZIGBEE', 'TIMEZONE']);
    assert.match(r.text, /^HOSTNAME=gc-pi-keller$/m);
    assert.match(r.text, /^ZIGBEE=auto$/m);
  });
  it('WLAN + SSH: every key once, values unquoted, LF line ends', () => {
    const key = ed25519Line();
    const r = kit.buildSettingsTxt({ hostname: 'gc-pi', zigbee: 'off', timezone: 'Europe/Vienna', network: 'wifi',
      ssid: 'Café #1 = gut', psk: 'geheim123', country: 'AT', hidden: true, sshKey: key });
    assert.ok(!r.errors, JSON.stringify(r.errors));
    const map = {};
    for (const l of r.text.split('\n')) {
      if (!l || l.startsWith('#')) continue;
      const i = l.indexOf('=');
      const k = l.slice(0, i);
      assert.ok(!(k in map), 'once: ' + k);
      map[k] = l.slice(i + 1);
    }
    assert.deepEqual(map, { HOSTNAME: 'gc-pi', ZIGBEE: 'off', TIMEZONE: 'Europe/Vienna', WIFI_SSID: 'Café #1 = gut',
      WIFI_PSK: 'geheim123', WIFI_COUNTRY: 'AT', WIFI_HIDDEN: '1', SSH_AUTHORIZED_KEY: key });
    assert.ok(!r.text.includes('\r'));
  });
  it('open WLAN: WIFI_PSK empty; invalid values → errors per field, no text', () => {
    const open = kit.buildSettingsTxt({ network: 'wifi', ssid: 'Gast', psk: '', country: 'DE' });
    assert.match(open.text, /^WIFI_PSK=$/m);
    const bad = kit.buildSettingsTxt({ hostname: 'bad_name', network: 'wifi', ssid: '', psk: 'short', country: 'Germany', sshKey: 'nope' });
    assert.equal(bad.text, undefined);
    assert.deepEqual(bad.errors, { hostname: 'hostname_invalid', sshKey: 'ssh_invalid', ssid: 'ssid_required', psk: 'psk_length', country: 'country_invalid' });
  });
});

describe('ZIP writer (stored)', () => {
  it('gatecontrol-setup.zip: gatecontrol/gateway.env + settings.txt, readable, CRC ok', () => {
    const env = 'GC_SERVER_URL=https://gc.example\nGC_API_TOKEN=gc_gw_x\n';
    const settings = kit.buildSettingsTxt({ hostname: 'gc-pi', network: 'lan' }).text;
    const zip = kit.piSetupZip(env, settings, new Date(2026, 10, 4, 20, 14, 0));
    const entries = unzip(zip);
    assert.deepEqual(entries.map((e) => e.name), ['gatecontrol/', 'gatecontrol/gateway.env', 'gatecontrol/settings.txt']);
    assert.equal(entries[1].data.toString('utf8'), env);
    assert.equal(entries[2].data.toString('utf8'), settings);
    assert.equal(entries[1].mode & 0o777, 0o600);
    assert.equal(entries[0].mode & 0o170000, 0o040000, 'directory entry');
  });
  it('unzip -t accepts the archive (when unzip is installed)', (t) => {
    if (spawnSync('unzip', ['-v']).status !== 0) { t.skip('no unzip'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-kitzip-'));
    try {
      const f = path.join(dir, 'gatecontrol-setup.zip');
      fs.writeFileSync(f, kit.piSetupZip('A=1\n', 'ZIGBEE=auto\n'));
      const r = spawnSync('unzip', ['-t', f], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const x = spawnSync('unzip', ['-o', f, '-d', path.join(dir, 'out')], { encoding: 'utf8' });
      assert.equal(x.status, 0);
      assert.equal(fs.readFileSync(path.join(dir, 'out', 'gatecontrol', 'settings.txt'), 'utf8'), 'ZIGBEE=auto\n');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses unsafe entry names', () => {
    for (const n of ['../x', '/etc/passwd', 'a/../b', 'a\\b', 'C:x', 'a//b', '']) {
      assert.throws(() => kit.zipStored([{ name: n, data: 'x' }]), /unsafe/, n);
    }
  });
  it('UTF-8 names and an empty file', () => {
    const e = unzip(kit.zipStored([{ name: 'ä.txt', data: '' }]));
    assert.equal(e[0].name, 'ä.txt');
    assert.equal(e[0].data.length, 0);
  });
});

describe('compose and commands', () => {
  it('Synology: wireguard-go (/dev/net/tun), host network, /state volume', () => {
    const c = kit.buildCompose({ platform: 'synology', network: 'host' });
    assert.match(c, /network_mode: host/);
    assert.match(c, /\/dev\/net\/tun:\/dev\/net\/tun/);
    assert.match(c, /\.\/config:\/config:ro/);
    assert.match(c, /\.\/gateway-state:\/state/);
    assert.match(c, /GATEWAY_ENV_PATH=\/config\/gateway\.env/);
  });
  it('Linux bridge: no TUN device, ports published, no host network', () => {
    const c = kit.buildCompose({ platform: 'linux', network: 'bridge' });
    assert.doesNotMatch(c, /network_mode: host/);
    assert.doesNotMatch(c, /\/dev\/net\/tun/);
    assert.match(c, /"8080:8080"/);
    assert.doesNotMatch(c, /\n  edge:|edge-run/, 'edge parts need host network');
  });
  it('host network: the edge service of the gateway contract (same image, user 61001, no privileges) + shared volumes', () => {
    for (const platform of ['synology', 'linux']) {
      const c = kit.buildCompose({ platform, network: 'host' });
      const edge = c.slice(c.indexOf('\n  edge:\n'), c.indexOf('\n  mqtt:\n'));
      assert.match(edge, /image: ghcr\.io\/callmetechie\/gatecontrol-gateway:latest/);
      assert.match(edge, /entrypoint: \["\/sbin\/tini", "--", "node", "src\/edge\/main\.js"\]/);
      assert.match(edge, /user: "61001:61001"/);
      assert.match(edge, /cap_drop:\n {6}- ALL/);
      assert.match(edge, /no-new-privileges:true/);
      assert.match(edge, /read_only: true/);
      assert.match(edge, /network_mode: host/);
      assert.match(edge, /source: edge-run\n {8}target: \/run\/gc-edge\n {8}read_only: true/);
      assert.match(edge, /edge-state:\/state-edge/);
      assert.match(edge, /edge-mqtt:\/gc-mqtt/);
      assert.match(edge, /mem_limit: 512m\n {4}pids_limit: 256/);
      assert.doesNotMatch(edge, /^ +(?:cap_add|privileged|devices):/m);
      const gw = c.slice(0, c.indexOf('\n  edge:\n'));
      assert.match(gw, /source: edge-run\n {8}target: \/run\/gc-edge\n {8}volume: \{ nocopy: true \}/);
      assert.match(gw, /source: edge-status\n {8}target: \/run\/gc-edge-status\n {8}read_only: true/);
      assert.match(c, /\nvolumes:\n(?: {2}# [^\n]*\n)+ {2}edge-run:\n[\s\S]*o: "size=1m,uid=0,gid=61001,mode=2750"[\s\S]*edge-status:[\s\S]*edge-state:\n[\s\S]*edge-mqtt:\n$/);
    }
  });
  it('host network: the mqtt service of the gateway (digest-pinned mosquitto, watcher, user 61001, no privileges)', () => {
    for (const platform of ['synology', 'linux']) {
      const c = kit.buildCompose({ platform, network: 'host' });
      const mqtt = c.slice(c.indexOf('\n  mqtt:\n'), c.indexOf('\nvolumes:\n'));
      assert.match(mqtt, /image: eclipse-mosquitto:2\.1\.2-alpine@sha256:860aeb5d63ce509508f6dcfb2bc8a1c1dd2bc60555b562b45ce90e52d8dabb0f/);
      assert.match(mqtt, /entrypoint:\n {6}- \/bin\/sh\n {6}- -c\n {6}- \|\n {8}C=\/gc-mqtt;/);
      // compose escapes: every $ of the script doubled
      assert.match(mqtt, /halt; mosquitto -c "\$\$C\/mosquitto\.conf" & p=\$\$!/);
      assert.doesNotMatch(mqtt.replace(/\$\$/g, ''), /\$/);
      assert.match(mqtt, /user: "61001:61001"/);
      assert.match(mqtt, /cap_drop:\n {6}- ALL/);
      assert.match(mqtt, /no-new-privileges:true/);
      assert.match(mqtt, /read_only: true\n {4}mem_limit: 128m\n {4}pids_limit: 32/);
      assert.match(mqtt, /depends_on:\n {6}- edge/);
      assert.match(mqtt, /source: edge-mqtt\n {8}target: \/gc-mqtt\n {8}volume: \{ nocopy: true \}/);
      assert.doesNotMatch(mqtt, /^ +(?:cap_add|privileged|devices|ports):/m);
    }
  });
  it('DSM task: update.sh with docker in PATH, the host side of /state and the project folder', () => {
    assert.equal(kit.nasTaskCommand('/volume1/docker/gatecontrol-gateway'),
      'PATH=/usr/local/bin:$PATH GATEWAY_STATE_DIR=/volume1/docker/gatecontrol-gateway/gateway-state GC_GW_COMPOSE_DIR=/volume1/docker/gatecontrol-gateway bash /volume1/docker/gatecontrol-gateway/update.sh');
  });
  it('Proxmox one-liner and version compare', () => {
    assert.match(kit.pairingCommand('ABCD-1234'), /install-pve\.sh\)" -- \\\n {2}--token "ABCD-1234" --yes$/);
    assert.equal(kit.versionAtLeast('1.17.0', '1.17.0'), true);
    assert.equal(kit.versionAtLeast('1.16.11', '1.17.0'), false);
    assert.equal(kit.versionAtLeast('1.18.2', '1.17.0'), true);
    assert.equal(kit.versionAtLeast('dev', '1.17.0'), false);
  });
});

