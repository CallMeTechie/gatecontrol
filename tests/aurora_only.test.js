'use strict';

// Aurora is the only theme (docs/feature-aurora-only.md): the Default and Pro
// template sets are gone, the standalone pages (login, 2FA login, error page,
// route-auth login) load the one stylesheet app.css (docs/feature-wave2.md §W2),
// and neither the default_theme setting nor GC_DEFAULT_THEME nor users.theme
// select anything.

// The host .env still carries GC_DEFAULT_THEME=default — it must be ignored.
process.env.GC_DEFAULT_THEME = 'default';

const fs = require('node:fs');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const STANDALONE = ['login', 'login-2fa', 'error', 'route-auth-login'];
// Merged into public/css/app.css by wave 2 strand W2 (docs/feature-wave2.md §W2).
const MERGED = ['pro.css', 'aurora.css', 'security.css', 'nav.css', 'ops.css', 'problems.css', 'l4-protect.css', 'two-factor.css'];
const APP_CSS = () => read('public/css/app.css');
// §1 = former pro.css, §2 = former aurora.css, §3… = the feature sections.
function appSection(n, css = APP_CSS()) {
  const a = css.indexOf(`\n * §${n} `);
  assert.ok(a > 0, `app.css section §${n}`);
  const b = css.indexOf(`\n * §${n + 1} `);
  return css.slice(a, b < 0 ? css.length : b);
}

let app;
before(async () => { ({ app } = await setup()); });
after(teardown);

function cssLinks(html) {
  return Array.from(html.matchAll(/<link rel="stylesheet" href="([^"?]+)/g)).map((m) => m[1]);
}
function assertAurora(html, what, prefix = '/css/') {
  const css = cssLinks(html);
  assert.deepEqual(css, [prefix + 'app.css'], `${what}: exactly one stylesheet, app.css`);
  assert.doesNotMatch(html, /route-auth\.css|\/css\/(pro|aurora|security|nav|ops|problems|l4-protect|two-factor)\.css/, `${what}: no merged-away stylesheet`);
  assert.match(html, /family=Bricolage\+Grotesque[^"]*Hanken\+Grotesk[^"]*JetBrains\+Mono/, `${what}: Aurora fonts`);
  assert.doesNotMatch(html, /family=(Inter|Outfit|DM\+Serif)/, `${what}: no Default/Pro fonts`);
  assert.match(html, /gc-theme-mode/, `${what}: dark/light pre-paint like layout.njk`);
  assert.match(html, /<body class="au-page">/, `${what}: auth-page layout`);
}

describe('Default and Pro are gone', () => {
  it('templates/default and templates/pro no longer exist; aurora is the only template set', () => {
    assert.equal(fs.existsSync(path.join(ROOT, 'templates/default')), false);
    assert.equal(fs.existsSync(path.join(ROOT, 'templates/pro')), false);
    const sets = fs.readdirSync(path.join(ROOT, 'templates'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, 'templates', d.name, 'layout.njk')))
      .map((d) => d.name);
    assert.deepEqual(sets, ['aurora']);
  });

  it('route-auth.css and the seven merged stylesheets are gone; app.css is served', async () => {
    assert.equal(fs.existsSync(path.join(ROOT, 'public/css/route-auth.css')), false);
    for (const f of MERGED) assert.equal(fs.existsSync(path.join(ROOT, 'public/css', f)), false, f + ' merged into app.css');
    assert.equal(fs.existsSync(path.join(ROOT, 'public/css/app.css')), true);
    const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
      .flatMap((d) => (d.isDirectory() ? walk(dir + '/' + d.name) : [dir + '/' + d.name]));
    for (const f of [...walk('templates'), ...walk('src')].filter((x) => /\.(njk|js)$/.test(x))) {
      assert.doesNotMatch(read(f), /route-auth\.css/, f);
      for (const m of MERGED) assert.doesNotMatch(read(f), new RegExp('/css/' + m.replace('.', '\\.')), `${f} still links ${m}`);
    }
    await supertest(app).get('/css/app.css').expect(200);
    await supertest(app).get('/css/pro.css').expect(404);
    await supertest(app).get('/route-auth/static/css/app.css').expect(200);
  });

  it('GC_DEFAULT_THEME is ignored by the config', () => {
    assert.equal(require('../config/default').theme.defaultTheme, 'aurora');
  });
});

describe('standalone pages load exactly one stylesheet', () => {
  for (const page of STANDALONE) {
    it(`aurora/pages/${page}.njk links app.css and nothing else`, () => {
      const src = read(`templates/aurora/pages/${page}.njk`);
      const links = Array.from(src.matchAll(/<link rel="stylesheet" href="([^"?]+)/g)).map((m) => m[1]);
      assert.equal(links.length, 1, links.join(','));
      assert.match(links[0], /\/css\/app\.css$/);
      assert.doesNotMatch(src, /route-auth\.css/);
      assert.match(src, /<script nonce="\{\{ cspNonce \}\}">\s*\(function\(\)\{try\{var s=localStorage\.getItem\('gc-theme-mode'\)/);
    });
  }

  it('every page that does not extend the layout loads app.css — exactly once', () => {
    for (const f of fs.readdirSync(path.join(ROOT, 'templates/aurora/pages'))) {
      const src = read('templates/aurora/pages/' + f);
      if (/\{% extends/.test(src)) continue;
      const links = Array.from(src.matchAll(/<link rel="stylesheet" href="([^"?]+)/g)).map((m) => m[1]);
      assert.deepEqual(links.filter((l) => /app\.css$/.test(l)).length, 1, f + ': ' + links.join(','));
    }
  });

  it('the layout and every page together link at most app.css plus a page-local integration sheet', () => {
    const all = [read('templates/aurora/layout.njk'), ...fs.readdirSync(path.join(ROOT, 'templates/aurora/pages')).map((f) => read('templates/aurora/pages/' + f))];
    for (const src of all) {
      for (const m of src.matchAll(/<link rel="stylesheet" href="([^"?]+)/g)) {
        assert.match(m[1], /\/(app|midea|skoda|smarthome)\.css$/, m[1]);
      }
    }
  });
});

