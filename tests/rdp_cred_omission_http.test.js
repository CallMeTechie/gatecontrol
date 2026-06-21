// tests/rdp_cred_omission_http.test.js
//
// OMISSION-RULE PROOF — END-TO-END through the real authed HTTP route layer.
// Combines the frontend state-construction module (the EXACT one rdp.js calls)
// with a real PATCH /api/v1/rdp/:id round-trip, then reads back the granular
// has_* flags via GET /api/v1/rdp/:id (credFlags path). This is the closest
// proportionate proxy for the manual browser scenario: create an ssh route WITH
// an ssh_private_key, edit ONLY the name, save — assert the key is NOT wiped.
'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { applyUnmodifiedCredentialOmission } = require('../public/js/rdp-cred-omission');

let agent, csrf;
before(async () => { const ctx = await setup(); agent = ctx.agent; csrf = ctx.csrfToken; });
after(() => teardown());

// Reproduce the frontend save pipeline for an EDIT: every credential field is
// rendered empty, so the raw form data carries '' for each; the omission rule
// then strips the unchanged ones before the patch is sent.
function buildEditPatch(rawForm, ctx) {
  const data = Object.assign({}, rawForm);
  applyUnmodifiedCredentialOmission(data, ctx);
  return data;
}

describe('omission rule — end-to-end via HTTP', () => {
  it('rename-only edit of a key-auth ssh route keeps the stored ssh_private_key', async () => {
    const created = await agent.post('/api/v1/rdp').set('X-CSRF-Token', csrf).send({
      name: 'ssh-key-route', host: '10.0.0.7', port: 22, protocol: 'ssh',
      access_mode: 'internal', credential_mode: 'full',
      username: 'root', ssh_private_key: 'PEM-SECRET-BODY',
    }).expect(201);
    const id = created.body.route.id;

    // Confirm the key is stored.
    const before = await agent.get(`/api/v1/rdp/${id}`).expect(200);
    assert.equal(before.body.route.has_ssh_private_key, true, 'precondition: key stored');

    // Admin opens edit (fields render empty), changes ONLY the name, saves.
    const editCredFlags = {
      has_username: before.body.route.has_username,
      has_password: before.body.route.has_password,
      has_ssh_private_key: before.body.route.has_ssh_private_key,
      has_ssh_passphrase: before.body.route.has_ssh_passphrase,
    };
    const patch = buildEditPatch(
      { name: 'ssh-key-route-renamed', username: '', password: '', ssh_private_key: '', ssh_passphrase: '' },
      { editingId: id, editCredFlags, credsToClear: {} }
    );
    assert.equal('ssh_private_key' in patch, false, 'omission must drop ssh_private_key from the patch');

    await agent.patch(`/api/v1/rdp/${id}`).set('X-CSRF-Token', csrf).send(patch).expect(200);

    const after = await agent.get(`/api/v1/rdp/${id}`).expect(200);
    assert.equal(after.body.route.name, 'ssh-key-route-renamed', 'name updated');
    assert.equal(after.body.route.has_ssh_private_key, true, 'KEY MUST SURVIVE the rename-only save');
    assert.equal(after.body.route.has_username, true, 'username also survives');
  });

  it('explicit "remove credential" action sends "" and clears the stored key', async () => {
    const created = await agent.post('/api/v1/rdp').set('X-CSRF-Token', csrf).send({
      name: 'ssh-clear-route', host: '10.0.0.8', port: 22, protocol: 'ssh',
      access_mode: 'internal', credential_mode: 'full',
      username: 'root', password: 'pw', ssh_private_key: 'PEM-SECRET-BODY',
    }).expect(201);
    const id = created.body.route.id;

    const patch = buildEditPatch(
      { name: 'ssh-clear-route', username: '', password: '', ssh_private_key: '', ssh_passphrase: '' },
      { editingId: id, editCredFlags: { has_ssh_private_key: true, has_password: true, has_username: true },
        credsToClear: { ssh_private_key: true } }
    );
    assert.equal(patch.ssh_private_key, '', 'explicit clear sends empty string');

    await agent.patch(`/api/v1/rdp/${id}`).set('X-CSRF-Token', csrf).send(patch).expect(200);

    const after = await agent.get(`/api/v1/rdp/${id}`).expect(200);
    assert.equal(after.body.route.has_ssh_private_key, false, 'deliberate clear wipes the key');
    assert.equal(after.body.route.has_password, true, 'untouched password preserved (omitted)');
  });
});
