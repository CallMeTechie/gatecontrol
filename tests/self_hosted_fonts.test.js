'use strict';

// The web fonts ship with the app (public/fonts/<version>/) instead of being
// loaded from Google at run time — privacy (no request to Google with the
// visitor's address) and installations without internet. Nothing the app
// delivers may point at fonts.googleapis.com / fonts.gstatic.com, the CSP no
// longer allows them, and the font files are cached for a year under a
// versioned path.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown, getAgent } = require('./helpers/setup');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// Plain substring check on the fixed host names (no regex): any mention counts.
const GOOGLE_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const assertNoGoogle = (text, what) => {
  for (const host of GOOGLE_HOSTS) assert.equal(text.includes(host), false, `${what}: names ${host}`);
};
const FONT_DIR = 'public/fonts/5.3.0';

// A file under a versioned path is cached as immutable for a year: its
// content must never change there. A new font version goes to a new directory.
const FONT_FILES = {
  'bricolage-grotesque-latin-opsz-normal.woff2': 'a79fdb52d4a5c76552452f69202add96e287401fff03d3e8c0e38b4dcb5a99cd',
  'bricolage-grotesque-latin-ext-opsz-normal.woff2': '776f6dcaf03636cd69a5802c94808cc8896c0a66c8e9ce0fe147231b6ee01957',
  'hanken-grotesk-latin-wght-normal.woff2': 'e9201eddf1d41d0b62253295d869ce3cf65768f7102b797f02c7f8c876b4a9d5',
  'hanken-grotesk-latin-ext-wght-normal.woff2': '768af2923e0ab1549f1dfba0a5c8ea749c4c01f01d8e77ffaf7fcd12f57a0a24',
  'jetbrains-mono-latin-wght-normal.woff2': '18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e',
  'jetbrains-mono-latin-ext-wght-normal.woff2': '79bfdab9ba467e26eea4122e6f2567e188dd8a09a8c730d501fc487c4ab99c6e',
};

function walk(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? walk(dir + '/' + d.name) : [dir + '/' + d.name]));
}

