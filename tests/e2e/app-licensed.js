#!/usr/bin/env node
'use strict';

// The app with single licence features switched on — for scenarios that have
// to see a Pro function of the admin interface (the app of the CI job runs
// with the community licence, and `license._overrideForTest` only works in the
// process that calls it; see README "Lizenz").
//
//   E2E_FEATURES=internal_dns,vpn_peers=-1 node tests/e2e/app-licensed.js
//
// Same environment variables as src/server.js. A scenario starts it as its
// own process with its own data directory and port (scenarios/31-vpn-names.js)
// and ends it again. Test tooling only: nothing in src/ knows this file.

process.env.NODE_ENV = 'test';
const license = require('../../src/services/license');

const features = {};
// "internal_dns" switches a feature on, "vpn_peers=-1" sets a limit
for (const part of String(process.env.E2E_FEATURES || '').split(',').map((s) => s.trim()).filter(Boolean)) {
  const [key, value] = part.split('=');
  features[key] = value === undefined ? true : Number(value);
}

// server.js validates the licence at its start (→ community mode without a
// key); the features go on top of that. No refresh timer puts them back.
const validate = license.validateLicense;
license.validateLicense = async (...args) => {
  const info = await validate(...args);
  license._overrideForTest(features);
  return info;
};
license.startLicenseRefresh = () => {};

require('../../src/server.js');
