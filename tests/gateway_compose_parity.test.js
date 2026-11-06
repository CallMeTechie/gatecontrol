'use strict';

// The docker-compose.yml of the gateway assistant (public/js/gateway-kit.js
// buildCompose — also the NAS package and the "only docker-compose.yml"
// download) against docker-compose.example.yml of gatecontrol-gateway, checked
// in as tests/fixtures/gateway-compose/docker-compose.example.yml (copy of
// gatecontrol-gateway main 2330392, 2026-11-05 / v1.22.1). When the gateway
// changes its example, copy it again — this test then shows what buildCompose
// has to follow.
//
// Compared per platform/network: services, cap_add, devices, volumes,
// environment, user, healthcheck, logging, tmpfs, the edge and mqtt services
// and the top-level volumes. Comments do not count. Deliberate differences are
// listed in EXPECTED_DIFF and nowhere else.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const kit = require('../public/js/gateway-kit');

const EXAMPLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'gateway-compose', 'docker-compose.example.yml'), 'utf8');

// ── a small reader for the compose subset both files use ────────────────────
// Comment lines and trailing " # …" comments go, blank lines go; what stays is
// [indent, text] per line. Block scalars (the mqtt watcher) keep their lines.
function lines(text) {
  return text.split('\n')
    .filter((l) => !/^\s*#/.test(l) && l.trim() !== '')
    .map((l) => l.replace(/\s+#(?:\s.*)?$/, '').replace(/\s+$/, ''))
    .map((l) => [l.length - l.trimStart().length, l.trim()]);
}
// the child lines of `key:` that sits at `indent` (null: no such key)
function block(ls, key, indent) {
  const i = ls.findIndex(([n, t]) => n === indent && (t === key + ':' || t.startsWith(key + ': ')));
  if (i < 0) return null;
  const out = [];
  for (let j = i + 1; j < ls.length && ls[j][0] > indent; j++) out.push(ls[j]);
  return out;
}
function keysAt(ls, indent) {
  return ls.filter(([n, t]) => n === indent && /^[a-z_][\w-]*:/i.test(t)).map(([, t]) => t.split(':')[0]);
}
function parse(text) {
  const ls = lines(text);
  const svc = block(ls, 'services', 0) || [];
  const services = {};
  for (const name of keysAt(svc, 2)) {
    const body = block(svc, name, 2);
    const keys = {};
    for (const k of keysAt(body, 4)) {
      const own = body.find(([n, t]) => n === 4 && (t === k + ':' || t.startsWith(k + ': ')))[1];
      keys[k] = [own].concat(block(body, k, 4).map(([n, t]) => ' '.repeat(n - 4) + t)).join('\n');
    }
    services[name] = keys;
  }
  const vol = block(ls, 'volumes', 0);
  return { services, volumes: vol ? vol.map(([n, t]) => ' '.repeat(n) + t).join('\n') : null };
}
const listOf = (s) => (s || '').split('\n').slice(1).map((l) => l.trim().replace(/^- /, ''));

const ex = parse(EXAMPLE);
const exGw = ex.services.gateway;

// What the assistant does differently from the example — with the reason.
const EXPECTED_DIFF = {
  // TZ comes from the server (features.timezone, gateway >= 1.22.0); the env value is only a fallback.
  environmentDrop: ['TZ=${TZ:-Etc/UTC}'],
  // linux = kernel WireGuard: no TUN device, no userspace switch (wg-quick falls back by itself).
  linuxDrop: { devices: true, environment: ['WG_QUICK_USERSPACE_IMPLEMENTATION=wireguard-go'] },
};

describe('gateway compose: assistant vs docker-compose.example.yml of the gateway', () => {
  it('the fixture is the gateway example (services gateway, edge, mqtt; NET_RAW/SETGID/SETUID)', () => {
    assert.deepEqual(Object.keys(ex.services), ['gateway', 'edge', 'mqtt']);
    assert.deepEqual(listOf(exGw.cap_add), ['NET_ADMIN', 'NET_BIND_SERVICE', 'NET_RAW', 'SETGID', 'SETUID']);
  });

  for (const platform of ['synology', 'linux']) {
    describe(`${platform} / host`, () => {
      const got = parse(kit.buildCompose({ platform, network: 'host' }));
      const gw = got.services.gateway;

      it('same services and top-level volumes', () => {
        assert.deepEqual(Object.keys(got.services), Object.keys(ex.services));
        assert.equal(got.volumes, ex.volumes);
      });
      it('edge and mqtt exactly as in the example', () => {
        assert.deepEqual(got.services.edge, ex.services.edge);
        assert.deepEqual(got.services.mqtt, ex.services.mqtt);
      });
      it('gateway: cap_add, user, read_only, tmpfs, volumes, healthcheck, logging as in the example', () => {
        for (const k of ['image', 'restart', 'network_mode', 'cap_drop', 'cap_add', 'read_only', 'user', 'tmpfs', 'volumes', 'healthcheck', 'logging']) {
          assert.equal(gw[k], exGw[k], `gateway.${k}`);
        }
      });
      it('gateway: devices and environment (minus the listed differences)', () => {
        const env = listOf(exGw.environment).filter((e) => EXPECTED_DIFF.environmentDrop.indexOf(e) < 0)
          .filter((e) => platform === 'synology' || EXPECTED_DIFF.linuxDrop.environment.indexOf(e) < 0);
        assert.deepEqual(listOf(gw.environment), env);
        if (platform === 'synology') assert.equal(gw.devices, exGw.devices);
        else assert.equal(gw.devices, undefined);
      });
      it('gateway: no keys beyond the example', () => {
        const extra = Object.keys(gw).filter((k) => !(k in exGw));
        assert.deepEqual(extra, []);
        const missing = Object.keys(exGw).filter((k) => !(k in gw) && !(k === 'devices' && platform === 'linux'));
        assert.deepEqual(missing, []);
      });
    });
  }

  for (const platform of ['synology', 'linux']) {
    it(`${platform} / bridge: HTTP routes only — no host-only capabilities, no edge`, () => {
      const got = parse(kit.buildCompose({ platform, network: 'bridge' }));
      const gw = got.services.gateway;
      assert.deepEqual(Object.keys(got.services), ['gateway']);
      assert.equal(got.volumes, null);
      assert.equal(gw.network_mode, undefined);
      // NET_RAW: ping of the internet quality; keepalived (SETGID/SETUID) and low ports need the host network
      assert.deepEqual(listOf(gw.cap_add), ['NET_ADMIN', 'NET_RAW']);
      assert.deepEqual(listOf(gw.ports), ['"8080:8080"', '"9876:9876"']);
      assert.deepEqual(listOf(gw.volumes), ['./config:/config:ro', './gateway-state:/state', '${GC_CACHE_DIR:-./gateway-cache}:/cache']);
      for (const k of ['user', 'read_only', 'tmpfs', 'healthcheck', 'logging']) assert.equal(gw[k], exGw[k], `gateway.${k}`);
      assert.equal(gw.devices, platform === 'synology' ? exGw.devices : undefined);
    });
  }
});
