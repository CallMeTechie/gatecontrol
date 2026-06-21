(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GCRdpForm = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var DEFAULT_PORTS = { rdp: 3389, vnc: 5900, ssh: 22, telnet: 23 };
  function defaultPortFor(p) { return DEFAULT_PORTS[p] || 3389; }
  function isGatewayish(m) { return m === 'gateway' || m === 'external'; }

  // Real wizard steps (verified): connection, auth, experience, security, wol, access.
  // 'experience' (display/multi-monitor) is RDP/VNC-only. 'browser' is inserted before
  // 'access' when browser access is enabled (its content is built in Task 7).
  function stepsForProtocol(p, opts) {
    opts = opts || {};
    var steps = ['connection', 'auth'];
    if (p === 'rdp' || p === 'vnc') steps.push('experience');
    steps.push('security', 'wol');
    if (opts.browserEnabled) steps.push('browser');
    steps.push('access');
    return steps;
  }

  function visibleFieldsFor(p, state) {
    state = state || {};
    var internal = !isGatewayish(state.accessMode);
    var rdpvnc = (p === 'rdp' || p === 'vnc');
    return {
      domain: p === 'rdp',
      ssh_private_key: p === 'ssh',
      ssh_passphrase: p === 'ssh',
      rdp_disable_audio: p === 'rdp' && internal,          // M1: audio gated on internal
      browser_enable_audio: p === 'vnc' && internal,
      audio_servername: p === 'vnc' && internal && !!state.audioEnabled,
      sftp_username: rdpvnc && internal && !!state.sftpEnabled,
      sftp_host: rdpvnc && internal && !!state.sftpEnabled,
      sftp_password: rdpvnc && internal && !!state.sftpEnabled,
      wol: p === 'rdp' || p === 'vnc',                     // WoL blocked for ssh/telnet
      // credential_mode 'none' (rdp/vnc) suppresses the required-field UX:
      username_required: state.credentialMode !== 'none' && (p === 'ssh' || p === 'rdp' || p === 'vnc'),
    };
  }

  // DA-8: fields meaningless in the target protocol. username/password are SHARED → never here.
  function foreignFieldsOnSwitch(target) {
    var all = {
      domain: ['vnc', 'ssh', 'telnet'],
      ssh_private_key: ['rdp', 'vnc', 'telnet'],
      ssh_passphrase: ['rdp', 'vnc', 'telnet'],
      rdp_disable_audio: ['vnc', 'ssh', 'telnet'],
      browser_enable_audio: ['rdp', 'ssh', 'telnet'],
      audio_servername: ['rdp', 'ssh', 'telnet'],
      sftp_host: ['ssh', 'telnet'], sftp_port: ['ssh', 'telnet'],
      sftp_username: ['ssh', 'telnet'], sftp_password: ['ssh', 'telnet'],
      sftp_private_key: ['ssh', 'telnet'], sftp_passphrase: ['ssh', 'telnet'],
    };
    var out = [];
    for (var f in all) if (all[f].indexOf(target) !== -1) out.push(f);
    return out;
  }

  function serializeForm(state) {
    var payload = {};
    for (var k in state) if (state[k] !== undefined) payload[k] = state[k];
    foreignFieldsOnSwitch(state.protocol).forEach(function (f) {
      if (f === 'username' || f === 'password') return; // belt-and-suspenders
      payload[f] = null;
    });
    return payload;
  }

  function hydrateForm(route) {
    route = route || {};
    var state = {};
    for (var k in route) if (k.indexOf('_encrypted') === -1) state[k] = route[k];
    return state; // has_* flags (when present from the admin path) are carried through
  }

  return { defaultPortFor: defaultPortFor, stepsForProtocol: stepsForProtocol,
    visibleFieldsFor: visibleFieldsFor, foreignFieldsOnSwitch: foreignFieldsOnSwitch,
    serializeForm: serializeForm, hydrateForm: hydrateForm };
}));
