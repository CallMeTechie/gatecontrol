'use strict';

// Which console errors of the page are faults of the app under test (tests/e2e/run.js).
//
// The pages used to load their web fonts from Google (fonts.googleapis.com →
// three font files from fonts.gstatic.com). When the connection of the CI
// runner to such a host dropped, Chromium logged one
//   "Failed to load resource: net::ERR_CONNECTION_CLOSED"
// per font file (run 44044226830). The fonts ship with the app now
// (public/fonts/); a request to Google's font hosts is itself a fault of the
// app (isGoogleFontRequest, counted by run.js and 08-portal.js).
// A network error of a resource on another host still does not fail the run —
// that is the network of the runner, not the app. Exactly this case is left
// out, nothing more:
//   - a network error (net::ERR_…) — an answer of another host (404, 500)
//     still counts: that would be a broken link of the app;
//   - of a resource on another host than the app: the app itself is reached as
//     127.0.0.1 (BASE) and as localhost (GC_BASE_URL, passkeys) — a network
//     error of the app counts whatever its address.
// A navigation that cancels requests of the page before it does not show up
// here at all (Chromium logs no console error for net::ERR_ABORTED).

const NET_ERROR_RE = /^Failed to load resource: net::ERR_[A-Z0-9_]+$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : null;
  } catch { return null; }
}

/** A console error that only says another host could not be reached (not a fault of the app). */
function isExternalNetError(text, url, base) {
  if (!NET_ERROR_RE.test(String(text || ''))) return false;
  const host = hostOf(url);
  if (!host) return false; // no resource address: cannot tell, so it counts
  return !LOOPBACK.has(host) && host !== hostOf(base);
}

const GOOGLE_FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

/** A request to Google's font hosts: the app ships its fonts, any such request is a fault. */
function isGoogleFontRequest(url) {
  const host = hostOf(url);
  return host !== null && GOOGLE_FONT_HOSTS.has(host.toLowerCase());
}

module.exports = { isExternalNetError, isGoogleFontRequest };
