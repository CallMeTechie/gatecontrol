// Users list (/users), user profile (/users/:id) and device page, and the
// member side (/profile, /me → portal): list + filter, a row leads to the
// profile, old side-panel links (?user=&tab=) land on it, tabs by keyboard
// and in the address, header actions (edit, add device → access wizard up
// to the code, more → role dialog), edit access (PATCH), location sharing,
// device page with the map and the breadcrumb back, a dirty dialog asks
// before Escape discards it, invitation link → password → member sign-in,
// the member's navigation and guards, 390 px without horizontal scroll.
//
// No text comparisons: selectors, aria-/data- attributes, URLs and API answers.

// 1×1 grey PNG for the map tiles: the device page must not depend on
// tile.openstreetmap.org being reachable from the test runner.
const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGN48ewhAAVpArB44nOfAAAAAElFTkSuQmCC', 'base64');

module.exports = (ctx) => {
  const { BASE, FIXTURES, step, shot, api, visible } = ctx;
  const idle = (page) => page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const selected = async (page, tab) => await page.getAttribute(`#us-tab-${tab}`, 'aria-selected') === 'true';

  return {
    async users(page) {
      await page.context().clearCookies();
      await ctx.login(page);
      await page.route('https://tile.openstreetmap.org/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: TILE }));
      const M = FIXTURES.users.member;

      // ── List ──
      await page.goto(BASE + '/users');
      step('the list renders one row per user', await visible(page, '.us-row'));
      const total = (await api(page, 'GET', '/api/v1/users')).body.users.length;
      step('row count matches the API', (await page.$$('.us-row')).length === total);
      await page.click('[data-filter="member"]');
      const members = await page.$$eval('.us-row', (rs) => rs.length);
      const memberCount = Number(await page.textContent('[data-count="member"]'));
      step('the member filter shows the members', members === memberCount && memberCount > 0, `${members}/${memberCount}`);
      await page.click('[data-filter="all"]');
      step('the owner-less banner is shown (2 seeded)', await page.isVisible('#us-orphans'));
      step('no side panel on the list', !(await page.$('#us-detail')) && !(await page.$('#us-tabs')));
      const openHref = await page.getAttribute(`.us-row[data-user-id="${M}"] a.us-open`, 'href');
      step('"Öffnen" is a real link to the profile', openHref === `/users/${M}`, openHref);
      await shot(page, 'users-list');

      // ── Row → profile ──
      await Promise.all([page.waitForURL(`${BASE}/users/${M}`), page.click(`.us-row[data-user-id="${M}"] .us-col-dev`)]);
      step('a click on the row opens the profile', new URL(page.url()).pathname === `/users/${M}`, page.url());
      step('the header shows role and status', await visible(page, '#up-head-chips .us-chip') && (await page.$$('#up-head-chips .us-chip')).length === 2);
      step('the overview lists the devices with the shared location', await visible(page, '#us-panel-overview a.up-dev')
        && await page.isVisible('#us-panel-overview .up-loc-on'));
      step('the header actions are enabled', !(await page.isDisabled('#up-edit')) && !(await page.isDisabled('#up-add-device'))
        && !(await page.isDisabled('#up-toggle')) && !(await page.isDisabled('#up-more')));
      await idle(page);
      await shot(page, 'users-profile');

      // ── Tabs: old deep link, keyboard, address, in-page links ──
      await page.goto(`${BASE}/users?user=${M}&tab=see`);
      step('an old ?user=&tab= link lands on the profile tab', new URL(page.url()).pathname === `/users/${M}` && /tab=see/.test(page.url())
        && await visible(page, '#us-panel-see .us-see-group') && await selected(page, 'see'), page.url());
      await page.focus('#us-tab-see');
      await page.keyboard.press('ArrowRight');
      step('arrow keys move between tabs and the address follows',
        await selected(page, 'security') && /tab=security/.test(page.url()), page.url());
      await idle(page);
      await page.keyboard.press('Home');
      step('Home goes to the overview, the address drops ?tab', await selected(page, 'overview') && !/tab=/.test(page.url()), page.url());
      await visible(page, '#us-panel-overview .up-card a.up-link');
      await page.evaluate(() => { window.__samePage = true; });
      await page.click('#us-panel-overview .up-card a.up-link[href$="tab=activity"]');
      step('"Alle anzeigen" switches to the activity tab in place', await selected(page, 'activity')
        && await page.evaluate(() => window.__samePage === true) && /tab=activity/.test(page.url()));
      await idle(page);
      await page.click('#us-tab-access');
      step('the access tab lists the member\'s devices with "Gerät öffnen"', await visible(page, '#us-panel-access [data-token-id]')
        && (await page.$$('#us-panel-access a.us-dev-open')).length > 0);

      // ── Header: "Gerät hinzufügen" → wizard ──
      await page.click('#up-add-device');
      step('the wizard opens on step 1 for this user', await visible(page, '#us-dlg-wizard [data-page="1"]:not([hidden])')
        && await page.inputValue('#us-wz-owner') === String(M));
      await page.click('#us-wz-next');
      step('a missing name stops step 1', await page.isVisible('#us-wz-error'));
      await page.fill('#us-wz-name', 'E2E phone');
      await page.click('#us-wz-next');
      step('step 2 shows the presets', await visible(page, '#us-wz-presets .us-preset'));
      await page.click('#us-wz-next');
      step('step 3 shows the options', await visible(page, '#us-dlg-wizard [data-page="3"]:not([hidden])'));
      const [created] = await Promise.all([
        page.waitForResponse((r) => r.url().endsWith('/api/v1/enrollment') && r.request().method() === 'POST'),
        page.click('#us-wz-next'),
      ]);
      const body = created.request().postDataJSON();
      step('the device code is created for the member with app scopes', created.status() === 201 && body.userId === M
        && !body.scopes.includes('pihole:control') && !body.scopes.includes('full-access'), JSON.stringify(body.scopes));
      step('step 4 shows QR and code', await visible(page, '#us-wz-code-value:not(:empty)') && await page.isVisible('#us-wz-qr'));
      await shot(page, 'users-wizard-code', false);
      await page.click('#us-wz-next');
      step('closing the wizard stays on the profile', !(await page.isVisible('#us-dlg-wizard')) && new URL(page.url()).pathname === `/users/${M}`);

      // ── Edit access ──
      await idle(page);
      await page.click('#us-panel-access [data-token-id] .us-btn-chip');
      step('the edit dialog opens', await visible(page, '#us-dlg-edit .us-rights input'));
      await page.fill('#us-ed-name', 'Pixel 8 (E2E)');
      const [patch] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/v1/tokens/') && r.request().method() === 'PATCH'),
        page.click('#us-ed-save'),
      ]);
      step('saving sends PATCH /tokens/:id', patch.status() === 200);

      // ── Header: "Bearbeiten" (name, e-mail, language) ──
      await idle(page);
      await page.click('#up-edit');
      step('"Bearbeiten" opens the profile dialog with the current values', await visible(page, '#us-dlg-profile #us-pf-display')
        && await page.inputValue('#us-pf-email') === 'anna@example.com');
      await page.fill('#us-pf-display', 'Anna Schmidt-E2E');
      const [saved] = await Promise.all([
        page.waitForResponse((r) => r.url().endsWith(`/api/v1/users/${M}`) && r.request().method() === 'PATCH'),
        page.click('#us-pf-save'),
      ]);
      await idle(page);
      step('saving sends PATCH /users/:id and the header follows', saved.status() === 200
        && saved.request().postDataJSON().displayName === 'Anna Schmidt-E2E'
        && (await page.textContent('#up-name')) === 'Anna Schmidt-E2E');
      await api(page, 'PATCH', `/api/v1/users/${M}`, { displayName: 'Anna Schmidt' });

      // ── Header: "Mehr" → change role ──
      await page.click('#up-more');
      step('"Mehr" opens the menu', await visible(page, '#up-menu') && await page.getAttribute('#up-more', 'aria-expanded') === 'true');
      await page.click('#up-act-role');
      step('"Rolle ändern" opens its dialog on the profile', await visible(page, '#us-dlg-role') && !(await page.isVisible('#up-menu')));
      await page.waitForTimeout(400); // fade-in
      await shot(page, 'users-profile-role-dialog', false);
      await page.keyboard.press('Escape');
      step('Escape closes the unchanged dialog', !(await page.isVisible('#us-dlg-role')));

      // ── Location sharing ──
      await page.click('#us-tab-overview');
      await visible(page, '#up-loc-switch');
      const [off] = await Promise.all([
        page.waitForResponse((r) => r.url().endsWith(`/api/v1/users/${M}/location-sharing`) && r.request().method() === 'PUT'),
        page.click('#up-loc-switch'),
      ]);
      await idle(page);
      step('the location switch saves', off.status() === 200 && off.request().postDataJSON().enabled === false
        && await page.getAttribute('#up-loc-switch', 'aria-checked') === 'false');
      await Promise.all([
        page.waitForResponse((r) => r.url().endsWith(`/api/v1/users/${M}/location-sharing`) && r.request().method() === 'PUT'),
        page.click('#up-loc-switch'),
      ]);
      await idle(page);

      // ── Device page and back ──
      const dev = FIXTURES.devices.annaPixel;
      await Promise.all([page.waitForURL(`${BASE}/users/${M}/devices/${dev}`), page.click(`#us-panel-overview a.up-dev[href$="/devices/${dev}"]`)]);
      step('a device card opens the device page with the map', await visible(page, '#ud-map .leaflet-marker-icon'), page.url());
      const crumb = await page.getAttribute('.up-crumbs a[href^="/users/"]', 'href');
      step('the breadcrumb leads back to the devices tab', crumb === `/users/${M}?tab=access`, crumb);
      await idle(page);
      await shot(page, 'users-device');
      await Promise.all([page.waitForURL(`${BASE}/users/${M}?tab=access`), page.click('.up-crumbs a[href^="/users/"]')]);
      step('back on the profile, devices tab', await visible(page, '#us-panel-access [data-token-id]') && await selected(page, 'access'));
      await Promise.all([page.waitForURL(`${BASE}/users`), page.click('.up-crumbs a[href="/users"]')]);
      step('the breadcrumb "Benutzer" leads to the list', await visible(page, '.us-row'));

      // ── Dirty dialog ──
      await idle(page);
      await page.click('#us-btn-add');
      await page.fill('#us-c-username', 'typed');
      await page.keyboard.press('Escape');
      step('Escape on a changed form asks first', await visible(page, '.gcd-dialog', 3000) && await page.isVisible('#us-dlg-create'));
      await page.keyboard.press('Escape');
      step('keeping it leaves the input', await page.inputValue('#us-c-username') === 'typed');
      await page.click('#us-dlg-create .modal-close');
      await page.click('.gcd-dialog .btn-danger');
      step('discarding closes the dialog', !(await page.isVisible('#us-dlg-create')));

      // ── 390 px ──
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${BASE}/users`);
      await visible(page, '.us-card');
      step('390 px: cards instead of the table, no horizontal scroll', await page.isVisible('.us-card') && !(await page.isVisible('.us-table'))
        && await noOverflow(page));
      await shot(page, 'users-390');
      await Promise.all([page.waitForURL(`${BASE}/users/${M}`), page.click(`.us-card[data-user-id="${M}"] a.us-card-btn`)]);
      await visible(page, '#us-panel-overview a.up-dev');
      await idle(page);
      step('390 px: the profile does not scroll sideways; the tabs scroll on their own', await noOverflow(page)
        && await page.evaluate(() => { const t = document.getElementById('us-tabs'); return t.scrollWidth > t.clientWidth && getComputedStyle(t).overflowX === 'auto'; }));
      await shot(page, 'users-profile-390');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.unroute('https://tile.openstreetmap.org/**');

      // ── Invitation → member sign-in ──
      const kids = FIXTURES.users.kids;
      const inv = await api(page, 'POST', `/api/v1/users/${kids}/invite`, {});
      step('an invitation link is created', inv.status === 201 && /\/invite\//.test(inv.body.link));
      await page.context().clearCookies();
      await page.goto(BASE + inv.body.link.replace(/^https?:\/\/[^/]+/, ''));
      step('the invitation page shows the form', await visible(page, '#invite-form'));
      await page.fill('#password', 'Kids!Pass12345');
      await page.fill('#password_confirm', 'Kids!Pass12345');
      await Promise.all([page.waitForNavigation(), page.click('#invite-form button[type="submit"]')]);
      step('after setting the password the login page follows', /\/login$/.test(page.url()), page.url());
      await ctx.login(page, { username: 'e2e_kids', password: 'Kids!Pass12345' });
      step('the member lands on /profile', /\/profile$/.test(page.url()), page.url());
      // Let /profile finish its API reads before the cookies go: a read that
      // runs into the cleared session gets the login page and logs an error.
      await idle(page);

      // ── Member view ──
      await page.context().clearCookies();
      await ctx.login(page, FIXTURES.member);
      step('"Konto & Sicherheit" offers the portal PIN', await visible(page, '#pf-pin-open'));
      const nav = await page.$$eval('#sidebar a.nav-item', (as) => as.map((a) => a.getAttribute('href')));
      step('the member navigation is Portal + Konto & Sicherheit', nav.some((h) => /^https:\/\/home\./.test(h)) && nav.includes('/profile') && !nav.includes('/me')
        && !nav.some((h) => ['/dashboard', '/users', '/settings', '/peers'].includes(h)), nav.join(' '));
      step('no bottom navigation and no quick-add button', !(await page.$('.bottom-nav')) && !(await page.$('#fab-btn')));
      await page.goto(BASE + '/users');
      step('admin pages send the member to /profile', /\/profile$/.test(page.url()), page.url());
      const forbidden = await api(page, 'GET', '/api/v1/users');
      step('the admin API answers 403', forbidden.status === 403);
      ctx.allow((p) => p.kind === 'http' && p.status === 403 && p.url === '/api/v1/users');
      await shot(page, 'member-profile');

      await idle(page);
      await page.context().clearCookies();
      await ctx.login(page);
    },
  };
};
