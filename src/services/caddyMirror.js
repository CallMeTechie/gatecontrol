'use strict';

/**
 * Build the Caddy mirror handler config from a resolved mirrorTargets
 * list (each entry already shaped as `{ ip, port }` after peer-id
 * resolution). Used in two places inside buildCaddyConfig — the public
 * route handler chain and the forward-auth subroute chain — with
 * identical output.
 *
 * Caller is responsible for the enabled/length pre-check.
 */
function buildMirrorHandler(mirrorTargets) {
  return {
    handler: 'mirror',
    targets: mirrorTargets.map(t => ({ dial: `${t.ip}:${t.port}` })),
  };
}

module.exports = { buildMirrorHandler };
