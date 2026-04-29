'use strict';

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-rdpcreds-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

let getDb;
let creds;

before(() => {
  require('../src/db/migrations').runMigrations();
  getDb = require('../src/db/connection').getDb;
  creds = require('../src/services/rdpCredentials');
});

function insertRoute(overrides = {}) {
  const db = getDb();
  const fields = {
    name: 'win-host', host: '10.0.0.10', port: 3389,
    credential_mode: 'none',
    ...overrides,
  };
  return db.prepare(`
    INSERT INTO rdp_routes (name, host, port, credential_mode, username_encrypted, password_encrypted, domain)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    fields.name, fields.host, fields.port,
    fields.credential_mode,
    fields.username_encrypted || null,
    fields.password_encrypted || null,
    fields.domain || null,
  ).lastInsertRowid;
}

beforeEach(() => {
  getDb().prepare('DELETE FROM rdp_routes').run();
});

describe('rdpCredentials: encryptCredentials', () => {
  it('encrypts a non-empty username and password', () => {
    const out = creds.encryptCredentials({ username: 'alice', password: 'sec' });
    assert.ok(out.username_encrypted, 'username_encrypted must be present');
    assert.ok(out.password_encrypted, 'password_encrypted must be present');
    assert.notEqual(out.username_encrypted, 'alice');
    assert.notEqual(out.password_encrypted, 'sec');
  });

  it('treats empty string and null as "clear this column"', () => {
    assert.deepEqual(creds.encryptCredentials({ username: '' }), { username_encrypted: null });
    assert.deepEqual(creds.encryptCredentials({ password: null }), { password_encrypted: null });
  });

  it('treats undefined as "leave this column alone" — returns no key', () => {
    const out = creds.encryptCredentials({});
    assert.deepEqual(Object.keys(out), []);
  });
});

describe('rdpCredentials: getCredentials', () => {
  it('throws when the route is missing', () => {
    assert.throws(() => creds.getCredentials(99999), /RDP route not found/);
  });

  it('returns nulls when credential_mode is "none"', () => {
    const id = insertRoute({ credential_mode: 'none' });
    assert.deepEqual(creds.getCredentials(id), {
      credential_mode: 'none', username: null, password: null, domain: null,
    });
  });

  it('user_only mode reveals the username but withholds the password', () => {
    const id = insertRoute({ credential_mode: 'none' });
    creds.setCredentials(id, {
      credential_mode: 'user_only',
      username: 'bob',
      password: 'secret',
      domain: 'CORP',
    });
    const out = creds.getCredentials(id);
    assert.equal(out.credential_mode, 'user_only');
    assert.equal(out.username, 'bob');
    assert.equal(out.password, null, 'password is intentionally hidden in user_only');
    assert.equal(out.domain, 'CORP');
  });

  it('full mode reveals both username and password', () => {
    const id = insertRoute({ credential_mode: 'none' });
    creds.setCredentials(id, {
      credential_mode: 'full', username: 'carol', password: 'pw',
    });
    const out = creds.getCredentials(id);
    assert.equal(out.username, 'carol');
    assert.equal(out.password, 'pw');
  });
});

describe('rdpCredentials: setCredentials', () => {
  it('throws when route is missing', () => {
    assert.throws(() => creds.setCredentials(99999, { username: 'x' }), /RDP route not found/);
  });

  it('rejects an unknown credential_mode', () => {
    const id = insertRoute();
    assert.throws(
      () => creds.setCredentials(id, { credential_mode: 'plaintext' }),
      /Invalid credential mode/,
    );
  });

  it('only updates the columns the caller actually passes', () => {
    const id = insertRoute({ credential_mode: 'full' });
    creds.setCredentials(id, { username: 'first', password: 'first-pw' });
    creds.setCredentials(id, { domain: 'CORP' }); // username/password unchanged
    const out = creds.getCredentials(id);
    assert.equal(out.username, 'first');
    assert.equal(out.password, 'first-pw');
    assert.equal(out.domain, 'CORP');
  });

  it('is a no-op when the patch is empty', () => {
    const id = insertRoute({ credential_mode: 'none' });
    creds.setCredentials(id, {});
    assert.deepEqual(creds.getCredentials(id), {
      credential_mode: 'none', username: null, password: null, domain: null,
    });
  });
});

describe('rdpCredentials: clearCredentials', () => {
  it('throws when route is missing', () => {
    assert.throws(() => creds.clearCredentials(99999), /RDP route not found/);
  });

  it('zeroes out username, password, domain and resets mode to "none"', () => {
    const id = insertRoute({ credential_mode: 'none' });
    creds.setCredentials(id, {
      credential_mode: 'full', username: 'u', password: 'p', domain: 'd',
    });
    creds.clearCredentials(id);
    assert.deepEqual(creds.getCredentials(id), {
      credential_mode: 'none', username: null, password: null, domain: null,
    });
  });
});
