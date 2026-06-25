'use strict';

// Unit tests for the Caddy ownership guard (caddyOwner.js).
//
// Context: the deployed container runs network_mode: host, so the Caddy
// admin API on 127.0.0.1:2019 is shared with EVERY process on the host —
// including dev/test runs in .claude worktrees. A foreign process that
// pushes a full config via POST /load overwrites the live production
// config (the 2026-06-25 ERR_SSL_PROTOCOL_ERROR incident). The owner
// guard tags every prod config with an instance id and refuses to /load
// over a Caddy already owned by a DIFFERENT instance.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const owner = require('../src/services/caddyOwner');
const { OWNER_ID_PREFIX, ownerMarkerRoute, extractOwner, isForeignOwner, ownershipDecision, getOwnerId, _resetOwnerCache } = owner;

function configWithRoutes(routes) {
  return { apps: { http: { servers: { srv0: { listen: [':443'], routes } } } } };
}

test('OWNER_ID_PREFIX is the gc_owner_ namespace (distinct from gc_route_)', () => {
  assert.equal(OWNER_ID_PREFIX, 'gc_owner_');
});

test('ownerMarkerRoute carries the prefixed @id and an unreachable host match', () => {
  const r = ownerMarkerRoute('deadbeef');
  assert.equal(r['@id'], 'gc_owner_deadbeef');
  // Must match an impossible host so it never serves or shadows a real route.
  const hosts = r.match[0].host;
  assert.ok(Array.isArray(hosts) && hosts.length === 1);
  assert.match(hosts[0], /\.invalid$/);
});

test('extractOwner returns null for empty / markerless configs', () => {
  assert.equal(extractOwner(null), null);
  assert.equal(extractOwner({}), null);
  assert.equal(extractOwner(configWithRoutes([])), null);
  assert.equal(extractOwner(configWithRoutes([{ '@id': 'gc_route_5', handle: [] }])), null);
});

test('extractOwner reads the owner id from a top-level marker route', () => {
  const cfg = configWithRoutes([
    { '@id': 'gc_route_1', handle: [] },
    ownerMarkerRoute('abc123'),
  ]);
  assert.equal(extractOwner(cfg), 'abc123');
});

test('extractOwner recurses into subroute handlers', () => {
  const cfg = configWithRoutes([
    { handle: [{ handler: 'subroute', routes: [ownerMarkerRoute('nested99')] }] },
  ]);
  assert.equal(extractOwner(cfg), 'nested99');
});

test('isForeignOwner: unowned (fresh) Caddy is claimable', () => {
  assert.equal(isForeignOwner(configWithRoutes([]), 'me'), false);
});

test('isForeignOwner: my own Caddy is not foreign', () => {
  const cfg = configWithRoutes([ownerMarkerRoute('me')]);
  assert.equal(isForeignOwner(cfg, 'me'), false);
});

test('isForeignOwner: a different instance IS foreign (refuse)', () => {
  const cfg = configWithRoutes([ownerMarkerRoute('someone-else')]);
  assert.equal(isForeignOwner(cfg, 'me'), true);
});

test('getOwnerId persists to GC_CADDY_DATA_DIR and is stable across calls', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-owner-'));
  const prev = process.env.GC_CADDY_DATA_DIR;
  process.env.GC_CADDY_DATA_DIR = dir;
  try {
    _resetOwnerCache();
    const id1 = getOwnerId();
    assert.ok(id1 && typeof id1 === 'string' && id1.length >= 8);
    // Persisted to disk.
    const onDisk = fs.readFileSync(path.join(dir, '.caddy-owner'), 'utf8').trim();
    assert.equal(onDisk, id1);
    // Memoised — same value without re-reading.
    assert.equal(getOwnerId(), id1);
    // A fresh process (cache reset) reuses the persisted id.
    _resetOwnerCache();
    assert.equal(getOwnerId(), id1);
  } finally {
    process.env.GC_CADDY_DATA_DIR = prev;
    _resetOwnerCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getOwnerId falls back to an ephemeral id when the dir is unwritable', () => {
  const prev = process.env.GC_CADDY_DATA_DIR;
  // A path under a file (not a dir) cannot be created → mkdir/write fail.
  const file = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-owner-'));
  const notADir = path.join(file, 'regular-file');
  fs.writeFileSync(notADir, 'x');
  process.env.GC_CADDY_DATA_DIR = path.join(notADir, 'subdir');
  try {
    _resetOwnerCache();
    const id = getOwnerId();
    assert.ok(id && typeof id === 'string' && id.length >= 8, 'ephemeral id still returned');
  } finally {
    process.env.GC_CADDY_DATA_DIR = prev;
    _resetOwnerCache();
    fs.rmSync(file, { recursive: true, force: true });
  }
});

test('ownershipDecision: a read error fails CLOSED (skip), not open', () => {
  // The whole point of the guard: if we cannot read the live config, we must
  // NOT proceed to /load — otherwise a transient read glitch lets a foreign
  // process clobber prod. A read error wins even over a same-owner config.
  assert.equal(ownershipDecision(null, new Error('timeout'), 'me'), 'read-error');
  assert.equal(ownershipDecision(configWithRoutes([ownerMarkerRoute('me')]), new Error('boom'), 'me'), 'read-error');
});

test('ownershipDecision: foreign owner → refuse', () => {
  assert.equal(ownershipDecision(configWithRoutes([ownerMarkerRoute('other')]), null, 'me'), 'foreign');
});

test('ownershipDecision: claimable (null/fresh) or own → proceed', () => {
  assert.equal(ownershipDecision(null, null, 'me'), 'proceed');           // Caddy down
  assert.equal(ownershipDecision(configWithRoutes([]), null, 'me'), 'proceed'); // fresh
  assert.equal(ownershipDecision(configWithRoutes([ownerMarkerRoute('me')]), null, 'me'), 'proceed');
});

test('two distinct instances (fresh dirs) get different ids — the crux of the guard', () => {
  const prev = process.env.GC_CADDY_DATA_DIR;
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-ownerA-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-ownerB-'));
  try {
    process.env.GC_CADDY_DATA_DIR = dirA; _resetOwnerCache();
    const idA = getOwnerId();
    process.env.GC_CADDY_DATA_DIR = dirB; _resetOwnerCache();
    const idB = getOwnerId();
    assert.notEqual(idA, idB);
    // Instance B, seeing A's marker in the live config, refuses.
    assert.equal(isForeignOwner(configWithRoutes([ownerMarkerRoute(idA)]), idB), true);
  } finally {
    process.env.GC_CADDY_DATA_DIR = prev;
    _resetOwnerCache();
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});
