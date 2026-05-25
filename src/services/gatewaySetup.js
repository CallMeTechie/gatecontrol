'use strict';
const fs = require('node:fs');
const path = require('node:path');

const TPL = path.join(__dirname, 'gatewaySetup', 'templates');
const read = (rel) => fs.readFileSync(path.join(TPL, rel), 'utf8');
const REPO = (process.env.GC_GATEWAY_REPO || 'CallMeTechie/gatecontrol-gateway').toLowerCase();
const IMAGE = `ghcr.io/${REPO}:latest`;
const DEFAULT_COMPOSE_DIR = '/volume1/docker/gatecontrol-gateway';
const SERVICE = 'gateway';

function _slug(name, id) {
  let s = String(name == null ? '' : name).toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-').replace(/[-.]{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);
  if (!s) s = `gateway-${id}`;
  return s;
}
function _shQuote(name) {
  return String(name == null ? '' : name).replace(/[\r\n]+/g, ' ').replace(/'/g, `'\\''`);
}
// NOTE: all replacements use the FUNCTION form `() => value` so that `$`-sequences
// (`$&`, `$$`, `` $` ``, `$'`, `$1`) in the value are NOT interpreted by String.replace
// (a real footgun — a name like `$&` or an embedded script with `$$` would corrupt).
function _fill(tpl, gw) {
  return tpl
    .replace(/\{\{GATEWAY_NAME\}\}/g, () => _shQuote(gw.name))
    .replace(/\{\{GATEWAY_IMAGE\}\}/g, () => IMAGE)
    .replace(/\{\{DEFAULT_COMPOSE_DIR\}\}/g, () => DEFAULT_COMPOSE_DIR)
    .replace(/\{\{SERVICE\}\}/g, () => SERVICE);
}
function renderScript(gw) {
  return _fill(read('setup.sh'), gw).replace(/\{\{UPDATE_SH\}\}/g, () => read('update.sh').replace(/\s+$/, ''));
}
function buildBundleFiles(gw) {
  return [
    { name: 'setup.sh', data: Buffer.from(renderScript(gw)) },
    { name: 'update.sh', data: Buffer.from(read('update.sh')) },
    { name: 'systemd/gatecontrol-gateway-update.service', data: Buffer.from(read('systemd/gatecontrol-gateway-update.service')) },
    { name: 'systemd/gatecontrol-gateway-update.path', data: Buffer.from(read('systemd/gatecontrol-gateway-update.path')) },
    { name: 'docker-compose.state-snippet.yml', data: Buffer.from(read('docker-compose.state-snippet.yml')) },
    { name: 'README.md', data: Buffer.from(_fill(read('README.md'), gw)) },
  ];
}
function slug(gw) { return _slug(gw.name, gw.id); }
module.exports = { renderScript, buildBundleFiles, slug, _slug, _shQuote };
