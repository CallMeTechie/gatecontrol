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
