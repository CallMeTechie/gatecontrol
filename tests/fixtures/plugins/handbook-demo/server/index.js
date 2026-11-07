'use strict';

// Server part of the handbook test plugin (tests/plugins_handbook.test.js,
// tests/e2e/scenarios/26-plugin-handbook.js): nothing to do — the handbook
// and the setup notices live in plugin.json and the package.

module.exports = {
  async start() {},
  async request() { return { json: { ok: true } }; },
};
