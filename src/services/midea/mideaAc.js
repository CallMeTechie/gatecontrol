'use strict';

const { crc8, frameChecksum } = require('./mideaCrypto');

const DEVICE_TYPE = 0xac;
const FRAME_QUERY   = 0x03;
const FRAME_CONTROL = 0x02;

const MODES      = { auto: 1, cool: 2, dry: 3, heat: 4, fan: 5 };
const MODE_BY_NUM = { 1: 'auto', 2: 'cool', 3: 'dry', 4: 'heat', 5: 'fan' };
const FAN        = { auto: 102, high: 80, medium: 60, low: 40, silent: 20 };
const SWING      = { off: 0x0, vertical: 0xc, horizontal: 0x3, both: 0xf };

// Wrap a 0xAC payload into a full 0xAA frame.
// Layout: AA | len | AC | 00 00 00 00 00 | proto(0) | frameType | <payload> | msgId | crc8 | frameChecksum
function buildFrame(frameType, payload, messageId) {
  const body        = Buffer.concat([payload, Buffer.from([messageId & 0xff])]);
  const bodyWithCrc = Buffer.concat([body, Buffer.from([crc8(body)])]);
  const header      = Buffer.from([
    0xaa,
    bodyWithCrc.length + 10,   // total frame length byte
    DEVICE_TYPE, 0, 0, 0, 0, 0,
    0,                          // protocol version
    frameType,
  ]);
  const noChecksum = Buffer.concat([header, bodyWithCrc]);
  return Buffer.concat([noChecksum, Buffer.from([frameChecksum(noChecksum.slice(1))])]);
}

// GetStateCommand — verbatim from msmart/device/AC/command.py GetStateCommand.tobytes()
function buildQuery({ messageId = 0, tempType = 0x02 } = {}) {
  const payload = Buffer.from([
    0x41, 0x81, 0x00, 0xff, 0x03, 0xff, 0x00, tempType,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x03,
  ]);
  return buildFrame(FRAME_QUERY, payload, messageId);
}

// Encode target temperature for SetStateCommand
function encodeTarget(target) {
  const intg = Math.floor(target);
  const frac = target - intg;
  let temperature = 0;
  let temperatureAlt = 0;
  if (intg >= 17 && intg <= 30) {
    temperature = (intg - 16) & 0x0f;
  } else {
    temperatureAlt = (intg - 12) & 0x1f;
  }
  if (frac > 0) temperature |= 0x10;
  return { temperature, temperatureAlt };
}

// SetStateCommand — verbatim from msmart/device/AC/command.py SetStateCommand.tobytes()
function buildSet(state, { messageId = 0, beep = true } = {}) {
  const modeNum = MODES[state.mode] ?? MODES.cool;
  const { temperature, temperatureAlt } = encodeTarget(state.targetTemp ?? 24);
  const fan = typeof state.fanSpeed === 'number' ? state.fanSpeed : (FAN[state.fanSpeed] ?? FAN.auto);

  let swing = SWING.off;
  if (state.swingV && state.swingH) swing = SWING.both;
  else if (state.swingV)            swing = SWING.vertical;
  else if (state.swingH)            swing = SWING.horizontal;

  // p[0] = 0x40 (SetState command id)
  // p[1] = CONTROL_SOURCE(0x02) | beep | power
  // p[2] = temperature bits | mode bits
  // p[3] = fan speed
  // p[4-5] = timer off (0x7F 0x7F)
  // p[6]   = 0x00
  // p[7]   = swing_mode (0x30 | swing & 0x3F)
  // p[8]   = follow_me | turbo_alt
  // p[9]   = eco | purifier | force_aux_heat | aux_heat
  // p[10]  = sleep | turbo | fahrenheit
  // p[11-17] = 0x00 (unknown)
  // p[18] = temperatureAlt
  // p[19] = humidity (0x00 default)
  // p[20] = 0x00
  // p[21] = freeze_protection
  // p[22] = independent_aux_heat
  // p[23] = 0x00
  const p = Buffer.alloc(24);
  p[0]  = 0x40;
  p[1]  = 0x02 | (beep ? 0x40 : 0x00) | (state.power ? 0x01 : 0x00);
  p[2]  = (temperature & 0x1f) | ((modeNum & 0x07) << 5);
  p[3]  = fan & 0xff;
  p[4]  = 0x7f;
  p[5]  = 0x7f;
  p[6]  = 0x00;
  p[7]  = 0x30 | (swing & 0x3f);
  p[8]  = state.turbo ? 0x20 : 0x00;                // follow_me=0 | turbo_alt
  p[9]  = state.eco ? 0x80 : 0x00;                  // eco | (purifier/aux_heat=0)
  p[10] = state.turbo ? 0x02 : 0x00;                // sleep=0 | turbo | fahrenheit=0
  // p[11..17] = 0 (already zeroed by alloc)
  p[18] = temperatureAlt & 0x1f;
  // p[19] = humidity = 40 & 0x7F = 40 (default target_humidity)
  p[19] = 40 & 0x7f;
  // p[20..23] = 0 (zeroed)
  return buildFrame(FRAME_CONTROL, p, messageId);
}

