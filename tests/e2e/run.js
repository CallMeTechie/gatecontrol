#!/usr/bin/env node
'use strict';

// Browser-Tests gegen eine laufende GateControl-Instanz mit Test-Datenbank.
//
//   node tests/e2e/seed.js                     # Fixtures in die DB
//   node src/server.js &                       # App mit Test-Umgebung
//   node tests/e2e/run.js login zones security passkey # oder: all
//
// Playwright ist KEINE Abhängigkeit des Projekts (package.json bleibt
// unverändert). Der Lauf braucht es im Modulpfad — in der CI über den
// Job-Container mcr.microsoft.com/playwright:v1.63.0-noble plus
// `npm install --no-save playwright@1.63.0`, lokal genauso (siehe README
// daneben).
//
// Ausgabe: eine Zeile je Schritt und am Ende ein JSON-Bericht. Exit 1, sobald
// ein Schritt fehlschlägt oder die Seite einen Konsolenfehler, einen
// Skriptfehler oder eine Antwort >= 400 produziert hat.

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { isExternalNetError } = require('./page-problems');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const OUT = process.env.E2E_OUT || path.join(process.env.GC_DATA_DIR || '.', 'e2e-out');
const FIXTURES = JSON.parse(fs.readFileSync(process.env.E2E_FIXTURES || path.join(process.env.GC_DATA_DIR || '.', 'e2e-fixtures.json'), 'utf8'));

const steps = [];
const problems = [];
// console errors that are not faults of the app (page-problems.js): shown, not counted
const notes = [];
// In GitHub Actions every failed step and page problem also becomes an error
// annotation, so the check run names it (job logs are not always reachable).
function annotate(msg, level = 'error') {
  if (!process.env.GITHUB_ACTIONS) return;
  console.log(`::${level} title=Browser test::` + String(msg).replace(/%/g, '%25').replace(/\r?\n/g, ' ').slice(0, 900));
}
function step(name, ok, info) {
  steps.push({ name, ok, ...(info ? { info } : {}) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
  if (!ok) annotate(`${name}${info ? ' — ' + info : ''}`);
}

const ctx = {
  BASE, OUT, FIXTURES, step, problems,
  async visible(page, sel, timeout = 6000) {
    try { await page.waitForSelector(sel, { state: 'visible', timeout }); return true; } catch { return false; }
  },
  async waitIdle(page) {
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(150);
  },
  text: async (page, sel) => ((await page.locator(sel).first().textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim(),
  async api(page, method, url, body) {
    const headers = method === 'GET' ? {} : { 'X-CSRF-Token': await page.evaluate(() => window.GC && window.GC.csrfToken) };
    const r = await page.request.fetch(BASE + url, { method, data: body, headers });
    return { status: r.status(), body: await r.json().catch(() => null) };
  },
  async login(page, user = FIXTURES.admin) {
    await page.goto(BASE + '/login');
    await page.fill('input[name="username"]', user.username);
    await page.fill('input[name="password"]', user.password);
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
    return page.url();
  },
  // A full load of an address: a fresh document that knows nothing of the page before. Not
  // page.goto(<the open page>#hash) + page.reload(): when the page itself changes its address
  // (replaceState) right then, Chromium can keep the address before for the reload — it loads
  // without the hash (gatewaywizard, runs 43863311002 and 44508800779: the overview instead of #gw/<id>).
  async loadFresh(page, url) {
    await page.goto('about:blank');
    return page.goto(url);
  },
  navLog: (page) => page.evaluate(() => window.__gcNav || []).catch((e) => [String(e).slice(0, 120)]),
  shot: (page, name, full = true) => page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: full }).catch(() => {}),
  // Antworten, die ein Szenario absichtlich provoziert, wieder austragen.
  allow(...preds) {
    for (let i = problems.length - 1; i >= 0; i--) if (preds.some((f) => f(problems[i]))) problems.splice(i, 1);
  },
};

const scenarios = {};
const dir = path.join(__dirname, 'scenarios');
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
  Object.assign(scenarios, require(path.join(dir, f))(ctx));
}

async function main() {
  let wanted = process.argv.slice(2);
  if (!wanted.length || wanted[0] === 'all') wanted = Object.keys(scenarios);
  const unknown = wanted.filter((s) => !scenarios[s]);
  if (unknown.length) {
    console.error(`unknown scenario(s): ${unknown.join(', ')} — have: ${Object.keys(scenarios).join(', ')}`);
    process.exit(2);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // Where the page has been (ctx.navLog): the address each document was loaded with and every
  // change of it since — hash changes, pushState/replaceState with the script line that called it.
  // For the info of a failed step: "loaded without the hash" and "the hash was taken later" look
  // the same on a screenshot.
  await context.addInitScript(() => {
    const log = [];
    Object.defineProperty(window, '__gcNav', { value: log });
    const add = (kind, by) => {
      log.push({ ms: Math.round(performance.now()), kind, url: location.pathname + location.search + location.hash, ...(by ? { by } : {}) });
      if (log.length > 30) log.shift();
    };
    // [0] Error, [1] this arrow, [2] the wrapper below, [3] the caller
    const caller = () => ((new Error().stack || '').split('\n')[3] || '').trim().replace(location.origin, '').slice(0, 160);
    for (const k of ['pushState', 'replaceState']) {
      const orig = history[k];
      history[k] = function (...a) { const r = orig.apply(this, a); add(k, caller()); return r; };
    }
    addEventListener('hashchange', () => add('hashchange'));
    add('load');
  });
  const page = await context.newPage();
  // every problem names its scenario and, for a console line, where it came from (a "Failed to load
  // resource" alone does not say which request it was)
  let current = '';
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const at = (m.location() && m.location().url) || '';
    const p = { kind: 'console', scenario: current, text: m.text().slice(0, 300), ...(at ? { at: at.replace(BASE, '').slice(0, 200) } : {}) };
    if (isExternalNetError(m.text(), at, BASE)) { notes.push(p); console.log(`note (not counted): another host was not reached — ${JSON.stringify(p)}`); return; }
    problems.push(p);
  });
  page.on('pageerror', (e) => problems.push({ kind: 'pageerror', scenario: current, text: String(e).slice(0, 300) }));
  page.on('response', (r) => {
    const u = r.url();
    if (u.startsWith(BASE) && r.status() >= 400 && !u.includes('/favicon')) problems.push({ kind: 'http', scenario: current, status: r.status(), url: u.replace(BASE, '') });
  });

  for (const name of wanted) {
    console.log(`\n── ${name} ──`);
    current = name;
    try {
      await scenarios[name](page);
    } catch (e) {
      step(`${name}: scenario crashed`, false, String(e).slice(0, 400));
      await ctx.shot(page, `crash-${name}`);
    }
  }
  await browser.close();

  const failed = steps.filter((s) => !s.ok);
  console.log('\n' + JSON.stringify({ scenarios: wanted, steps: steps.length, failed: failed.length, problems, ...(notes.length ? { notes } : {}) }, null, 1));
  for (const p of problems.slice(0, 20)) annotate('page problem: ' + JSON.stringify(p));
  for (const p of notes.slice(0, 5)) annotate('not counted, another host was not reached: ' + JSON.stringify(p), 'warning');
  if (failed.length || problems.length) {
    console.error(`\n${failed.length} step(s) failed, ${problems.length} page problem(s).`);
    process.exit(1);
  }
  console.log(`\nall ${steps.length} steps ok`);
}

main().catch((e) => { console.error(e); process.exit(1); });
