const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

let validate;

describe('L4 Validation', () => {
  before(() => {
    validate = require('../src/utils/validate');
  });

  describe('validateL4Protocol', () => {
    it('accepts tcp', () => { assert.equal(validate.validateL4Protocol('tcp'), null); });
    it('accepts udp', () => { assert.equal(validate.validateL4Protocol('udp'), null); });
    it('rejects invalid protocol', () => { assert.ok(validate.validateL4Protocol('icmp')); });
    it('rejects empty', () => { assert.ok(validate.validateL4Protocol('')); });
    it('rejects null', () => { assert.ok(validate.validateL4Protocol(null)); });
  });

  describe('validateL4ListenPort', () => {
    it('accepts single port', () => { assert.equal(validate.validateL4ListenPort('3389'), null); });
    it('accepts port range', () => { assert.equal(validate.validateL4ListenPort('5000-5010'), null); });
    it('rejects port 0', () => { assert.ok(validate.validateL4ListenPort('0')); });
    it('rejects port above 65535', () => { assert.ok(validate.validateL4ListenPort('70000')); });
    it('rejects inverted range', () => { assert.ok(validate.validateL4ListenPort('5010-5000')); });
    it('rejects range exceeding max size', () => { assert.ok(validate.validateL4ListenPort('1000-2000')); });
    it('rejects non-numeric', () => { assert.ok(validate.validateL4ListenPort('abc')); });
    it('rejects empty', () => { assert.ok(validate.validateL4ListenPort('')); });
  });

  describe('validateL4TlsMode', () => {
    it('accepts none', () => { assert.equal(validate.validateL4TlsMode('none'), null); });
    it('accepts passthrough', () => { assert.equal(validate.validateL4TlsMode('passthrough'), null); });
    it('accepts terminate', () => { assert.equal(validate.validateL4TlsMode('terminate'), null); });
    it('rejects invalid', () => { assert.ok(validate.validateL4TlsMode('invalid')); });
    it('rejects empty', () => { assert.ok(validate.validateL4TlsMode('')); });
  });

  describe('isPortBlocked', () => {
    it('blocks port 80', () => { assert.equal(validate.isPortBlocked(80), true); });
    it('blocks port 443', () => { assert.equal(validate.isPortBlocked(443), true); });
    it('blocks port 2019', () => { assert.equal(validate.isPortBlocked(2019), true); });
    it('blocks port 3000', () => { assert.equal(validate.isPortBlocked(3000), true); });
    it('blocks port 51820', () => { assert.equal(validate.isPortBlocked(51820), true); });
    it('allows port 3389', () => { assert.equal(validate.isPortBlocked(3389), false); });
  });

  describe('parsePortRange', () => {
    it('parses single port', () => { assert.deepEqual(validate.parsePortRange('3389'), { start: 3389, end: 3389 }); });
    it('parses range', () => { assert.deepEqual(validate.parsePortRange('5000-5010'), { start: 5000, end: 5010 }); });
    it('returns null for invalid', () => { assert.equal(validate.parsePortRange('abc'), null); });
  });
});

