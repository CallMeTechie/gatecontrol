'use strict';

const nodemailer = require('nodemailer');
const { getDb } = require('../db/connection');
const { encrypt, decrypt } = require('../utils/crypto');
const logger = require('../utils/logger');

let cachedTransporter = null;

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

/**
 * Read all SMTP settings from the settings table
 */
function getSmtpSettings() {
  const db = getDb();

  function getSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  return {
    host: getSetting('smtp_host'),
    port: getSetting('smtp_port') ? parseInt(getSetting('smtp_port'), 10) : null,
    user: getSetting('smtp_user'),
    passwordEncrypted: getSetting('smtp_password_encrypted'),
    from: getSetting('smtp_from'),
    secure: getSetting('smtp_secure') === '1' || getSetting('smtp_secure') === 'true',
  };
}

/**
 * Returns true if the minimum required SMTP settings are present
 */
function isSmtpConfigured() {
  const settings = getSmtpSettings();
  return !!(settings.host && settings.port && settings.from);
}

// ---------------------------------------------------------------------------
// Transporter
// ---------------------------------------------------------------------------

/**
 * Create a nodemailer transport using current SMTP settings
 */
function createTransporter() {
  const settings = getSmtpSettings();

  if (!settings.host || !settings.port || !settings.from) {
    throw new Error('SMTP is not fully configured (host, port, and from are required)');
  }

  let password = null;
  if (settings.passwordEncrypted) {
    try {
      password = decrypt(settings.passwordEncrypted);
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to decrypt SMTP password');
    }
  }

  // Port 587 → STARTTLS (secure: false + requireTLS: true)
  const isStartTls = settings.port === 587;

  const transportOptions = {
    host: settings.host,
    port: settings.port,
    secure: settings.secure && !isStartTls,
    ...(isStartTls ? { requireTLS: true } : {}),
    auth: settings.user
      ? { user: settings.user, pass: password || '' }
      : undefined,
  };

  return nodemailer.createTransport(transportOptions);
}

/**
 * Clear the cached transporter (e.g. after settings change)
 */
function resetTransporter() {
  cachedTransporter = null;
}

/**
 * Get (or create) the cached transporter
 */
function getTransporter() {
  if (!cachedTransporter) {
    cachedTransporter = createTransporter();
  }
  return cachedTransporter;
}

// ---------------------------------------------------------------------------
// Send helpers
// ---------------------------------------------------------------------------

/**
 * Send an email
 */
async function sendMail({ to, subject, text, html }) {
  const settings = getSmtpSettings();
  const transporter = getTransporter();

  const info = await transporter.sendMail({
    from: settings.from,
    to,
    subject,
    text,
    html,
  });

  logger.info({ messageId: info.messageId, to, subject }, 'Email sent');
  return info;
}

/**
 * Send a styled OTP email with EN/DE localisation and GateControl branding
 */
async function sendOtpEmail({ to, code, domain, lang }) {
  const isDE = lang === 'de';

  const subject = isDE
    ? `Ihr Einmalcode für ${domain}`
    : `Your one-time code for ${domain}`;

  const heading = isDE ? 'Ihr Einmalcode' : 'Your One-Time Code';
  const intro = isDE
    ? `Verwenden Sie den folgenden Code, um sich bei <strong>${domain}</strong> anzumelden:`
    : `Use the following code to sign in to <strong>${domain}</strong>:`;
  const validity = isDE
    ? 'Dieser Code ist <strong>5 Minuten</strong> gültig.'
    : 'This code is valid for <strong>5 minutes</strong>.';
  const ignore = isDE
    ? 'Falls Sie diese Anmeldung nicht angefordert haben, können Sie diese E-Mail ignorieren.'
    : 'If you did not request this login, you can safely ignore this email.';

  const textBody = isDE
    ? `Ihr Einmalcode für ${domain}: ${code}\n\nGültig für 5 Minuten.\n\nFalls Sie diese Anmeldung nicht angefordert haben, ignorieren Sie diese E-Mail.`
    : `Your one-time code for ${domain}: ${code}\n\nValid for 5 minutes.\n\nIf you did not request this login, you can safely ignore this email.`;

  const html = `<!DOCTYPE html>
<html lang="${isDE ? 'de' : 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background-color:#0a6e4f;padding:28px 32px;">
              <p style="margin:0;font-size:22px;font-weight:bold;color:#ffffff;letter-spacing:-0.3px;">GateControl</p>
              <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,0.75);">${domain}</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <h1 style="margin:0 0 16px;font-size:20px;color:#1a1a1a;">${heading}</h1>
              <p style="margin:0 0 24px;font-size:15px;color:#444444;line-height:1.5;">${intro}</p>
              <!-- Code block -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                <tr>
                  <td align="center" style="background-color:#f0faf6;border:2px solid #0a6e4f;border-radius:8px;padding:20px;">
                    <span style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#0a6e4f;font-family:'Courier New',Courier,monospace;">${code}</span>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 12px;font-size:14px;color:#555555;">${validity}</p>
              <p style="margin:0;font-size:13px;color:#888888;">${ignore}</p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color:#f8f8f8;padding:16px 32px;border-top:1px solid #eeeeee;">
              <p style="margin:0;font-size:12px;color:#aaaaaa;text-align:center;">GateControl &mdash; Secure Access Gateway</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return sendMail({ to, subject, text: textBody, html });
}

/**
 * Send a simple test email to verify SMTP configuration
 */
async function sendTestEmail(to) {
  return sendMail({
    to,
    subject: 'GateControl — SMTP Test',
    text: 'This is a test email from GateControl. Your SMTP configuration is working correctly.',
    html: `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;padding:32px;background:#f4f4f4;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <p style="font-size:22px;font-weight:bold;color:#0a6e4f;margin:0 0 16px;">GateControl</p>
    <p style="color:#333;font-size:15px;">This is a test email. Your SMTP configuration is working correctly.</p>
  </div>
</body>
</html>`,
  });
}

// ---------------------------------------------------------------------------
// Persist SMTP settings
// ---------------------------------------------------------------------------

/**
 * Upsert SMTP settings into the settings table. Encrypts password if provided.
 */
function saveSmtpSettings({ host, port, user, password, from, secure }) {
  const db = getDb();

  function upsert(key, value) {
    if (value === undefined || value === null) return;
    db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(key, String(value));
  }

  if (host !== undefined) upsert('smtp_host', host);
  if (port !== undefined) upsert('smtp_port', port);
  if (user !== undefined) upsert('smtp_user', user);
  if (from !== undefined) upsert('smtp_from', from);
  if (secure !== undefined) upsert('smtp_secure', secure ? '1' : '0');

  if (password !== undefined && password !== null && password !== '') {
    const encrypted = encrypt(String(password));
    upsert('smtp_password_encrypted', encrypted);
  }

  resetTransporter();
  logger.info('SMTP settings saved');
}

module.exports = {
  getSmtpSettings,
  isSmtpConfigured,
  createTransporter,
  sendMail,
  sendOtpEmail,
  sendTestEmail,
  saveSmtpSettings,
  resetTransporter,
};
