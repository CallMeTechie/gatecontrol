'use strict';

// Host templates: data-only presets that expand into EntryInput[] for
// hosts.create (docs/feature-domain-zones.md). They replace the service and
// printer wizards; the LAN address and the target come from the host / zone.
//
// Listen-port suggestions are computed at expand time against the live
// routes table: the printer ports follow printerPreset.allocatePrintListenPort
// (target port if free, else the next free one); SSH (22 is reserved on the
// server itself) starts at 2022.

const { findListenPortConflict, suggestFreeListenPort } = require('./l4');
const { isPortBlocked } = require('../utils/validate');

const SSH_LISTEN_START = 2022;

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// Preferred port if it is neither reserved nor taken, else the next free one.
function suggestListenPort(preferred, protocol = 'tcp') {
  if (!isPortBlocked(preferred) && findListenPortConflict(preferred, { protocol }) == null) return preferred;
  return suggestFreeListenPort(preferred, { protocol });
}

// Two entries of one template must not get the same listen port.
function claim(claimed, port, protocol) {
  let p = port;
  while (p != null && claimed.has(p)) p = suggestFreeListenPort(p, { protocol });
  if (p == null) throw badRequest('No free listen port available');
  claimed.add(p);
  return p;
}

const TEMPLATES = {
  printer: {
    name: 'Printer',
    // Same exposures as printerPreset.buildBundleInput with EWS enabled and
    // the default print ports 9100 (RAW) and 631 (IPP).
    expand(claimed) {
      const { allocatePrintListenPort } = require('./printerPreset');
      return [
        { type: 'http', target_port: 443, backend_https: true },
        { type: 'tcp', target_port: 9100, listen_port: String(claim(claimed, allocatePrintListenPort(9100), 'tcp')), tls_mode: 'none' },
        { type: 'tcp', target_port: 631, listen_port: String(claim(claimed, allocatePrintListenPort(631), 'tcp')), tls_mode: 'none' },
      ];
    },
  },
  nas: {
    name: 'Synology NAS',
    expand(claimed) {
      return [
        { type: 'http', target_port: 5001, backend_https: true },
        { type: 'tcp', target_port: 22, listen_port: String(claim(claimed, suggestListenPort(SSH_LISTEN_START), 'tcp')), tls_mode: 'none' },
      ];
    },
  },
  proxmox: {
    name: 'Proxmox VE',
    expand() {
      return [{ type: 'http', target_port: 8006, backend_https: true }];
    },
  },
  ssh: {
    name: 'SSH only',
    expand(claimed) {
      return [
        { type: 'tcp', target_port: 22, listen_port: String(claim(claimed, suggestListenPort(SSH_LISTEN_START), 'tcp')), tls_mode: 'none' },
      ];
    },
  },
};

function has(templateId) {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, templateId);
}

/** EntryInput[] for a template, with listen ports suggested against the DB. */
function expand(templateId, _params = {}) {
  if (!has(templateId)) throw badRequest('Unknown template: ' + templateId);
  return TEMPLATES[templateId].expand(new Set());
}

/** All templates with their current suggestion (for the template menu). */
function list() {
  return Object.keys(TEMPLATES).map((id) => ({ id, name: TEMPLATES[id].name, entries: expand(id) }));
}

module.exports = { list, expand, has, suggestListenPort };