describe('L4 Config Generation', () => {
  let l4;
  before(() => {
    l4 = require('../src/services/l4');
  });

  describe('buildL4Servers', () => {
    it('generates single TCP server for one route', () => {
      const routes = [{
        id: 1, domain: null, target_ip: '10.8.0.5', target_port: 3389,
        l4_protocol: 'tcp', l4_listen_port: '3389', l4_tls_mode: 'none',
      }];
      const servers = l4.buildL4Servers(routes);
      assert.ok(servers['l4-tcp-3389']);
      assert.deepEqual(servers['l4-tcp-3389'].listen, ['tcp/:3389']);
      assert.equal(servers['l4-tcp-3389'].routes.length, 1);
      assert.equal(servers['l4-tcp-3389'].routes[0].handle[0].handler, 'proxy');
      assert.deepEqual(servers['l4-tcp-3389'].routes[0].handle[0].upstreams, [{ dial: '10.8.0.5:3389' }]);
    });

    it('generates UDP server', () => {
      const routes = [{
        id: 2, domain: null, target_ip: '10.8.0.4', target_port: 27015,
        l4_protocol: 'udp', l4_listen_port: '27015', l4_tls_mode: 'none',
      }];
      const servers = l4.buildL4Servers(routes);
      assert.ok(servers['l4-udp-27015']);
      assert.deepEqual(servers['l4-udp-27015'].listen, ['udp/:27015']);
    });

    it('groups TLS-SNI routes on same port into one server', () => {
      const routes = [
        { id: 3, domain: 'ssh.example.com', target_ip: '10.8.0.2', target_port: 22, l4_protocol: 'tcp', l4_listen_port: '8443', l4_tls_mode: 'passthrough' },
        { id: 4, domain: 'db.example.com', target_ip: '10.8.0.3', target_port: 5432, l4_protocol: 'tcp', l4_listen_port: '8443', l4_tls_mode: 'passthrough' },
      ];
      const servers = l4.buildL4Servers(routes);
      assert.ok(servers['l4-tls-8443']);
      assert.equal(servers['l4-tls-8443'].routes.length, 2);
      assert.deepEqual(servers['l4-tls-8443'].routes[0].match, [{ tls: { sni: ['ssh.example.com'] } }]);
      assert.deepEqual(servers['l4-tls-8443'].routes[1].match, [{ tls: { sni: ['db.example.com'] } }]);
    });

    it('generates TLS terminate handler chain', () => {
      const routes = [{
        id: 5, domain: 'rdp.example.com', target_ip: '10.8.0.5', target_port: 3389,
        l4_protocol: 'tcp', l4_listen_port: '9443', l4_tls_mode: 'terminate',
      }];
      const servers = l4.buildL4Servers(routes);
      const srv = servers['l4-tls-9443'];
      assert.ok(srv);
      const route = srv.routes[0];
      assert.deepEqual(route.match, [{ tls: { sni: ['rdp.example.com'] } }]);
      assert.equal(route.handle[0].handler, 'tls');
      assert.equal(route.handle[1].handler, 'proxy');
    });

    it('handles port ranges in listen address', () => {
      const routes = [{
        id: 6, domain: null, target_ip: '10.8.0.6', target_port: 5000,
        l4_protocol: 'tcp', l4_listen_port: '5000-5010', l4_tls_mode: 'none',
      }];
      const servers = l4.buildL4Servers(routes);
      assert.ok(servers['l4-tcp-5000-5010']);
      assert.deepEqual(servers['l4-tcp-5000-5010'].listen, ['tcp/:5000-5010']);
    });

    it('returns empty object for no routes', () => {
      const servers = l4.buildL4Servers([]);
      assert.deepEqual(servers, {});
    });
  });

  describe('validatePortConflicts', () => {
    it('detects duplicate no-TLS routes on same port and protocol', () => {
      const routes = [
        { id: 1, l4_protocol: 'tcp', l4_listen_port: '3389', l4_tls_mode: 'none' },
        { id: 2, l4_protocol: 'tcp', l4_listen_port: '3389', l4_tls_mode: 'none' },
      ];
      assert.ok(l4.validatePortConflicts(routes).length > 0);
    });

    it('allows multiple TLS routes on same port', () => {
      const routes = [
        { id: 1, domain: 'a.com', l4_protocol: 'tcp', l4_listen_port: '8443', l4_tls_mode: 'passthrough' },
        { id: 2, domain: 'b.com', l4_protocol: 'tcp', l4_listen_port: '8443', l4_tls_mode: 'passthrough' },
      ];
      assert.equal(l4.validatePortConflicts(routes).length, 0);
    });

    it('detects blocked ports', () => {
      const routes = [{ id: 1, l4_protocol: 'tcp', l4_listen_port: '80', l4_tls_mode: 'none' }];
      assert.ok(l4.validatePortConflicts(routes).length > 0);
    });

    it('detects overlapping port ranges', () => {
      const routes = [
        { id: 1, l4_protocol: 'tcp', l4_listen_port: '5000-5010', l4_tls_mode: 'none' },
        { id: 2, l4_protocol: 'tcp', l4_listen_port: '5005-5015', l4_tls_mode: 'none' },
      ];
      assert.ok(l4.validatePortConflicts(routes).length > 0);
    });

    it('allows non-overlapping ranges on same protocol', () => {
      const routes = [
        { id: 1, l4_protocol: 'tcp', l4_listen_port: '5000-5010', l4_tls_mode: 'none' },
        { id: 2, l4_protocol: 'tcp', l4_listen_port: '6000-6010', l4_tls_mode: 'none' },
      ];
      assert.equal(l4.validatePortConflicts(routes).length, 0);
    });
  });
});