describe('the login page renders Aurora whatever was configured before', () => {
  for (const stored of ['pro', 'default', 'aurora']) {
    it(`/login with default_theme=${stored} and GC_DEFAULT_THEME=default`, async () => {
      require('../src/services/settings').set('default_theme', stored);
      const res = await supertest(app).get('/login').expect(200);
      assertAurora(res.text, '/login');
      assert.match(res.text, /name="username"/);
      assert.match(res.text, /name="password"/);
      assert.match(res.text, /id="au-pw-toggle"/, 'password reveal button (no inline onclick)');
      assert.doesNotMatch(res.text, /onclick=/, 'no inline handlers (CSP blocks them)');
    });
  }

  it('the error page (invalid CSRF token) renders Aurora', async () => {
    require('../src/services/settings').set('default_theme', 'pro');
    const res = await supertest(app).post('/login').type('form').send({ username: 'x', password: 'y', _csrf: 'broken' }).expect(403);
    assertAurora(res.text, 'error page');
    assert.match(res.text, /class="card au-card au-center"/);
  });

  it('the route-auth login renders Aurora via /route-auth/static/, keeps the JS hooks and the branding colour', async () => {
    const { getDb } = require('../src/db/connection');
    require('../src/services/settings').set('default_theme', 'pro');
    const rid = getDb().prepare("INSERT INTO routes (domain, target_ip, target_port, enabled, branding_color, branding_title) VALUES ('ra.example.com', '10.0.0.9', 80, 1, '#aa3300', 'Acme')").run().lastInsertRowid;
    getDb().prepare("INSERT INTO route_auth (route_id, auth_type, email) VALUES (?, 'email_password', 'a@example.com')").run(rid);
    const res = await supertest(app).get('/route-auth/login?route=ra.example.com').expect(200);
    assertAurora(res.text, 'route-auth login', '/route-auth/static/css/');
    assert.match(res.text, /\/route-auth\/static\/css\/app\.css\?v=\d+\.\d+\.\d+/, 'cache-busted with the app version');
    for (const id of ['login-form', 'form-error', 'login-btn', 'email', 'password']) assert.match(res.text, new RegExp(`id="${id}"`), id);
    assert.match(res.text, /class="au-domain"[\s\S]*?ra\.example\.com/);
    assert.match(res.text, /<style nonce="[^"]+">\s*\.au-page \.btn-primary \{ background: #aa3300;/, 'branding colour applied');
    assert.match(res.text, /<span class="nm">Acme<\/span>/, 'branding title');
    assert.match(res.text, /<script src="\/route-auth\/static\/js\/route-auth-login\.js" nonce=/);
  });
});

describe('app.css §2 (Aurora): auth-page section', () => {
  it('is the last section of §2, carries the auth-page rules and keeps braces balanced', () => {
    const css = appSection(2);
    const marker = '/* ─── Auth pages (au-) ─── */';
    const at = css.indexOf(marker);
    assert.ok(at > 0, 'section marker');
    assert.equal(css.indexOf('/* ─── ', at + 1), -1, 'last section of §2');
    assert.doesNotMatch(css.slice(0, at).replace(/\/\*[\s\S]*?\*\//g, ''), /\.au-[a-z]/, 'no au- rules before the section');
    for (const cls of ['body.au-page', '.au-wrap', '.au-brand', '.card.au-card', '.au-title', '.au-pw-toggle', '.btn.au-submit', '.btn.is-loading',
      '.au-card .login-error', '.au-card .form-error.visible', '.au-links', '.au-domain', '.au-steps', '.au-step.active', '.au-code input', '.au-code input.filled', '.au-foot']) {
      assert.ok(css.includes(cls), cls);
    }
    const whole = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal((whole.match(/\{/g) || []).length, (whole.match(/\}/g) || []).length, 'braces balanced');
  });

  it('classes used by the auth templates are styled (au-*) and route-auth-login.js state classes exist', () => {
    const css = APP_CSS();
    const used = new Set();
    for (const page of STANDALONE) {
      for (const m of read(`templates/aurora/pages/${page}.njk`).matchAll(/class="([^"{]+)"/g)) m[1].split(/\s+/).filter((c) => c.startsWith('au-')).forEach((c) => used.add(c));
    }
    assert.ok(used.size >= 15, [...used].join(' '));
    for (const c of used) assert.ok(css.includes('.' + c), `.${c} styled`);
    const js = read('public/js/route-auth-login.js');
    for (const c of ['visible', 'is-loading', 'filled']) assert.match(js, new RegExp(`classList\\.(add|remove)\\('${c}'\\)`), c);
  });
});

describe('settings UI: no theme choice', () => {
  it('settings.js and profile.js no longer talk to the theme endpoints', () => {
    assert.doesNotMatch(read('public/js/settings.js'), /default-theme/);
    assert.doesNotMatch(read('public/js/profile.js'), /theme-buttons|\{ theme:/);
  });
});
