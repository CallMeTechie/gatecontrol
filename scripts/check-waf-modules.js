#!/usr/bin/env node
'use strict';

/**
 * Weekly check (.github/workflows/waf-updates.yml): are the WAF modules built
 * into Caddy still current?
 *
 * Dependabot only watches npm and GitHub Actions. The Coraza module is pinned
 * in the Dockerfile (`xcaddy build --with github.com/corazawaf/coraza-caddy/v2@vX`)
 * and brings the OWASP Core Rule Set in as the Go module
 * corazawaf/coraza-coreruleset/v4 — so without this check the rules only age.
 *
 * Compares against the Go module proxy:
 *   - coraza-caddy/v2: Dockerfile pin vs. @latest
 *   - coraza-coreruleset/v4: the version the build actually uses (an explicit
 *     `--with …coraza-coreruleset/v4@vX` pin in the Dockerfile, otherwise the
 *     requirement in coraza-caddy's go.mod) vs. @latest
 *
 * Output (GitHub Actions step output format, one per line):
 *   outdated=true|false
 *   title=<issue title>
 *   body_file=<path of the markdown report>
 *
 * Aufruf: node scripts/check-waf-modules.js [Dockerfile] [report.md]
 */

const fs = require('node:fs');

const PROXY = 'https://proxy.golang.org';
const CADDY_MOD = 'github.com/corazawaf/coraza-caddy/v2';
const CRS_MOD = 'github.com/corazawaf/coraza-coreruleset/v4';
const ISSUE_TITLE = 'WAF: neue Coraza- oder CRS-Version verfügbar';

// Go proxy paths escape upper-case letters as "!" + lower case.
function escapeModule(mod) {
  return mod.replace(/[A-Z]/g, (c) => '!' + c.toLowerCase());
}

/** `--with <module>@<version>` pins from the Dockerfile. */
function parseDockerfilePins(text) {
  const pins = {};
  const re = /--with\s+([^\s@=\\]+)@(v[0-9][^\s\\]*)/g;
  let m;
  while ((m = re.exec(String(text))) !== null) pins[m[1]] = m[2];
  return pins;
}

/** Version of `mod` required by a go.mod text (block or single-line form). */
function requiredVersion(goMod, mod) {
  const esc = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(goMod).match(new RegExp(`^\\s*(?:require\\s+)?${esc}\\s+(v[0-9][^\\s]*)`, 'm'));
  return m ? m[1] : null;
}

/** Semver compare for vMAJOR.MINOR.PATCH[-pre]; pre-releases sort before releases. */
function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).replace(/^v/, '').split('-', 2);
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre || null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((x.nums[i] || 0) !== (y.nums[i] || 0)) return (x.nums[i] || 0) < (y.nums[i] || 0) ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * Pure part: from the pins and proxy answers to the report.
 * @param {{caddyPin:string|null, crsPin:string|null, crsFromCaddyMod:string|null,
 *          caddyLatest:string, crsLatest:string}} v
 */
function buildReport(v) {
  const crsUsed = v.crsPin || v.crsFromCaddyMod;
  const rows = [];
  const caddyOutdated = !!(v.caddyPin && v.caddyLatest && compareVersions(v.caddyPin, v.caddyLatest) < 0);
  const crsOutdated = !!(crsUsed && v.crsLatest && compareVersions(crsUsed, v.crsLatest) < 0);
  rows.push(`| \`coraza-caddy/v2\` | ${v.caddyPin || '–'} | ${v.caddyLatest || '–'} | ${caddyOutdated ? '**neu**' : 'aktuell'} |`);
  rows.push(`| \`coraza-coreruleset/v4\` (OWASP CRS) | ${crsUsed || '–'}${v.crsPin ? ' (Pin)' : ' (über coraza-caddy)'} | ${v.crsLatest || '–'} | ${crsOutdated ? '**neu**' : 'aktuell'} |`);

  const steps = [];
  if (caddyOutdated) {
    steps.push(`- Im \`Dockerfile\` \`--with ${CADDY_MOD}@${v.caddyPin}\` auf \`@${v.caddyLatest}\` anheben (Release-Notes auf Caddy-Mindestversion prüfen).`);
  }
  if (crsOutdated) {
    steps.push(v.crsPin
      ? `- Im \`Dockerfile\` \`--with ${CRS_MOD}@${v.crsPin}\` auf \`@${v.crsLatest}\` anheben.`
      : `- Nur die Regeln aktualisieren: im \`Dockerfile\` \`--with ${CRS_MOD}@${v.crsLatest}\` ergänzen (oder eine coraza-caddy-Version abwarten, die sie mitbringt).`);
  }
  if (steps.length) {
    steps.push('- Danach: `tests/waf_caddy_validate.test.js` mit dem neuen Binary, WAF-Route im Modus „Nur erkennen“ beobachten (neue Regeln können neue Fehlalarme bringen).');
  }

  const body = [
    'Automatisch erzeugt von `.github/workflows/waf-updates.yml` (wöchentlich).',
    '',
    '| Modul | im Build | neueste | Stand |',
    '|---|---|---|---|',
    ...rows,
    '',
    ...(steps.length ? ['**Schritte**', '', ...steps, ''] : []),
    `Stand: ${new Date().toISOString().slice(0, 10)}`,
  ].join('\n');

  return { outdated: caddyOutdated || crsOutdated, title: ISSUE_TITLE, body, crsUsed };
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'gatecontrol-waf-check' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

async function latest(mod) {
  return JSON.parse(await fetchText(`${PROXY}/${escapeModule(mod)}/@latest`)).Version;
}

async function main() {
  const dockerfile = process.argv[2] || 'Dockerfile';
  const reportPath = process.argv[3] || 'waf-updates-report.md';
  const pins = parseDockerfilePins(fs.readFileSync(dockerfile, 'utf8'));
  const caddyPin = pins[CADDY_MOD] || null;
  if (!caddyPin) throw new Error(`no --with ${CADDY_MOD}@<version> pin in ${dockerfile}`);
  const crsPin = pins[CRS_MOD] || null;
  const caddyMod = await fetchText(`${PROXY}/${escapeModule(CADDY_MOD)}/@v/${caddyPin}.mod`);
  const report = buildReport({
    caddyPin,
    crsPin,
    crsFromCaddyMod: requiredVersion(caddyMod, CRS_MOD),
    caddyLatest: await latest(CADDY_MOD),
    crsLatest: await latest(CRS_MOD),
  });
  fs.writeFileSync(reportPath, report.body + '\n');
  process.stdout.write(`outdated=${report.outdated}\ntitle=${report.title}\nbody_file=${reportPath}\n`);
  process.stderr.write(report.body + '\n');
}

module.exports = { parseDockerfilePins, requiredVersion, compareVersions, buildReport, escapeModule, ISSUE_TITLE };

if (require.main === module) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
