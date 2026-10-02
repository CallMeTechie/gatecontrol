'use strict';

// Passkey (WebAuthn) — docs/feature-admin-passkeys.md.
//
// Chromium's virtual authenticator (CDP WebAuthn domain) stands in for Touch
// ID / Windows Hello / a security key: a CTAP2 "internal" authenticator with
// resident keys and user verification, presence simulated automatically.
//
// WebAuthn refuses IP addresses as RP ID, so this scenario runs against the
// host name in GC_BASE_URL (CI: http://localhost:3000) instead of BASE
// (http://127.0.0.1:3000) — same server, separate cookie jar.

module.exports = (ctx) => {
  const { FIXTURES, step, visible, waitIdle, shot } = ctx;
  const PK_BASE = (process.env.E2E_PASSKEY_BASE || process.env.GC_BASE_URL || ctx.BASE).replace(/\/+$/, '');

  async function loginPassword(page) {
    await page.goto(PK_BASE + '/login');
    await page.fill('input[name="username"]', FIXTURES.admin.username);
    await page.fill('input[name="password"]', FIXTURES.admin.password);
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
  }

  async function logout(page) {
    const csrf = await page.evaluate(() => window.GC && window.GC.csrfToken);
    await page.goto('about:blank');
    await page.request.fetch(PK_BASE + '/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf } });
  }

  async function passkeyCount(page) {
    return page.locator('#pk-list [data-passkey-id]').count();
  }

  return {
    async passkey(page) {
      if (!/^https:|^http:\/\/localhost[:/]/.test(PK_BASE + '/')) {
        step('passkey scenario needs a host-name GC_BASE_URL', false, PK_BASE);
        return;
      }
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('WebAuthn.enable', { enableUI: false });
      const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
          hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
        },
      });

      try {
        // ── Register from the profile ─────────────────────────────────────
        await loginPassword(page);
        step('password login on the passkey origin', /\/dashboard/.test(page.url()), page.url());
        await page.goto(PK_BASE + '/profile');
        step('profile shows the passkey card', await visible(page, '#pk-card'));
        await waitIdle(page);
        const before = await passkeyCount(page);
        await page.click('#pk-btn-add');
        step('add form opens', await visible(page, '#pk-form-add'));
        // Just logged in → no password prompt (recent-login window).
        step('recent login needs no password', !(await page.isVisible('#pk-add-reauth')));
        await page.fill('#pk-name', 'E2E virtual key');
        await page.click('#pk-btn-add-confirm');
        await page.waitForFunction((n) => document.querySelectorAll('#pk-list [data-passkey-id]').length > n, before, { timeout: 10000 }).catch(() => {});
        const after = await passkeyCount(page);
        step('passkey is listed after registration', after === before + 1, `${before} → ${after}`);
        const listed = await ctx.text(page, '#pk-list');
        step('list shows the chosen name', listed.includes('E2E virtual key'), listed.slice(0, 120));
        const creds = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
        step('authenticator holds a discoverable credential', creds.credentials.length === 1 && creds.credentials[0].isResidentCredential === true);
        await shot(page, 'profile-passkeys');

        // ── Sign in with it (usernameless) ────────────────────────────────
        await logout(page);
        await page.goto(PK_BASE + '/login');
        step('login page offers the passkey button', await visible(page, '#pk-login-btn'));
        await shot(page, 'login-passkey');
        await Promise.all([page.waitForURL(/\/dashboard/, { timeout: 15000 }).catch(() => {}), page.click('#pk-login-btn')]);
        const ok = /\/dashboard/.test(page.url());
        step('passkey login lands on the dashboard', ok, ok ? page.url() : `${page.url()} — ${await ctx.text(page, '#pk-login-msg')}`);
        await waitIdle(page);

        // ── Remove it again ───────────────────────────────────────────────
        await page.goto(PK_BASE + '/profile');
        await waitIdle(page);
        const listedNow = await ctx.text(page, '#pk-list');
        step('last-used time is shown after the login', !/Never used|Noch nie/.test(listedNow), listedNow.slice(0, 120));
        const item = page.locator('#pk-list [data-passkey-id]').filter({ hasText: 'E2E virtual key' }).first();
        await item.locator('[data-pk-remove]').click();
        step('remove asks for confirmation', await visible(page, '#pk-form-delete'));
        await page.click('#pk-btn-delete-confirm');
        await page.waitForFunction((n) => document.querySelectorAll('#pk-list [data-passkey-id]').length < n, after, { timeout: 10000 }).catch(() => {});
        step('passkey is gone after removal', (await passkeyCount(page)) === before);

        // Password login still works with no passkey left.
        await logout(page);
        await loginPassword(page);
        step('password login still works afterwards', /\/dashboard/.test(page.url()), page.url());
        await logout(page);
      } finally {
        await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() => {});
        await cdp.send('WebAuthn.disable').catch(() => {});
        await cdp.detach().catch(() => {});
      }
      // The admin session on BASE (another host, own cookies) is untouched,
      // so later scenarios carry on as before.
    },
  };
};
