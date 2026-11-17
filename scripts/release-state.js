#!/usr/bin/env node
'use strict';

/**
 * Entscheidet im Release-Workflow, was ein Lauf tun muss.
 *
 * Hintergrund: Lauf 44103244201 hat Bump-Commit und Tag v1.297.0 gepusht und
 * ist danach beim Image-Build gescheitert ("buildx failed: unknown blob"). Der
 * Neustart sah den Bump-Commit nach dem auslösenden Commit, hielt alles für
 * erledigt und übersprang den Rest — Tag ohne Image und ohne GitHub-Release.
 *
 * Modi:
 *   - "release": normaler Lauf — Version erhöhen, committen, taggen, Image
 *     bauen, Release anlegen.
 *   - "resume":  der Bump nach diesem Commit und sein Tag existieren, aber kein
 *     GitHub-Release dazu. Bump/Commit/Tag entfallen; Image und Release werden
 *     für den vorhandenen Tag nachgeholt (Checkout dieses Tags).
 *   - "skip":    schon vollständig veröffentlicht (oder ein Zustand, aus dem
 *     sich nichts sicher nachholen lässt).
 *
 * Aufruf (im Workflow): node scripts/release-state.js <berechneter-tag>
 *   liest GITHUB_SHA, GITHUB_REPOSITORY; schreibt mode/tag/version/latest
 *   nach GITHUB_OUTPUT. Braucht GH_TOKEN für die Release-Abfrage.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const BUMP_RE = /^chore: bump version to (\d+\.\d+\.\d+)$/;

/**
 * @param {object} p
 * @param {string[]} p.subjectsAfter  Betreffzeilen von GITHUB_SHA..HEAD, älteste zuerst
 * @param {string}   p.computedTag    Tag, den ein normaler Lauf anlegen würde
 * @param {string}   p.headVersion    package.json-Version auf master-HEAD
 * @param {(tag: string) => boolean} p.tagExists
 * @param {(tag: string) => boolean} p.releaseExists
 * @returns {{ mode: 'release'|'resume'|'skip', tag: string, version: string, latest: boolean, reason: string }}
 */
function decide({ subjectsAfter, computedTag, headVersion, tagExists, releaseExists }) {
  const computedVersion = computedTag.replace(/^v/, '');
  const bump = subjectsAfter.map((s) => s.match(BUMP_RE)).find(Boolean);

  if (bump) {
    // Der erste Bump nach diesem Commit hat ihn ausgeliefert (dieser Lauf beim
    // ersten Versuch oder ein späterer Merge zusammen mit seiner Änderung).
    const version = bump[1];
    const tag = `v${version}`;
    if (releaseExists(tag)) {
      return { mode: 'skip', tag, version, latest: false, reason: `${tag} ist bereits veröffentlicht` };
    }
    if (!tagExists(tag)) {
      return { mode: 'skip', tag, version, latest: false,
        reason: `Bump auf ${version} existiert, Tag ${tag} aber nicht — nichts sicher nachzuholen` };
    }
    // ":latest" nur, wenn kein neuerer Bump folgt (sonst Rückschritt).
    return { mode: 'resume', tag, version, latest: version === headVersion,
      reason: `${tag} existiert ohne GitHub-Release — Image und Release werden nachgeholt` };
  }

  if (tagExists(computedTag)) {
    return { mode: 'skip', tag: computedTag, version: computedVersion, latest: false,
      reason: `Tag ${computedTag} existiert bereits` };
  }
  return { mode: 'release', tag: computedTag, version: computedVersion, latest: true, reason: 'neues Release' };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function main() {
  const computedTag = process.argv[2];
  const sha = process.env.GITHUB_SHA;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!computedTag || !sha || !repo) {
    console.error('Aufruf: GITHUB_SHA=… GITHUB_REPOSITORY=… node scripts/release-state.js <tag>');
    process.exit(2);
  }

  const log = git(['log', '--reverse', '--format=%s', `${sha}..HEAD`]);
  const result = decide({
    subjectsAfter: log ? log.split('\n') : [],
    computedTag,
    headVersion: JSON.parse(fs.readFileSync('package.json', 'utf8')).version,
    tagExists: (tag) => {
      try { git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]); return true; } catch { return false; }
    },
    releaseExists: (tag) => {
      try {
        execFileSync('gh', ['api', `repos/${repo}/releases/tags/${tag}`, '--silent'],
          { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
        return true;
      } catch (err) {
        // Nur "nicht gefunden" heißt "kein Release"; jeder andere Fehler bricht
        // ab, statt ein Release doppelt anzulegen oder fälschlich zu überspringen.
        if (/HTTP 404/.test(String(err.stderr))) return false;
        throw err;
      }
    },
  });

  console.log(`mode=${result.mode} tag=${result.tag}: ${result.reason}`);
  const out = `mode=${result.mode}\ntag=${result.tag}\nversion=${result.version}\nlatest=${result.latest}\n`;
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, out);
  else process.stdout.write(out);
}

if (require.main === module) main();

module.exports = { decide };
