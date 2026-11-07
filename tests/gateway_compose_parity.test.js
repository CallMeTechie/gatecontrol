'use strict';

// The docker-compose.yml of the gateway assistant (public/js/gateway-kit.js
// buildCompose — also the NAS package and the "only docker-compose.yml"
// download) against docker-compose.example.yml of gatecontrol-gateway, checked
// in as tests/fixtures/gateway-compose/docker-compose.example.yml (copy of
// gatecontrol-gateway feat/print-ocr-office, 2026-11-07 / v1.33.0: service office in the profile office, volume office-ctl, the gateway mounts /gc-office; before that feat/funk-z2m-thread-ble with zigbee2mqtt (profile zigbee2mqtt) and otbr (profile thread), volumes z2m-data and otbr-data). When the gateway
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
// gateway >= 1.31.0: "Grafikkarte nutzen" — the gateway's additions on top of the service ki (copies of its
// docker-compose.ki-nvidia.yml, -amd.yml, -intel.yml)
const KI_GPU = Object.fromEntries(['nvidia', 'amd', 'intel'].map((g) => [g, fs.readFileSync(path.join(__dirname, 'fixtures', 'gateway-compose', `docker-compose.ki-${g}.yml`), 'utf8')]));

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
  it('the fixture is the gateway example (services gateway, edge, mqtt, deconz, zigbee2mqtt, otbr, ki, kameras, office; NET_RAW/SETGID/SETUID)', () => {
    assert.deepEqual(Object.keys(ex.services), ['gateway', 'edge', 'mqtt', 'deconz', 'zigbee2mqtt', 'otbr', 'ki', 'kameras', 'office']);
    // after 1.30.0: zigbee2mqtt and the Thread border router only in their profiles
    assert.equal(ex.services.zigbee2mqtt.profiles, 'profiles: ["zigbee2mqtt"]');
    assert.equal(ex.services.otbr.profiles, 'profiles: ["thread"]');
    assert.equal(ex.services.otbr.privileged, undefined);
    // gateway >= 1.33.0: LibreOffice only in the profile office, no network; the gateway mounts office-ctl
    assert.equal(ex.services.office.profiles, 'profiles: ["office"]');
    assert.equal(ex.services.office.network_mode, 'network_mode: none');
    assert.match(exGw.volumes, /source: office-ctl/);
    // gateway >= 1.28.0: the cameras (ffmpeg) only in the profile kameras, the gateway mounts cam-ctl and the clips
    assert.equal(ex.services.kameras.profiles, 'profiles: ["kameras"]');
    assert.match(exGw.volumes, /source: cam-ctl/);
    assert.match(exGw.volumes, /\/recordings/);
    assert.equal(ex.services.kameras.ports, undefined);
    // gateway >= 1.26.0: the local AI (Ollama) only in the profile ki (≈ 3 GB image), the gateway mounts ai-ctl
    assert.equal(ex.services.ki.profiles, 'profiles: ["ki"]');
    assert.match(exGw.volumes, /source: ai-ctl/);
    assert.match(ex.services.ki.environment, /OLLAMA_HOST=127\.0\.0\.1:11435/);
    // gateway >= 1.31.0: the watcher reports the GPU kind and devices in /gc-ai/ki.gpu
    assert.match(ex.services.ki.environment, /- GC_KI_GPU=none/);
    assert.match(ex.services.ki.entrypoint, /ki\.gpu/);
    // gateway >= 1.25.0: deCONZ only in the profile zigbee (nobody pulls the image without a stick), the
    // gateway mounts the control volume radio-ctl
    assert.equal(ex.services.deconz.profiles, 'profiles: ["zigbee"]');
    assert.match(exGw.volumes, /source: radio-ctl/);
    assert.deepEqual(listOf(exGw.cap_add), ['NET_ADMIN', 'NET_BIND_SERVICE', 'NET_RAW', 'SETGID', 'SETUID']);
    // gateway >= 1.23.0: the edge container has no network (no fence, no xt_owner); the gateway writes the broker files
    assert.equal(ex.services.edge.network_mode, 'network_mode: none');
    assert.ok(!/edge-mqtt/.test(ex.services.edge.volumes), 'the edge container never sees the broker files');
    assert.match(exGw.volumes, /source: edge-mqtt-conf/);
  });

  for (const platform of ['synology', 'linux']) {
    describe(`${platform} / host`, () => {
      const got = parse(kit.buildCompose({ platform, network: 'host' }));
      const gw = got.services.gateway;

      it('same services (deconz only with zigbee, ki only with ai) and top-level volumes', () => {
        assert.deepEqual(Object.keys(got.services), Object.keys(ex.services).filter((k) => !['deconz', 'zigbee2mqtt', 'otbr', 'ki', 'kameras', 'office'].includes(k)));
        assert.equal(got.volumes, ex.volumes);
      });
      it('zigbee: the deconz service exactly as in the example, without the profile', () => {
        const z = parse(kit.buildCompose({ platform, network: 'host', zigbee: true }));
        assert.deepEqual(Object.keys(z.services), ['gateway', 'edge', 'mqtt', 'deconz']);
        const { profiles, ...want } = ex.services.deconz;
        assert.ok(profiles);
        assert.deepEqual(z.services.deconz, want);
        assert.equal(z.volumes, ex.volumes);
        assert.deepEqual(z.services.gateway, got.services.gateway);
      });
      it('ai: the service ki exactly as in the example, without the profile', () => {
        const a = parse(kit.buildCompose({ platform, network: 'host', ai: true }));
        assert.deepEqual(Object.keys(a.services), ['gateway', 'edge', 'mqtt', 'ki']);
        const { profiles, ...want } = ex.services.ki;
        assert.ok(profiles);
        assert.deepEqual(a.services.ki, want);
        assert.equal(a.volumes, ex.volumes);
        assert.deepEqual(a.services.gateway, got.services.gateway);
        const both = parse(kit.buildCompose({ platform, network: 'host', ai: true, zigbee: true }));
        assert.deepEqual(Object.keys(both.services), ['gateway', 'edge', 'mqtt', 'deconz', 'ki']);
      });
      for (const gpu of ['nvidia', 'amd', 'intel']) {
        it(`ai with the graphics card ${gpu}: the service ki of the example plus docker-compose.ki-${gpu}.yml of the gateway`, () => {
          const a = parse(kit.buildCompose({ platform, network: 'host', ai: true, aiGpu: gpu }));
          const add = parse(KI_GPU[gpu]).services.ki;
          const { profiles, ...base } = ex.services.ki;
          assert.ok(profiles);
          // the addition replaces image/devices/deploy and the line GC_KI_GPU (compose merges environment by name)
          const want = { ...base, ...add, environment: base.environment.replace('- GC_KI_GPU=none', `- GC_KI_GPU=${gpu}`) };
          assert.deepEqual(listOf(add.environment), [`GC_KI_GPU=${gpu}`]);
          assert.deepEqual(a.services.ki, want);
          assert.deepEqual(a.services.gateway, got.services.gateway);
          assert.equal(a.volumes, ex.volumes);
        });
      }
      it('ai: a GPU only with the service ki; anything else is no GPU', () => {
        assert.deepEqual(Object.keys(parse(kit.buildCompose({ platform, network: 'host', aiGpu: 'nvidia' })).services), ['gateway', 'edge', 'mqtt']);
        assert.deepEqual(parse(kit.buildCompose({ platform, network: 'host', ai: true, aiGpu: 'evil' })).services.ki, parse(kit.buildCompose({ platform, network: 'host', ai: true })).services.ki);
      });
      it('cameras: the service kameras exactly as in the example, without the profile', () => {
        const c = parse(kit.buildCompose({ platform, network: 'host', cameras: true }));
        assert.deepEqual(Object.keys(c.services), ['gateway', 'edge', 'mqtt', 'kameras']);
        const { profiles, ...want } = ex.services.kameras;
        assert.ok(profiles);
        assert.deepEqual(c.services.kameras, want);
        assert.equal(c.volumes, ex.volumes);
        assert.deepEqual(c.services.gateway, got.services.gateway);
        const all = parse(kit.buildCompose({ platform, network: 'host', ai: true, zigbee: true, zigbee2mqtt: true, thread: true, cameras: true, office: true }));
        assert.deepEqual(Object.keys(all.services).sort(), Object.keys(ex.services).sort());
      });
      it('zigbee2mqtt and thread: the services exactly as in the example, without the profile', () => {
        const z = parse(kit.buildCompose({ platform, network: 'host', zigbee2mqtt: true, thread: true }));
        assert.deepEqual(Object.keys(z.services), ['gateway', 'edge', 'mqtt', 'zigbee2mqtt', 'otbr']);
        for (const name of ['zigbee2mqtt', 'otbr']) {
          const { profiles, ...want } = ex.services[name];
          assert.ok(profiles);
          assert.deepEqual(z.services[name], want, name);
        }
        assert.equal(z.volumes, ex.volumes);
        assert.deepEqual(z.services.gateway, got.services.gateway);
      });
      it('office: the service office exactly as in the example, without the profile', () => {
        const o = parse(kit.buildCompose({ platform, network: 'host', office: true }));
        assert.deepEqual(Object.keys(o.services), ['gateway', 'edge', 'mqtt', 'office']);
        const { profiles, ...want } = ex.services.office;
        assert.ok(profiles);
        assert.deepEqual(o.services.office, want);
        assert.equal(o.volumes, ex.volumes);
        assert.deepEqual(o.services.gateway, got.services.gateway);
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
    it(`${platform} / bridge: HTTP routes only — no host-only capabilities, no edge, no deconz, no ki, no kameras`, () => {
      const got = parse(kit.buildCompose({ platform, network: 'bridge', zigbee: true, zigbee2mqtt: true, thread: true, ai: true, cameras: true, office: true }));
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
