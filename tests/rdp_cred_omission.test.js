// tests/rdp_cred_omission.test.js
//
// OMISSION-RULE PROOF (Chain H4 — CRITICAL). Drives the EXACT state-construction
// function rdp.js uses on save (public/js/rdp-cred-omission.js, the UMD module the
// browser loads and the save handler delegates to). It proves that an empty +
// has_* credential field is OMITTED (property ABSENT) so the stored secret is
// kept, while a typed value or the explicit "remove" flag mutate as intended.
//
// It is paired with tests/rdp_cred_preserve.test.js which proves the BACKEND end
// of the same invariant (a PATCH that omits a credential keeps it; '' clears it).
// Together: empty+has_* → omitted by this function → backend keeps the secret.
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { applyUnmodifiedCredentialOmission } = require('../public/js/rdp-cred-omission');

describe('unmodified-credential omission rule', () => {
  const editFlags = {
    has_username: true, has_password: true,
    has_ssh_private_key: true, has_ssh_passphrase: true,
  };

  it('EDIT + empty + has_* → property is ABSENT (not "", not null)', () => {
    const data = { name: 'renamed', username: '', password: '', ssh_private_key: '', ssh_passphrase: '' };
    applyUnmodifiedCredentialOmission(data, { editingId: 42, editCredFlags: editFlags, credsToClear: {} });
    assert.equal('username' in data, false, 'username must be omitted');
    assert.equal('password' in data, false, 'password must be omitted');
    assert.equal('ssh_private_key' in data, false, 'ssh_private_key must be omitted — secret would be wiped');
    assert.equal('ssh_passphrase' in data, false, 'ssh_passphrase must be omitted');
    assert.equal(data.name, 'renamed', 'non-credential fields untouched');
  });

  it('the renamed-only edit of a key-auth ssh route keeps the key (the core scenario)', () => {
    // Mirrors: create ssh route WITH ssh_private_key, then edit ONLY the name.
    const data = { name: 'new name', username: '', password: '', ssh_private_key: '', ssh_passphrase: '' };
    applyUnmodifiedCredentialOmission(data, {
      editingId: 7,
      editCredFlags: { has_ssh_private_key: true, has_username: true },
      credsToClear: {},
    });
    assert.equal('ssh_private_key' in data, false);
    assert.equal('username' in data, false);
  });

  it('EDIT + typed value → kept verbatim (new secret replaces stored)', () => {
    const data = { username: 'root', password: 'hunter2', ssh_private_key: 'PEMBODY', ssh_passphrase: 'pp' };
    applyUnmodifiedCredentialOmission(data, { editingId: 42, editCredFlags: editFlags, credsToClear: {} });
    assert.equal(data.username, 'root');
    assert.equal(data.password, 'hunter2');
    assert.equal(data.ssh_private_key, 'PEMBODY');
    assert.equal(data.ssh_passphrase, 'pp');
  });

  it('EDIT + explicit "remove" flag → sends "" (deliberate clear), NOT omitted', () => {
    const data = { username: '', password: '', ssh_private_key: '', ssh_passphrase: '' };
    applyUnmodifiedCredentialOmission(data, {
      editingId: 42, editCredFlags: editFlags, credsToClear: { ssh_private_key: true },
    });
    assert.equal('ssh_private_key' in data, true, 'explicit clear must be present');
    assert.equal(data.ssh_private_key, '', 'explicit clear sends empty string');
    assert.equal('password' in data, false, 'untouched empty+has_* still omitted');
  });

  it('CREATE (no editingId) → empty values NOT omitted (nothing is stored yet)', () => {
    const data = { username: '', password: '' };
    applyUnmodifiedCredentialOmission(data, { editingId: null, editCredFlags: {}, credsToClear: {} });
    assert.equal('username' in data, true);
    assert.equal('password' in data, true);
  });

  it('EDIT + empty but has_*=false → NOT omitted (no stored secret to protect)', () => {
    const data = { password: '' };
    applyUnmodifiedCredentialOmission(data, {
      editingId: 42, editCredFlags: { has_password: false }, credsToClear: {},
    });
    assert.equal('password' in data, true, 'clearing an unset field is a harmless no-op, kept as ""');
  });
});
