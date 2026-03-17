'use strict';

const argon2 = require('argon2');
const { getDb } = require('./connection');
const config = require('../../config/default');
const logger = require('../utils/logger');
const argon2Options = require('../utils/argon2Options');

async function seedAdminUser() {
  const db = getDb();

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(config.auth.adminUser);
  if (existing) {
    logger.info('Admin user already exists, skipping seed');
    return;
  }

  if (!config.auth.adminPassword) {
    logger.error('GC_ADMIN_PASSWORD is required on first run');
    process.exit(1);
  }

  const hash = await argon2.hash(config.auth.adminPassword, argon2Options);

  db.prepare(`
    INSERT INTO users (username, password_hash, display_name, role, language, theme)
    VALUES (?, ?, ?, 'admin', ?, ?)
  `).run(
    config.auth.adminUser,
    hash,
    'Administrator',
    config.i18n.defaultLanguage,
    config.theme.defaultTheme
  );

  logger.info({ username: config.auth.adminUser }, 'Admin user created');
}

module.exports = { seedAdminUser };