/** The @font-face rules of a stylesheet: family, weight, src url, display. */
function faces(css) {
  return Array.from(css.matchAll(/@font-face\s*\{([^}]*)\}/g)).map((m) => {
    const body = m[1];
    const get = (prop) => { const r = body.match(new RegExp(prop + ':\\s*([^;]+);')); return r ? r[1].trim() : null; };
    const src = body.match(/src:\s*url\('([^']+)'\)\s*format\('woff2'\)/);
    return { family: (get('font-family') || '').replace(/['"]/g, ''), weight: get('font-weight'), style: get('font-style'), display: get('font-display'), url: src && src[1] };
  });
}

let app;
before(async () => { ({ app } = await setup()); });
after(teardown);

describe('no web fonts from Google', () => {
  it('no template, server file, stylesheet or script names Google\'s font hosts', () => {
    const files = [...walk('templates'), ...walk('src'), ...walk('public/css'), ...walk('public/js')]
      .filter((f) => /\.(njk|js|css|html)$/.test(f));
    assert.ok(files.length > 50, 'the walk found the files');
    for (const f of files) assertNoGoogle(read(f), f);
  });

  it('the CSP allows fonts and stylesheets only from the app itself', async () => {
    const res = await supertest(app).get('/login').expect(200);
    const csp = res.headers['content-security-policy'];
    assert.ok(csp, 'CSP header');
    assertNoGoogle(csp, 'CSP');
    assert.match(csp, /(^|;)\s*font-src 'self'(;|$)/);
    assert.match(csp, /(^|;)\s*style-src-elem 'self' 'nonce-[^']+'(;|$)/);
  });

  it('delivered pages and stylesheets do not point at Google: login, error page, route-auth login, dashboard', async () => {
    const pages = [
      ['/login', await supertest(app).get('/login').expect(200)],
      ['error page', await supertest(app).post('/login').type('form').send({ username: 'x', password: 'y', _csrf: 'broken' }).expect(403)],
      ['/dashboard', await getAgent().get('/dashboard').expect(200)],
      ['/css/app.css', await supertest(app).get('/css/app.css').expect(200)],
      ['/css/portal.css', await supertest(app).get('/css/portal.css').expect(200)],
      ['/route-auth/static/css/app.css', await supertest(app).get('/route-auth/static/css/app.css').expect(200)],
    ];
    for (const [what, res] of pages) {
      assert.ok(res.text.length > 500, what + ' has content');
      assertNoGoogle(res.text, what);
    }
  });
});

describe('the fonts ship with the app', () => {
  it('exactly the six woff2 files and an OFL licence per family lie in the versioned directory', () => {
    const files = fs.readdirSync(path.join(ROOT, FONT_DIR)).sort();
    assert.deepEqual(files.filter((f) => f.endsWith('.woff2')), Object.keys(FONT_FILES).sort());
    for (const fam of ['bricolage-grotesque', 'hanken-grotesk', 'jetbrains-mono']) {
      const lic = read(`${FONT_DIR}/${fam}-OFL.txt`);
      assert.match(lic, /SIL OPEN FONT LICENSE Version 1\.1/i, fam);
    }
    for (const f of Object.keys(FONT_FILES)) {
      const buf = fs.readFileSync(path.join(ROOT, FONT_DIR, f));
      assert.equal(buf.subarray(0, 4).toString('latin1'), 'wOF2', f + ' is woff2');
      assert.ok(buf.length < 100 * 1024, f + ' stays small (subset)');
    }
  });

  it('the content of a font file never changes under its path (cached as immutable)', () => {
    for (const [f, pinned] of Object.entries(FONT_FILES)) {
      const sum = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, FONT_DIR, f))).digest('hex');
      assert.equal(sum, pinned, `${f} changed — put a new version into a new directory (public/fonts/<version>/)`);
    }
  });

  it('app.css declares the same families and weights the Google stylesheet served, with font-display: swap', () => {
    const fs_ = faces(read('public/css/app.css'));
    const want = { 'Bricolage Grotesque': ['500', '700', '800'], 'Hanken Grotesk': ['400', '500', '600', '700'], 'JetBrains Mono': ['500', '700'] };
    for (const [family, weights] of Object.entries(want)) {
      const mine = fs_.filter((f) => f.family === family);
      assert.deepEqual([...new Set(mine.map((f) => f.weight))].sort(), weights, family);
      assert.equal(mine.length, weights.length * 2, family + ': latin + latin-ext per weight');
    }
    assert.equal(fs_.length, 18);
    for (const f of fs_) {
      assert.equal(f.display, 'swap', f.family);
      assert.equal(f.style, 'normal', f.family);
      assert.match(f.url, /^\.\.\/fonts\/\d+\.\d+\.\d+\/[a-z-]+\.woff2$/, 'relative url (also served under /route-auth/static/): ' + f.url);
    }
  });

  it('portal.css declares all three families, latin + latin-ext, with font-display: swap', () => {
    const fs_ = faces(read('public/css/portal.css'));
    for (const family of ['Bricolage Grotesque', 'Hanken Grotesk', 'JetBrains Mono']) {
      assert.ok(fs_.some((f) => f.family === family && /-latin-ext-/.test(f.url)), family + ' latin-ext');
      assert.ok(fs_.some((f) => f.family === family && /-latin-(opsz|wght)-/.test(f.url)), family + ' latin');
    }
    assert.deepEqual([...new Set(fs_.filter((f) => f.family === 'Hanken Grotesk').map((f) => f.weight))].sort(), ['400', '500', '600', '700']);
    for (const f of fs_) assert.equal(f.display, 'swap', f.family);
  });

  it('every font url of the stylesheets and every font preload of the portal pages exists', () => {
    const urls = [
      ...faces(read('public/css/app.css')).map((f) => path.posix.join('public/css', f.url)),
      ...faces(read('public/css/portal.css')).map((f) => path.posix.join('public/css', f.url)),
    ];
    for (const t of ['portal', 'kiosk', 'who']) {
      for (const m of read(`templates/portal/${t}.njk`).matchAll(/<link rel="preload" as="font"[^>]*href="([^"]+)"/g)) urls.push('public' + m[1]);
    }
    assert.ok(urls.length >= 30);
    for (const u of urls) assert.ok(fs.existsSync(path.join(ROOT, u)), u);
  });
});

describe('the font files are served with a long cache time', () => {
  for (const prefix of ['', '/route-auth/static']) {
    it(`${prefix || '/'}fonts/<version>/*.woff2: 200, font/woff2, cached for a year as immutable`, async () => {
      for (const f of Object.keys(FONT_FILES)) {
        const res = await supertest(app).get(`${prefix}/fonts/5.3.0/${f}`).expect(200);
        assert.equal(res.headers['content-type'], 'font/woff2', f);
        assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable', f);
      }
    });
  }

  it('other static files keep their cache time (not immutable)', async () => {
    const res = await supertest(app).get('/css/app.css').expect(200);
    assert.doesNotMatch(res.headers['cache-control'] || '', /immutable/);
    const lic = await supertest(app).get('/fonts/5.3.0/hanken-grotesk-OFL.txt').expect(200);
    assert.doesNotMatch(lic.headers['cache-control'] || '', /immutable/);
  });
});
