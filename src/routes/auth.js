'use strict';

const argon2 = require('argon2');
const { getDb } = require('../db/connection');
const { setFlash } = require('../middleware/locals');
const config = require('../../config/default');
const logger = require('../utils/logger');

const authRoutes = {
  loginPage(req, res) {
    res.render(`${config.theme.defaultTheme}/pages/login.njk`, {
      title: res.locals.t('auth.login'),
      layout: false,
    });
  },

  async login(req, res) {
    const { username, password } = req.body;

    if (!username || !password) {
      setFlash(req, 'error', res.locals.t('auth.error_required'));
      return res.redirect('/login');
    }

    try {
      const db = getDb();
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

      if (!user || !(await argon2.verify(user.password_hash, password))) {
        logger.warn({ username, ip: req.ip }, 'Failed login attempt');

        // Log failed attempt
        db.prepare(`
          INSERT INTO activity_log (event_type, message, source, ip_address, severity)
          VALUES ('login_failed', ?, 'system', ?, 'warning')
        `).run(`Failed login for user: ${username}`, req.ip);

        setFlash(req, 'error', res.locals.t('auth.error_invalid'));
        return res.redirect('/login');
      }

      // Update last login
      db.prepare('UPDATE users SET last_login_at = datetime(\'now\') WHERE id = ?').run(user.id);

      // Log successful login
      db.prepare(`
        INSERT INTO activity_log (event_type, message, source, ip_address, severity)
        VALUES ('login', ?, 'system', ?, 'info')
      `).run(`User ${username} logged in`, req.ip);

      // Regenerate session to prevent session fixation
      const language = user.language || config.i18n.defaultLanguage;
      req.session.regenerate((err) => {
        if (err) {
          logger.error({ err }, 'Session regeneration failed');
          setFlash(req, 'error', res.locals.t('auth.error_generic'));
          return res.redirect('/login');
        }
        req.session.userId = user.id;
        req.session.language = language;

        logger.info({ username, ip: req.ip }, 'Successful login');
        return res.redirect('/dashboard');
      });
    } catch (err) {
      logger.error({ err }, 'Login error');
      setFlash(req, 'error', res.locals.t('auth.error_generic'));
      return res.redirect('/login');
    }
  },

  logout(req, res) {
    const username = res.locals.user ? res.locals.user.username : 'unknown';
    req.session.destroy((err) => {
      if (err) {
        logger.error({ err }, 'Session destroy error');
      }
      logger.info({ username }, 'User logged out');
      res.redirect('/login');
    });
  },
};

module.exports = authRoutes;
