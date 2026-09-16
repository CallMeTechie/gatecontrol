'use strict';

// Anmeldung mit und ohne zweiten Faktor.
//
// Der zweite Faktor ist die Stelle, an der ein Fehler am teuersten ist: wer
// sich nicht mehr anmelden kann, kommt auch nicht mehr an die Einstellungen,
// um es zu reparieren. Der Fixture-Benutzer e2e_tfa hat TOTP aktiviert
// (tests/e2e/seed.js), sein Geheimnis steht in den Fixtures.

const OTPAuth = require('otpauth');

function totp(secret, offsetSec = 0) {
  return new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) })
    .generate({ timestamp: Date.now() + offsetSec * 1000 });
}

// Ein TOTP-Schritt ist 30 s breit, der Server akzeptiert ±1 Schritt. Wer kurz
// vor dem Wechsel einen Code erzeugt und ihn nach dem Wechsel absendet, ist
// zwei Schritte entfernt — deshalb am Anfang eines frischen Schritts starten.
async function inFreshStep(page, minLeftMs = 8000) {
  const left = 30000 - (Date.now() % 30000);
  if (left < minLeftMs) await page.waitForTimeout(left + 250);
}

module.exports = (ctx) => {
  const { BASE, FIXTURES, step, visible, waitIdle, shot, allow } = ctx;

  return {
    async login(page) {
      // ── Falsches Passwort ────────────────────────────────────────────────
      await page.goto(BASE + '/login');
      step('login page renders', await visible(page, 'input[name="username"]'));
      await shot(page, 'login-page');
      await page.fill('input[name="username"]', FIXTURES.admin.username);
      await page.fill('input[name="password"]', 'definitely-wrong');
      await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
      step('wrong password stays on /login', page.url().includes('/login'), page.url());
      const err = await ctx.text(page, '.alert, .form-error, .login-error');
      step('wrong password shows a message', err.length > 0, err.slice(0, 80));

      // ── Admin ohne zweiten Faktor ────────────────────────────────────────
      await ctx.login(page);
      step('admin lands on the dashboard', /\/dashboard/.test(page.url()), page.url());
      await waitIdle(page);
      step('the page carries a CSRF token', !!(await page.evaluate(() => window.GC && window.GC.csrfToken)));
      await shot(page, 'dashboard');

      // ── Abmelden ─────────────────────────────────────────────────────────
      const csrf = await page.evaluate(() => window.GC && window.GC.csrfToken);
      await page.request.fetch(BASE + '/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf } });
      await page.goto(BASE + '/dashboard');
      step('logout ends the session', page.url().includes('/login'), page.url());

      // ── Admin MIT zweitem Faktor ─────────────────────────────────────────
      await inFreshStep(page);
      await page.goto(BASE + '/login');
      await page.fill('input[name="username"]', FIXTURES.tfa.username);
      await page.fill('input[name="password"]', FIXTURES.tfa.password);
      await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
      step('password step redirects to /login/2fa', page.url().includes('/login/2fa'), page.url());
      step('the second-factor form asks for a code', await visible(page, 'input[name="code"]'));
      await shot(page, 'login-2fa');

      // Ein falscher Code darf nicht durchlassen.
      await page.fill('input[name="code"]', '000000');
      await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
      step('a wrong code does not log in', page.url().includes('/login/2fa'), page.url());

      // Der echte Code schon. Zwei Versuche: der erste kann an der
      // Schrittgrenze scheitern (Code im alten Schritt erzeugt, im neuen
      // abgeschickt = zwei Schritte entfernt). Der zweite startet garantiert
      // in einem frischen Schritt — schlägt auch der fehl, ist es kein Timing.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (/\/dashboard/.test(page.url())) break;
        await inFreshStep(page, 12000);
        await page.fill('input[name="code"]', totp(FIXTURES.tfa.secret));
        await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
      }
      const tfaOk = /\/dashboard/.test(page.url());
      step('a valid TOTP code logs in', tfaOk, tfaOk ? page.url() : `${page.url()} — ${await ctx.text(page, '.alert, .form-error, .login-error')}`);
      await waitIdle(page);

      // Zurück auf den Admin ohne zweiten Faktor für die folgenden Szenarien.
      const csrf2 = await page.evaluate(() => window.GC && window.GC.csrfToken);
      await page.request.fetch(BASE + '/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf2 } });
      await ctx.login(page);
      step('back on the admin session', /\/dashboard/.test(page.url()), page.url());

      // Die beiden abgewiesenen Anmeldungen sind gewollt.
      allow(
        (p) => p.kind === 'http' && /\/login/.test(p.url) && [400, 401, 403].includes(p.status),
        (p) => p.kind === 'http' && p.url === '/dashboard' && p.status === 401,
      );
    },
  };
};
