'use strict';

const config = require('../../config/default');

/**
 * The address the apps reach this server at, for links they open
 * (gatecontrol://enroll?url=…, gatecontrol://tv-pair?url=…): the configured
 * base URL when it is https and not a loopback name, else https:// plus the
 * host the request came to.
 */
function appBaseUrl(req) {
  try {
    const u = new URL(config.app.baseUrl);
    if (u.protocol === 'https:' && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) return u.origin;
  } catch { /* fall back to the request's host */ }
  return `https://${req.get('host')}`;
}

module.exports = { appBaseUrl };
