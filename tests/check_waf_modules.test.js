'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseDockerfilePins, requiredVersion, compareVersions, buildReport, escapeModule,
} = require('../scripts/check-waf-modules');

describe('check-waf-modules', () => {
  it('reads the coraza-caddy pin from the real Dockerfile', () => {
    const pins = parseDockerfilePins(fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8'));
    assert.match(pins['github.com/corazawaf/coraza-caddy/v2'] || '', /^v2\.\d+\.\d+/);
    assert.equal(pins['github.com/mholt/caddy-l4'], undefined, 'unpinned --with lines are ignored');
    assert.equal(pins['github.com/custom/caddy-mirror'], undefined, 'local replacements are ignored');
  });

  it('parses explicit CRS pins and go.mod requirements (block and single line)', () => {
    const pins = parseDockerfilePins('xcaddy build \\\n  --with github.com/corazawaf/coraza-coreruleset/v4@v4.26.0 \\\n  --with x/y@v1.2.3-rc.1');
    assert.equal(pins['github.com/corazawaf/coraza-coreruleset/v4'], 'v4.26.0');
    assert.equal(pins['x/y'], 'v1.2.3-rc.1');
    const mod = 'module m\nrequire (\n\tgithub.com/corazawaf/coraza-coreruleset/v4 v4.25.0\n\tgithub.com/corazawaf/coraza/v3 v3.7.0\n)\n';
    assert.equal(requiredVersion(mod, 'github.com/corazawaf/coraza-coreruleset/v4'), 'v4.25.0');
    assert.equal(requiredVersion('require github.com/a/b v1.0.1\n', 'github.com/a/b'), 'v1.0.1');
    assert.equal(requiredVersion(mod, 'github.com/missing/mod'), null);
  });

  it('compares versions numerically, pre-releases before releases', () => {
    assert.equal(compareVersions('v4.9.0', 'v4.10.0'), -1);
    assert.equal(compareVersions('v2.6.1', 'v2.6.1'), 0);
    assert.equal(compareVersions('v2.7.0', 'v2.6.9'), 1);
    assert.equal(compareVersions('v2.7.0-rc.1', 'v2.7.0'), -1);
  });

  it('escapes upper-case letters for the Go proxy', () => {
    assert.equal(escapeModule('github.com/BurntSushi/toml'), 'github.com/!burnt!sushi/toml');
  });

  it('report: everything current → not outdated, no steps', () => {
    const r = buildReport({ caddyPin: 'v2.6.1', crsPin: null, crsFromCaddyMod: 'v4.25.0', caddyLatest: 'v2.6.1', crsLatest: 'v4.25.0' });
    assert.equal(r.outdated, false);
    assert.equal(r.crsUsed, 'v4.25.0');
    assert.doesNotMatch(r.body, /Schritte/);
  });

  it('report: newer CRS only → outdated, suggests an explicit CRS pin', () => {
    const r = buildReport({ caddyPin: 'v2.6.1', crsPin: null, crsFromCaddyMod: 'v4.25.0', caddyLatest: 'v2.6.1', crsLatest: 'v4.26.0' });
    assert.equal(r.outdated, true);
    assert.match(r.body, /--with github\.com\/corazawaf\/coraza-coreruleset\/v4@v4\.26\.0/);
    assert.match(r.body, /über coraza-caddy/);
  });

  it('report: newer coraza-caddy → outdated, suggests the bump; an explicit CRS pin wins over go.mod', () => {
    const r = buildReport({ caddyPin: 'v2.6.1', crsPin: 'v4.26.0', crsFromCaddyMod: 'v4.25.0', caddyLatest: 'v2.7.0', crsLatest: 'v4.26.0' });
    assert.equal(r.outdated, true);
    assert.equal(r.crsUsed, 'v4.26.0');
    assert.match(r.body, /coraza-caddy\/v2@v2\.6\.1` auf `@v2\.7\.0`/);
    assert.match(r.body, /v4\.26\.0 \(Pin\)/);
  });
});
