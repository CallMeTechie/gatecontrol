'use strict';

const settings = require('./settings');
const { encrypt, decrypt } = require('../utils/crypto');

const KEY = 'pihole_config';

const DEFAULT = {
  enabled: false,
  sync_interval_sec: 30,
  manage_dns_chain: true,
  top_clients_count: 1000,
  instances: [],
};

/**
 * Load pihole config from settings, decrypting each instance's app_password.
 * @returns {{ enabled: boolean, sync_interval_sec: number, manage_dns_chain: boolean, top_clients_count: number, instances: Array }}
 */
function load() {
  const raw = settings.get(KEY);
  if (!raw) return { ...DEFAULT };

  const parsed = JSON.parse(raw);
  const instances = (parsed.instances || []).map((inst) => ({
    ...inst,
    app_password: inst.app_password ? decrypt(inst.app_password) : '',
  }));

  return { ...DEFAULT, ...parsed, instances };
}

/**
 * Save pihole config to settings, encrypting each instance's app_password.
 * @param {{ enabled: boolean, sync_interval_sec: number, manage_dns_chain: boolean, top_clients_count: number, instances: Array }} config
 */
function save(config) {
  const instances = (config.instances || []).map((inst) => ({
    ...inst,
    app_password: inst.app_password ? encrypt(inst.app_password) : '',
  }));

  const toStore = { ...config, instances };
  settings.set(KEY, JSON.stringify(toStore));
}

/**
 * Return a copy of config with app_password removed and password_set boolean added.
 * @param {{ instances: Array }} config
 * @returns {object}
 */
function redact(config) {
  const instances = (config.instances || []).map((inst) => {
    const { app_password, ...rest } = inst;
    return { ...rest, password_set: Boolean(app_password) };
  });

  return { ...config, instances };
}

module.exports = { load, save, redact, KEY, DEFAULT };
