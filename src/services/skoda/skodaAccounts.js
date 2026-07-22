'use strict';

const { getDb } = require('../../db/connection');
const { encrypt, decrypt } = require('../../utils/crypto');

function err(message, code) { const e = new Error(message); e.code = code; return e; }

function createAccount({ email, password }) {
  if (!email || typeof email !== 'string' || !/.+@.+/.test(email.trim())) throw err('valid email required', 'SKODA_VALIDATION');
  if (!password || typeof password !== 'string') throw err('password required', 'SKODA_VALIDATION');
  const db = getDb();
  try {
    const info = db.prepare('INSERT INTO skoda_accounts (email, password_enc) VALUES (?, ?)')
      .run(email.trim(), encrypt(password));
    return listAccounts().find((a) => a.id === info.lastInsertRowid);
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw err('account already exists', 'SKODA_ACCOUNT_EXISTS');
    throw e;
  }
}

function listAccounts() {
  return getDb().prepare('SELECT id, email, status, status_detail, next_retry_at, updated_at, password_enc FROM skoda_accounts ORDER BY id').all()
    .map((r) => ({
      id: r.id, email: r.email, status: r.status, status_detail: r.status_detail,
      next_retry_at: r.next_retry_at, updated_at: r.updated_at,
      has_credentials: Boolean(r.password_enc),
    }));
}

function getAccountWithSecrets(id) {
  const r = getDb().prepare('SELECT * FROM skoda_accounts WHERE id = ?').get(id);
  if (!r) return null;
  return {
    id: r.id, email: r.email, status: r.status, backoff_min: r.backoff_min, next_retry_at: r.next_retry_at,
    password: decrypt(r.password_enc),
    session: r.session_enc ? JSON.parse(decrypt(r.session_enc)) : null,
  };
}

function updatePassword(id, password) {
  if (!password || typeof password !== 'string') throw err('password required', 'SKODA_VALIDATION');
  const info = getDb().prepare(`UPDATE skoda_accounts SET password_enc = ?, status = 'ok', status_detail = NULL,
    backoff_min = 0, next_retry_at = NULL, updated_at = datetime('now') WHERE id = ?`).run(encrypt(password), id);
  if (!info.changes) throw err('account not found', 'SKODA_ACCOUNT_NOT_FOUND');
}

function saveSession(id, sessionObj) {
  getDb().prepare("UPDATE skoda_accounts SET session_enc = ?, updated_at = datetime('now') WHERE id = ?")
    .run(sessionObj ? encrypt(JSON.stringify(sessionObj)) : null, id);
}

function setStatus(id, status, detail = null, { backoffMin = null, nextRetryAt = null } = {}) {
  if (detail != null) detail = String(detail).slice(0, 300); // keep upstream error blobs out of the UI
  getDb().prepare(`UPDATE skoda_accounts SET status = ?, status_detail = ?,
    backoff_min = COALESCE(?, backoff_min), next_retry_at = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, detail, backoffMin, nextRetryAt, id);
}

function removeAccount(id) {
  const db = getDb();
  const tx = db.transaction((accountId) => {
    db.prepare('DELETE FROM skoda_vehicle_owners WHERE skoda_vehicle_id IN (SELECT id FROM skoda_vehicles WHERE account_id = ?)').run(accountId);
    db.prepare('DELETE FROM skoda_vehicles WHERE account_id = ?').run(accountId);
    db.prepare('DELETE FROM skoda_accounts WHERE id = ?').run(accountId);
  });
  tx(id);
}

module.exports = { createAccount, listAccounts, getAccountWithSecrets, updatePassword, saveSession, setStatus, removeAccount };
