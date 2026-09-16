#!/usr/bin/env node
'use strict';

// Browser-Tests gegen eine laufende GateControl-Instanz mit Test-Datenbank.
//
//   node tests/e2e/seed.js                     # Fixtures in die DB
//   node src/server.js &                       # App mit Test-Umgebung
//   node tests/e2e/run.js login zones security # oder: all
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

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const OUT = process.env.E2E_OUT || path.join(process.env.GC_DATA_DIR || '.', 'e2e-out');
const FIXTURES = JSON.parse(fs.readFileSync(process.env.E2E_FIXTURES || path.join(process.env.GC_DATA_DIR || '.', 'e2e-fixtures.json'), 'utf8'));

const steps = [];
const problems = [];
function step(name, ok, info) {
  steps.push({ name, ok, ...(info ? { info } : {}) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
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
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push({ kind: 'console', text: m.text().slice(0, 300) }); });
  page.on('pageerror', (e) => problems.push({ kind: 'pageerror', text: String(e).slice(0, 300) }));
  page.on('response', (r) => {
    const u = r.url();
    if (u.startsWith(BASE) && r.status() >= 400 && !u.includes('/favicon')) problems.push({ kind: 'http', status: r.status(), url: u.replace(BASE, '') });
  });

  for (const name of wanted) {
    console.log(`\n── ${name} ──`);
    try {
      await scenarios[name](page);
    } catch (e) {
      step(`${name}: scenario crashed`, false, String(e).slice(0, 400));
      await ctx.shot(page, `crash-${name}`);
    }
  }
  await browser.close();

  const failed = steps.filter((s) => !s.ok);
  console.log('\n' + JSON.stringify({ scenarios: wanted, steps: steps.length, failed: failed.length, problems }, null, 1));
  if (failed.length || problems.length) {
    console.error(`\n${failed.length} step(s) failed, ${problems.length} page problem(s).`);
    process.exit(1);
  }
  console.log(`\nall ${steps.length} steps ok`);
}

main().catch((e) => { console.error(e); process.exit(1); });