// Parse a temperature value following msmart StateResponse._parse_temperature:
//   if data == 0xFF → null
//   temp = (data - 50) / 2
//   if not fahrenheit and decimals > 0 → int(temp) + (decimals if temp >= 0 else -decimals)
//   elif decimals >= 0.5            → int(temp) + (0.5  if temp >= 0 else -0.5)
//   else                            → temp
function parseTemperature(data, decimals, fahrenheit) {
  if (data === 0xff) return null;
  const temp = (data - 50) / 2;
  if (!fahrenheit && decimals) {
    return temp >= 0
      ? Math.trunc(temp) + decimals
      : Math.trunc(temp) - decimals;
  }
  if (decimals >= 0.5) {
    return temp >= 0
      ? Math.trunc(temp) + 0.5
      : Math.trunc(temp) - 0.5;
  }
  return temp;
}

// Accepts a full 0xAA frame OR a raw payload starting at 0xC0.
// Follows StateResponse._parse() from msmart/device/AC/command.py exactly.
function parseState(frame) {
  // Strip 10-byte header + 2-byte trailer (msgId + crc8) from full AA frame
  const p = frame[0] === 0xaa ? frame.slice(10, -2) : frame;
  // p[0] === 0xC0

  const power   = (p[1] & 0x01) !== 0;
  const modeNum = (p[2] >> 5) & 0x07;

  // Primary target temp from p[2]
  let targetTemp = (p[2] & 0x0f) + 16.0 + ((p[2] & 0x10) ? 0.5 : 0.0);

  const fanSpeed = p[3] & 0x7f;
  const swing    = p[7] & 0x0f;

  // follow_me=p[8]&0x80, turbo uses two bits
  const turbo  = ((p[8] & 0x20) !== 0) || ((p[10] & 0x02) !== 0);
  const eco    = (p[9] & 0x10) !== 0;
  const sleep  = (p[10] & 0x01) !== 0;          // eslint-disable-line no-unused-vars
  const fahrenheit = (p[10] & 0x04) !== 0;

  // Indoor/outdoor temps with additional precision from p[15] nibbles
  const indoorDecimals  = (p[15] & 0x0f) / 10;
  const outdoorDecimals = (p[15] >> 4) / 10;
  const indoorTemp  = parseTemperature(p[11], indoorDecimals,  fahrenheit);
  const outdoorTemp = parseTemperature(p[12], outdoorDecimals, fahrenheit);

  // Alternate target temperature (larger range), overrides primary if non-zero
  const targetAlt = p[13] & 0x1f;
  if (targetAlt !== 0) {
    targetTemp = targetAlt + 12.0 + ((p[2] & 0x10) ? 0.5 : 0.0);
  }

  return {
    power,
    mode: MODE_BY_NUM[modeNum] || 'auto',
    targetTemp,
    indoorTemp,
    outdoorTemp,
    fanSpeed,
    swingV: (swing & 0xc) !== 0,
    swingH: (swing & 0x3) !== 0,
    eco,
    turbo,
  };
}

module.exports = {
  MODES, MODE_BY_NUM, FAN, SWING, DEVICE_TYPE,
  buildQuery, buildSet, parseState,
  encodeTarget, parseTemperature, buildFrame,
};
