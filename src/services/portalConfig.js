'use strict';

const settings = require('./settings');

/**
 * Returns the current VPN landing portal configuration derived from settings.
 * All values default to enabled ('1') unless explicitly set to '0'.
 *
 * @returns {{ enabled: boolean, widgets: { device: boolean, traffic: boolean, services: boolean } }}
 */
const on = (key) => settings.get(key, '1') !== '0';

function portalConfig() {
  return {
    enabled: on('portal.enabled'),
    widgets: {
      device:   on('portal.widget.device'),
      traffic:  on('portal.widget.traffic'),
      services: on('portal.widget.services'),
    },
  };
}

module.exports = portalConfig;
