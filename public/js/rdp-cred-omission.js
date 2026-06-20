/*
 * THE UNMODIFIED-CREDENTIAL OMISSION RULE (Chain H4 — CRITICAL invariant).
 *
 * A credential field shown EMPTY whose stored value exists (has_* === true) MUST
 * be ABSENT from the patch sent to PATCH /api/v1/rdp/:id — not '', not null, not
 * an undefined-valued property: the property must NOT exist. update() only writes
 * a credential column when the field is present (`data.x !== undefined`); a
 * present-but-empty value flows update() → encryptCredentials('') → null and
 * WIPES the stored secret. Omitting the property keeps the stored value.
 *
 * Tri-state:
 *   - typed value            → keep it (new secret)
 *   - empty + has_* (edit)   → OMIT (delete property) → stored secret preserved
 *   - explicit "remove" flag  → send '' (deliberate clear)
 *   - create (no editingId)  → never omit (nothing is stored yet)
 *
 * This lives in its OWN module (not rdp-form-logic.js — serializeForm stays as
 * is) so the state-construction code in rdp.js can call the EXACT same function
 * that the unit test in tests/rdp_cred_omission.test.js drives.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GCRdpCred = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Credential field → has_* flag. The four shared/ssh secrets that carry an
  // admin-path has_* flag (sftp_* belong to Task 7 and are not handled here).
  var CRED_FLAGS = {
    username: 'has_username',
    password: 'has_password',
    ssh_private_key: 'has_ssh_private_key',
    ssh_passphrase: 'has_ssh_passphrase',
  };

  // Mutates `data` in place (and returns it). ctx = { editingId, editCredFlags, credsToClear }.
  function applyUnmodifiedCredentialOmission(data, ctx) {
    ctx = ctx || {};
    var editingId = ctx.editingId;
    var flags = ctx.editCredFlags || {};
    var clear = ctx.credsToClear || {};
    Object.keys(CRED_FLAGS).forEach(function (field) {
      if (clear[field]) { data[field] = ''; return; }   // deliberate clear → send ''
      var typed = data[field];
      var isEmpty = (typed === '' || typed === null || typed === undefined);
      if (isEmpty && editingId && flags[CRED_FLAGS[field]]) {
        delete data[field];                              // ABSENT → keep stored secret
      }
    });
    return data;
  }

  return { CRED_FLAGS: CRED_FLAGS, applyUnmodifiedCredentialOmission: applyUnmodifiedCredentialOmission };
}));
