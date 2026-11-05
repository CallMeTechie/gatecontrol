'use strict';

// The edge part (runs on the gateway, docs/plugins.md "Edge part"). The server
// tests never run it — the test edge host (scripts/plugin-edge-host.js) plays
// the gateway — but it is part of the package the gateway downloads.
module.exports = (gc) => {
  gc.handle('ping', async (params) => ({ pong: params }));
};
