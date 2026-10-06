'use strict';

// Users page (/users) and the member side (/profile, /me → portal): list + filter, detail panel
// deep link (?user=&tab=) and keyboard tabs, the access wizard up to the code
// step, edit access (PATCH), a dirty dialog asks before Escape discards it,
// invitation link → password → member sign-in, the member's navigation and
// guards, 390 px without horizontal scroll.
//
// No text comparisons: selectors, aria-/data- attributes, URLs and API answers.

module.exports = (ctx) => {
  const { BASE, FIXTURES, step, shot, api, visible } = ctx;
  const idle = (page) => page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  return {
    async users(page) {
      await page.context().clearCookies();
      await ctx.login(page);
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
      await shot(page, 'users-list');

      // ── Detail deep link + tabs ──
      await page.goto(`${BASE}/users?user=${M}&tab=see`);
      step('?user=&tab=see opens the detail on that tab', await visible(page, '#us-panel-see .us-see-group')
        && await page.getAttribute('#us-tab-see', 'aria-selected') === 'true');
      await page.focus('#us-tab-see');
      await page.keyboard.press('ArrowRight');
      step('arrow keys move between tabs and the address follows',
        await page.getAttribute('#us-tab-security', 'aria-selected') === 'true' && /tab=security/.test(page.url()), page.url());
      await idle(page);
      await page.click('#us-tab-access');
      step('the access tab lists the member\'s devices', await visible(page, '#us-panel-access [data-token-id]'));

      // ── Wizard ──
      await page.click('#us-panel-access .us-sec-head .btn-primary');
      step('the wizard opens on step 1', await visible(page, '#us-dlg-wizard [data-page="1"]:not([hidden])'));
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
      await page.goto(`${BASE}/users?user=${M}&tab=overview`);
      await visible(page, '#us-panel-overview .us-tiles');
      step('390 px: cards instead of the table, no horizontal scroll', await page.isVisible('.us-card') && !(await page.isVisible('.us-table'))
        && await noOverflow(page));
      await shot(page, 'users-390');
      await page.setViewportSize({ width: 1440, height: 1000 });

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

      await page.context().clearCookies();
      await ctx.login(page);
    },
  };
};
