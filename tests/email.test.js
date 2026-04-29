'use strict';

/**
 * Coverage for src/services/email.js — SMTP settings persistence, OTP and
 * monitoring-alert templating, transporter caching. nodemailer is stubbed
 * via node:test mock so no real SMTP traffic happens.
 */

const { describe, it, before, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-email-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

let email;
let nodemailer;
let getDb;
let decrypt;
let lastSent;
let createCalls;
let createTransportSpy;

before(() => {
  require('../src/db/migrations').runMigrations();
  email = require('../src/services/email');
  nodemailer = require('nodemailer');
  getDb = require('../src/db/connection').getDb;
  decrypt = require('../src/utils/crypto').decrypt;
});

beforeEach(() => {
  // Wipe SMTP-related rows so each test starts from a clean slate.
  const db = getDb();
  db.prepare("DELETE FROM settings WHERE key LIKE 'smtp_%'").run();

  // Stub nodemailer.createTransport so no real connection is opened.
  // Track every sendMail invocation for assertion.
  lastSent = null;
  createCalls = [];
  if (createTransportSpy) {
    try { createTransportSpy.mock.restore(); } catch {}
  }
  createTransportSpy = mock.method(nodemailer, 'createTransport', (opts) => {
    createCalls.push(opts);
    return {
      sendMail: async (msg) => {
        lastSent = msg;
        return { messageId: `stub-${Date.now()}`, accepted: [msg.to] };
      },
    };
  });
  email.resetTransporter();
});

// ───────────────────────────────────────────────────────────────────────
// getSmtpSettings + isSmtpConfigured
// ───────────────────────────────────────────────────────────────────────
describe('email: getSmtpSettings / isSmtpConfigured', () => {
  it('returns all-null settings on a fresh install', () => {
    const s = email.getSmtpSettings();
    assert.equal(s.host, null);
    assert.equal(s.port, null);
    assert.equal(s.user, null);
    assert.equal(s.from, null);
    assert.equal(s.passwordEncrypted, null);
    assert.equal(s.secure, false);
  });

  it('isSmtpConfigured is false until host+port+from are all present', () => {
    assert.equal(email.isSmtpConfigured(), false);

    email.saveSmtpSettings({ host: 'smtp.example.com' });
    assert.equal(email.isSmtpConfigured(), false, 'host alone is not enough');

    email.saveSmtpSettings({ port: 587 });
    assert.equal(email.isSmtpConfigured(), false, 'host+port without from is not enough');

    email.saveSmtpSettings({ from: 'no-reply@example.com' });
    assert.equal(email.isSmtpConfigured(), true, 'host+port+from is enough');
  });

  it('parses port back as an integer', () => {
    email.saveSmtpSettings({ port: 465 });
    assert.equal(email.getSmtpSettings().port, 465);
    assert.equal(typeof email.getSmtpSettings().port, 'number');
  });

  it('secure flag stored as 1/0 round-trips to boolean', () => {
    email.saveSmtpSettings({ secure: true });
    assert.equal(email.getSmtpSettings().secure, true);

    email.saveSmtpSettings({ secure: false });
    assert.equal(email.getSmtpSettings().secure, false);
  });
});

// ───────────────────────────────────────────────────────────────────────
// saveSmtpSettings
// ───────────────────────────────────────────────────────────────────────
describe('email: saveSmtpSettings persistence', () => {
  it('encrypts the password before storing — plaintext never hits the DB', () => {
    email.saveSmtpSettings({ password: 'super-secret-pw' });
    const stored = email.getSmtpSettings().passwordEncrypted;

    assert.ok(stored, 'encrypted password column must be populated');
    assert.notEqual(stored, 'super-secret-pw', 'plaintext must NOT be stored');
    assert.equal(decrypt(stored), 'super-secret-pw',
      'decrypted ciphertext must match the original password');
  });

  it('upserts: second save with different values overrides the first', () => {
    email.saveSmtpSettings({ host: 'first.example.com', port: 25 });
    email.saveSmtpSettings({ host: 'second.example.com', port: 587 });
    const s = email.getSmtpSettings();
    assert.equal(s.host, 'second.example.com');
    assert.equal(s.port, 587);
  });

  it('undefined fields are not erased on partial saves', () => {
    email.saveSmtpSettings({ host: 'h.example.com', port: 587, from: 'f@example.com' });
    email.saveSmtpSettings({ user: 'newuser' }); // only user — others must persist
    const s = email.getSmtpSettings();
    assert.equal(s.host, 'h.example.com');
    assert.equal(s.port, 587);
    assert.equal(s.from, 'f@example.com');
    assert.equal(s.user, 'newuser');
  });

  it('empty-string password leaves existing ciphertext untouched', () => {
    email.saveSmtpSettings({ password: 'original-pw' });
    const before = email.getSmtpSettings().passwordEncrypted;
    email.saveSmtpSettings({ password: '' });
    const after = email.getSmtpSettings().passwordEncrypted;
    assert.equal(after, before,
      'empty-string password is treated as "do not change" by the upsert');
  });
});

// ───────────────────────────────────────────────────────────────────────
// resetTransporter / createTransporter
// ───────────────────────────────────────────────────────────────────────
describe('email: transporter caching', () => {
  it('createTransporter throws when SMTP is not fully configured', () => {
    assert.throws(() => email.createTransporter(), /SMTP is not fully configured/);
  });

  it('STARTTLS option fires for port 587 (requireTLS true, secure false)', () => {
    email.saveSmtpSettings({
      host: 'smtp.example.com', port: 587, from: 'f@example.com',
    });
    email.createTransporter();
    const opts = createCalls[createCalls.length - 1];
    assert.equal(opts.requireTLS, true, 'port 587 must set requireTLS');
    assert.equal(opts.secure, false, 'port 587 must NOT set secure');
  });

  it('implicit TLS for port 465 (secure true, no requireTLS)', () => {
    email.saveSmtpSettings({
      host: 'smtp.example.com', port: 465, from: 'f@example.com', secure: true,
    });
    email.createTransporter();
    const opts = createCalls[createCalls.length - 1];
    assert.equal(opts.secure, true, 'port 465 with secure flag must set secure: true');
    assert.equal(opts.requireTLS, undefined, 'requireTLS only applies on STARTTLS port 587');
  });

  it('resetTransporter forces a fresh createTransport on next send', async () => {
    email.saveSmtpSettings({ host: 'h.example.com', port: 587, from: 'f@example.com' });
    await email.sendTestEmail('a@example.com');
    const before = createCalls.length;
    email.resetTransporter();
    await email.sendTestEmail('b@example.com');
    assert.ok(createCalls.length > before,
      'resetTransporter must cause the next send to invoke createTransport again');
  });
});

// ───────────────────────────────────────────────────────────────────────
// sendOtpEmail localisation + escaping
// ───────────────────────────────────────────────────────────────────────
describe('email: sendOtpEmail', () => {
  beforeEach(() => {
    email.saveSmtpSettings({ host: 'h.example.com', port: 587, from: 'f@example.com' });
  });

  it('German subject and body when lang=de', async () => {
    await email.sendOtpEmail({ to: 'u@example.com', code: '123456', domain: 'app.example.com', lang: 'de' });
    assert.ok(lastSent, 'sendMail must have been invoked');
    assert.match(lastSent.subject, /Einmalcode/);
    assert.match(lastSent.text, /Einmalcode/);
    assert.match(lastSent.text, /123456/);
  });

  it('English subject and body when lang is anything else', async () => {
    await email.sendOtpEmail({ to: 'u@example.com', code: '123456', domain: 'app.example.com', lang: 'en' });
    assert.match(lastSent.subject, /one-time code/i);
    assert.match(lastSent.text, /one-time code/i);
    assert.match(lastSent.text, /123456/);
  });

  it('HTML output escapes <, >, & and " in domain — XSS sentinel', async () => {
    await email.sendOtpEmail({
      to: 'u@example.com', code: '111111',
      domain: '<script>alert(1)</script>',
      lang: 'en',
    });
    assert.ok(!lastSent.html.includes('<script>alert(1)</script>'),
      'raw <script> must never appear in the HTML body');
    assert.ok(lastSent.html.includes('&lt;script&gt;'),
      'angle brackets must be HTML-escaped');
  });

  it('From-address comes from saved SMTP settings, not from the call site', async () => {
    await email.sendOtpEmail({ to: 'u@example.com', code: '999999', domain: 'app.example.com', lang: 'en' });
    assert.equal(lastSent.from, 'f@example.com');
  });
});

// ───────────────────────────────────────────────────────────────────────
// sendTestEmail / sendMonitoringAlert
// ───────────────────────────────────────────────────────────────────────
describe('email: sendTestEmail', () => {
  it('uses the GateControl SMTP-Test subject and the saved from-address', async () => {
    email.saveSmtpSettings({ host: 'h.example.com', port: 587, from: 'f@example.com' });
    await email.sendTestEmail('admin@example.com');
    assert.equal(lastSent.subject, 'GateControl — SMTP Test');
    assert.equal(lastSent.to, 'admin@example.com');
    assert.equal(lastSent.from, 'f@example.com');
  });
});

describe('email: sendMonitoringAlert', () => {
  it('early-returns silently when SMTP is not configured', async () => {
    // No saveSmtpSettings — fresh DB, isSmtpConfigured is false.
    await email.sendMonitoringAlert({
      to: 'admin@example.com', domain: 'app.example.com',
      status: 'down', responseTime: 0, target: '10.0.0.1:80',
    });
    assert.equal(lastSent, null,
      'no transporter call must happen when SMTP is unconfigured');
  });

  it('sends a "Route down" alert when status=down and SMTP is configured', async () => {
    email.saveSmtpSettings({ host: 'h.example.com', port: 587, from: 'mon@example.com' });
    await email.sendMonitoringAlert({
      to: 'admin@example.com', domain: 'app.example.com',
      status: 'down', responseTime: 5000, target: '10.0.0.1:80',
    });
    assert.ok(lastSent, 'sendMail must run when SMTP is configured');
    assert.match(lastSent.subject, /Route down: app\.example\.com/);
    assert.match(lastSent.text, /A monitored route is DOWN\./);
    assert.match(lastSent.text, /10\.0\.0\.1:80/);
    assert.match(lastSent.text, /5000ms/);
  });

  it('sends a "Route recovered" alert on status=up', async () => {
    email.saveSmtpSettings({ host: 'h.example.com', port: 587, from: 'mon@example.com' });
    await email.sendMonitoringAlert({
      to: 'admin@example.com', domain: 'app.example.com',
      status: 'up', responseTime: 120, target: '10.0.0.1:80',
    });
    assert.match(lastSent.subject, /Route recovered: app\.example\.com/);
    assert.match(lastSent.text, /RECOVERED/);
  });

  it('escapes target field in the alert body — defensive sentinel', async () => {
    email.saveSmtpSettings({ host: 'h.example.com', port: 587, from: 'mon@example.com' });
    await email.sendMonitoringAlert({
      to: 'admin@example.com', domain: 'app.example.com',
      status: 'down', responseTime: 0,
      target: '<script>alert(2)</script>',
    });
    assert.ok(!lastSent.text.includes('<script>'),
      'raw <script> must not appear in the alert text');
  });
});
