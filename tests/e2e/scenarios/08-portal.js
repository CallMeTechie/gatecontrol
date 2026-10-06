'use strict';

// Portal (redesign "variant A"): the app's one-time login link signs the
// device owner in, tabs are URL-addressable and keyboard-operable, sensitive
// actions ask first, 390 px without horizontal scroll; a shared device asks
// "Wer bist du?" (wrong PIN, right PIN) and offers the anonymous mode.
//
// The portal lives on its own host (home.<GC_DNS_DOMAIN>) and identifies the
// device by the X-GC-Portal-Peer-IP header Caddy sets. Without Caddy this
// scenario uses an own browser that resolves the portal host to 127.0.0.1
// and adds the header to portal-host requests itself (the app only trusts it
// from loopback).
// bypassCSP: the portal's CSP says upgrade-insecure-requests, and this run is
// plain http.
//
// No text comparisons: selectors, aria-/data- attributes, URLs, API answers.

module.exports = (ctx) => {
  const { BASE, FIXTURES, step, shot, problems } = ctx;

  return {
    async portal() {
      const { chromium } = require('playwright');
      const P = FIXTURES.portal;
      const port = new URL(BASE).port || '80';
      const HOST = `home.${process.env.GC_DNS_DOMAIN || 'gc.internal'}`;
      const PORTAL = `http://${HOST}:${port}`;
      const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] });
      const expected = [];
      async function open(ip, width = 1440) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, bypassCSP: true });
        // The identity header only on requests to the portal host — as an
        // extraHTTPHeaders entry it would also go to fonts.gstatic.com and
        // fail the CORS preflight of the web fonts.
        await context.route((url) => url.hostname === HOST, (route) => route.continue({
          headers: Object.assign({}, route.request().headers(), { 'x-gc-portal-peer-ip': ip }),
        }));
        const p = await context.newPage();
        p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|Cross-Origin-Opener-Policy/.test(m.text())) problems.push({ kind: 'console', text: m.text().slice(0, 300) }); });
        p.on('pageerror', (e) => problems.push({ kind: 'pageerror', text: String(e).slice(0, 300) }));
        p.on('response', (r) => {
          const u = r.url();
          if (u.startsWith(PORTAL) && r.status() >= 400 && !u.includes('/favicon') && !expected.some((f) => f(r))) {
            problems.push({ kind: 'http', status: r.status(), url: u.replace(PORTAL, 'portal:') });
          }
        });
        return { context, p };
      }
      const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      const selected = (p) => p.getAttribute('.pt-tab[aria-selected="true"]', 'data-tab');

      try {
        // ── One-time link → signed in ──
        const r = await fetch(BASE + '/api/v1/client/portal-link', { method: 'POST', headers: { Authorization: `Bearer ${P.token}`, 'Content-Type': 'application/json' }, body: '{}' });
        const body = await r.json().catch(() => ({}));
        step('the app gets a one-time portal link (60 s)', r.status === 200 && body.expiresIn === 60 && /\/auto\?t=[A-Za-z0-9_-]{43}$/.test(body.url || ''));
        const { context, p } = await open(P.ip);
        const u = new URL(body.url);
        await p.goto(PORTAL + u.pathname + u.search);
        await p.waitForLoadState('networkidle').catch(() => {});
        step('the link signs the owner in, the ticket leaves the URL', /\/portal$/.test(p.url()) && await p.getAttribute('.pt-user', 'data-via') === 'link', p.url());
        await p.goto(PORTAL + u.pathname + u.search);
        step('the link works only once (a second use shows the anonymous portal with a note)',
          await p.getAttribute('.pt-user', 'data-viewer') === 'anonymous' && await p.isVisible('#pt-note'));
        // sign in again with a fresh link
        const r2 = await (await fetch(BASE + '/api/v1/client/portal-link', { method: 'POST', headers: { Authorization: `Bearer ${P.token}` } })).json();
        const u2 = new URL(r2.url);
        await p.goto(PORTAL + u2.pathname + u2.search);
        await p.waitForLoadState('networkidle').catch(() => {});

        // ── Tabs ──
        const tabs = await p.$$eval('.pt-tab:not([hidden])', (as) => as.map((a) => a.getAttribute('data-tab')));
        step('the tabs of the member: start, services, network, own devices', ['start', 'dienste', 'netzwerk', 'geraete'].every((t) => tabs.includes(t)), tabs.join(' '));
        await p.click('.pt-tab[data-tab="geraete"]');
        step('a tab is URL-addressable', /#geraete$/.test(p.url()) && await p.isVisible('#panel-geraete') && !(await p.isVisible('#panel-start')));
        await p.focus('.pt-tab[data-tab="geraete"]');
        await p.keyboard.press('Home');
        step('Home moves to the first tab', await selected(p) === 'start' && await p.evaluate(() => document.activeElement.getAttribute('data-tab')) === 'start');
        await p.keyboard.press('ArrowRight');
        step('arrow keys move through the tabs', await selected(p) === tabs[1]);
        await p.goto(PORTAL + '/portal#netzwerk');
        await p.waitForLoadState('networkidle').catch(() => {});
        step('a deep link opens its tab', await selected(p) === 'netzwerk' && await p.isVisible('#panel-netzwerk'));

        // ── Own devices: locking asks first ──
        await p.click('.pt-tab[data-tab="geraete"]');
        await p.waitForSelector('#pt-devices [data-act="lock"]', { timeout: 6000 }).catch(() => {});
        let deleted = 0;
        p.on('request', (q) => { if (q.method() === 'DELETE') deleted += 1; });
        await p.click('#pt-devices [data-act="lock"]');
        step('"Gerät sperren" asks first', await p.isVisible('.pt-dialog[role="alertdialog"]'));
        await p.keyboard.press('Escape');
        await p.waitForTimeout(300);
        step('Escape cancels, nothing is locked', !(await p.isVisible('.pt-dialog')) && deleted === 0);
        await shot(p, 'portal-devices');

        // ── 390 px ──
        await p.setViewportSize({ width: 390, height: 844 });
        await p.goto(PORTAL + '/portal#start');
        await p.waitForLoadState('networkidle').catch(() => {});
        step('390 px: no horizontal scroll, the tab bar scrolls by itself', await noOverflow(p)
          && await p.evaluate(() => { const l = document.querySelector('.pt-tablist'); return getComputedStyle(l).overflowX === 'auto'; }));
        await shot(p, 'portal-390');
        await context.close();

        // ── Shared device: "Wer bist du?" ──
        const s = await open(P.sharedIp);
        await s.p.goto(PORTAL + '/portal');
        step('a shared device asks "Wer bist du?"', /\/portal\/who$/.test(s.p.url()) && await s.p.isVisible('.pt-person'));
        expected.push((res) => res.status() === 400 && /\/portal\/who$/.test(res.url()));
        await s.p.click('.pt-person:has(input[value="' + FIXTURES.member.id + '"])');
        await s.p.fill('#pt-who-pin-input', '0000');
        await Promise.all([s.p.waitForNavigation(), s.p.click('#pt-who-submit')]);
        step('a wrong PIN is refused', await s.p.isVisible('#pt-who-error'));
        await s.p.fill('#pt-who-pin-input', P.pin);
        await Promise.all([s.p.waitForNavigation(), s.p.click('#pt-who-submit')]);
        await s.p.waitForLoadState('networkidle').catch(() => {});
        step('the right PIN opens the portal of that person', /\/portal$/.test(s.p.url()) && await s.p.getAttribute('.pt-user', 'data-via') === 'pin');
        await Promise.all([s.p.waitForNavigation(), s.p.click('#pt-switch')]);
        step('"Person wechseln" returns to the picker', /\/portal\/who$/.test(s.p.url()));
        await Promise.all([s.p.waitForNavigation(), s.p.click('#pt-who-anon')]);
        await s.p.waitForLoadState('networkidle').catch(() => {});
        step('the anonymous mode shows nobody', await s.p.getAttribute('.pt-user', 'data-viewer') === 'anonymous' && !(await s.p.$('.pt-tab[data-tab="geraete"]')));
        await shot(s.p, 'portal-anonymous');
        await s.context.close();
      } finally {
        await browser.close();
      }
    },
  };
};
