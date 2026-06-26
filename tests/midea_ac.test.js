'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ac = require('../src/services/midea/mideaAc');

test('buildQuery matches GetStateCommand vector (msg_id 0x11)', () => {
  const frame = ac.buildQuery({ messageId: 0x11, tempType: 0x02 });
  // frame[2] = device type 0xAC, frame[9] = QUERY 0x03
  assert.equal(frame[2], 0xac);
  assert.equal(frame[9], 0x03);
  // documented inner payload incl. msg_id + crc8: ...0311f4
  const inner = frame.slice(10, -1).toString('hex');     // ohne frame-checksum
  assert.equal(inner, '418100ff03ff00020000000000000000000000000311f4');
});

test('parseState decodes all 8 raw C0 payloads', () => {
  // All vectors from midea-vectors.md Task 3 — C0 payloads (no header)
  const cases = [
    ['c00181667f7f003c00000060560400420000000000000048', 16.0, 23.2, 18.4],
    ['c00191667f7f003c00000060560400440000000000000049', 16.5, 23.4, 18.4],
    ['c00181667f7f003c0000006156050036000000000000004a', 17.0, 23.6, 18.3],
    ['c00191667f7f003c0000006156050028000000000000004b', 17.5, 23.8, 18.2],
    ['c00182667f7f003c0000006156060028000000000000004c', 18.0, 23.8, 18.2],
    ['c00192667f7f003c0000006156060028000000000000004d', 18.5, 23.8, 18.2],
    ['c00183667f7f003c0000006156070028000000000000004e', 19.0, 23.8, 18.2],
    ['c00193667f7f003c00000061570700550000000000000050', 19.5, 23.5, 18.5],
  ];
  for (const [hex, target, indoor, outdoor] of cases) {
    const st = ac.parseState(Buffer.from(hex, 'hex'));
    assert.equal(st.targetTemp, target, `target for ${hex}`);
    assert.equal(st.indoorTemp, indoor, `indoor for ${hex}`);
    assert.equal(st.outdoorTemp, outdoor, `outdoor for ${hex}`);
  }
});

test('parseState decodes all 6 full 0xAA frames (strips header/trailer)', () => {
  // All vectors from midea-vectors.md Task 3 — full AA frames
  const cases = [
    ['aa22ac00000000000303c0014566000000300010045eff00000000000000000069fdb9',  21.0, 22.0,  null],
    ['aa23ac00000000000303c00145660000003c0010045c6b20000000000000000000020d79', 21.0, 21.0,  28.5],
    ['aa1eac00000000000003c0004b1e7f7f000000000069630000000000000d33',           27.0, 27.5,  24.5],
    ['aa23ac00000000000203c00188647f7f000000000063450c0056190000000000000497c3', 24.0, 24.6,   9.5],
    ['aa23ac00000000000203c00188647f7f000000000067450c00750000000000000001a3b0', 24.0, 26.5,   9.7],
    ['aa23ac00000000000203c00188647f7f000080000064450c00501d00000000000001508e', 24.0, 25.0,   9.5],
  ];
  for (const [hex, target, indoor, outdoor] of cases) {
    const st = ac.parseState(Buffer.from(hex, 'hex'));
    assert.equal(st.targetTemp, target,  `target for ${hex.slice(0, 20)}…`);
    assert.equal(st.indoorTemp, indoor,  `indoor for ${hex.slice(0, 20)}…`);
    assert.equal(st.outdoorTemp, outdoor, `outdoor for ${hex.slice(0, 20)}…`);
  }
});

test('parseState sets power boolean on full 0xAA frame', () => {
  const full = 'aa23ac00000000000303c00145660000003c0010045c6b20000000000000000000020d79';
  const st = ac.parseState(Buffer.from(full, 'hex'));
  assert.equal(st.targetTemp, 21.0);
  assert.equal(typeof st.power, 'boolean');
});

test('buildSet sets power+target+mode bytes and valid checksum', () => {
  const frame = ac.buildSet(
    { power: true, mode: 'cool', targetTemp: 22.0, fanSpeed: ac.FAN.auto },
    { messageId: 1, beep: false },
  );
  assert.equal(frame[2], 0xac);
  assert.equal(frame[9], 0x02);                 // CONTROL
  // Integrity: last byte = frameChecksum(frame[1..-1])
  const { frameChecksum } = require('../src/services/midea/mideaCrypto');
  assert.equal(frame[frame.length - 1], frameChecksum(frame.slice(1, -1)));
});
