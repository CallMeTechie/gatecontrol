'use strict';

// Links into the user guide: docs/handbuch (German) and docs/guide (English).
// The one place that knows where the guide lives — the pages (gateway-edge.js,
// gateway-net.js, gateway-home.js, the assistant and the topbar via
// src/middleware/i18n.js) only name a topic. When the guide moves to the
// website, only BASE and DIRS change. tests/handbook_docs.test.js checks that
// every topic's file and #anchor exist in both languages.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GCHandbook = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const BASE = 'https://github.com/CallMeTechie/gatecontrol/blob/master/docs/';
  const DIRS = { de: 'handbuch/', en: 'guide/' };

  // topic → file#anchor per language (anchors as GitHub derives them from the headings)
  const TOPICS = {
    index: { de: 'README.md', en: 'README.md' },
    // chapter 3: setting up a gateway (the assistant's platforms)
    'gw.rpi': { de: '03-gateway-einrichten.md#33-raspberry-pi', en: '03-gateway-setup.md#33-raspberry-pi' },
    'gw.synology': { de: '03-gateway-einrichten.md#32-synology-nas', en: '03-gateway-setup.md#32-synology-nas' },
    'gw.linux': { de: '03-gateway-einrichten.md#34-linux-rechner-mit-docker', en: '03-gateway-setup.md#34-linux-machine-with-docker' },
    'gw.proxmox': { de: '03-gateway-einrichten.md#35-proxmox', en: '03-gateway-setup.md#35-proxmox' },
    // chapter 4: edge plugins and Smart Home, its status messages
    edge: { de: '04-edge-und-smart-home.md', en: '04-edge-and-smart-home.md' },
    mqtt: { de: '04-edge-und-smart-home.md#42-mqtt-broker-einschalten', en: '04-edge-and-smart-home.md#42-switching-the-mqtt-broker-on' },
    'edge.gateway_offline': { de: '04-edge-und-smart-home.md#gateway-offline', en: '04-edge-and-smart-home.md#gateway-offline' },
    'edge.edge_missing': { de: '04-edge-und-smart-home.md#edge-dienst-fehlt', en: '04-edge-and-smart-home.md#edge-service-missing' },
    'edge.edge_not_running': { de: '04-edge-und-smart-home.md#edge-container-läuft-nicht', en: '04-edge-and-smart-home.md#edge-container-not-running' },
    'edge.compose_outdated': { de: '04-edge-und-smart-home.md#compose-datei-veraltet', en: '04-edge-and-smart-home.md#compose-file-outdated' },
    'edge.edge_fence': { de: '04-edge-und-smart-home.md#netzgrenze-fehlt', en: '04-edge-and-smart-home.md#network-fence-missing' },
    'edge.edge_not_connected': { de: '04-edge-und-smart-home.md#edge-erreicht-gatecontrol-nicht', en: '04-edge-and-smart-home.md#edge-cannot-reach-gatecontrol' },
    // chapter 5: features of the home gateways (keys as the card "Funktionen" names its rows)
    'feat.netwatch': { de: '05-funktionen.md#netzwerk-wächter', en: '05-features.md#network-watch' },
    'feat.inetq': { de: '05-funktionen.md#internetqualität', en: '05-features.md#internet-quality' },
    'feat.presence': { de: '05-funktionen.md#anwesenheit', en: '05-features.md#presence' },
    'feat.ups': { de: '05-funktionen.md#usv-status', en: '05-features.md#ups-status' },
    'feat.dns': { de: '05-funktionen.md#dns-filter', en: '05-features.md#dns-filter' },
    'feat.cache': { de: '05-funktionen.md#zwischenspeicher', en: '05-features.md#home-cache' },
    'feat.print': { de: '05-funktionen.md#drucken--scannen', en: '05-features.md#print--scan' },
    'feat.radio': { de: '05-funktionen.md#funk-zigbee-bluetooth-thread', en: '05-features.md#radio-zigbee-bluetooth-thread' },
    'feat.ai': { de: '05-funktionen.md#lokale-ki', en: '05-features.md#local-ai' },
    'feat.cameras': { de: '05-funktionen.md#kameras', en: '05-features.md#cameras' },
    'feat.edge': { de: '04-edge-und-smart-home.md', en: '04-edge-and-smart-home.md' },
    'feat.zigbee': { de: '04-edge-und-smart-home.md#zigbee-mit-deconz-raspberry-pi', en: '04-edge-and-smart-home.md#zigbee-with-deconz-raspberry-pi' },
    // chapter 6: updating a gateway (the complete compose file)
    update: { de: '06-gateway-aktualisieren.md#62-warum-die-compose-datei-extra-dran-ist', en: '06-updating-a-gateway.md#62-why-the-compose-file-needs-extra-care' },
    'update.synology': { de: '06-gateway-aktualisieren.md#63-synology-compose-datei-erneuern', en: '06-updating-a-gateway.md#63-synology-renewing-the-compose-file' },
    'update.linux': { de: '06-gateway-aktualisieren.md#64-linuxdocker-compose-datei-erneuern', en: '06-updating-a-gateway.md#64-linuxdocker-renewing-the-compose-file' },
    // chapter 7: FAQ
    'faq.utc': { de: '07-faq.md#der-server-läuft-in-utc', en: '07-faq.md#the-server-runs-in-utc' },
    'faq.cache_unwritable': { de: '07-faq.md#zwischenspeicher-ordner-nicht-beschreibbar', en: '07-faq.md#home-cache-folder-not-writable' },
    'faq.dns_port53': { de: '07-faq.md#dns-filter-port-53-belegt', en: '07-faq.md#dns-filter-port-53-taken' },
  };

  function langOf(lang) { return String(lang || '').slice(0, 2).toLowerCase() === 'en' ? 'en' : 'de'; }

  /** The guide's address for `topic` in the language of the interface ('de' | 'en'); null for an unknown topic. */
  function url(topic, lang) {
    const t = TOPICS[topic];
    if (!t) return null;
    const l = langOf(lang);
    return BASE + DIRS[l] + t[l];
  }

  return { BASE, DIRS, TOPICS, url, langOf };
});
