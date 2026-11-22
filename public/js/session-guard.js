// public/js/session-guard.js — signed out meanwhile: stop asking, go to the login.
//
// The admin pages poll with timers of their own (gateways, pools, locations every 30 s,
// peers, certificates, WAF, settings …), with fetch() or window.api. When the session is
// gone (expired, account disabled) every /api/ request answers 401 and the timers kept
// asking. This wraps fetch once for all of them (loaded before app.js and the page scripts,
// templates/aurora/layout.njk): after a 401 of an /api/ request, GET /api/v1/ping decides —
// a 401 there means signed out (the same probe as the event stream, events.js) — then no
// further /api/ request leaves the page and it goes to /login. A 401 of an endpoint that
// means something else (the session is still alive) changes nothing.
(function () {
  'use strict';
  if (typeof window.fetch !== 'function' || window.__gcSessionGuard) return;
  window.__gcSessionGuard = true;
  var PING = '/api/v1/ping';
  var orig = window.fetch.bind(window);
  var base = window.location.href; // the page's own address, also while it is on its way to the login
  var gone = false;
  var probing = null;

  function apiPath(input) {
    try {
      var u = new URL(typeof input === 'string' ? input : (input && input.url) || String(input), base);
      return u.origin === new URL(base).origin && u.pathname.indexOf('/api/') === 0 ? u.pathname : null;
    } catch (e) { return null; }
  }
  function signedOut() {
    if (gone) return;
    gone = true;
    window.location.href = '/login';
  }
  function probe() {
    if (!probing) {
      probing = orig(PING, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (r) { if (r.status === 401) signedOut(); }, function () { /* offline: the next 401 asks again */ })
        .then(function () { probing = null; });
    }
    return probing;
  }

  window.fetch = function (input, init) {
    var path = apiPath(input);
    // signed out: the page is on its way to the login — nothing more to ask (never settles,
    // so no poll shows an error or arms its next timer meanwhile)
    if (gone && path) return new Promise(function () {});
    return orig(input, init).then(function (res) {
      if (res.status === 401 && path) {
        if (path === PING) signedOut(); else probe();
      }
      return res;
    });
  };
})();
