'use strict';

const dgram = require('node:dgram');
const config = require('../../config/default');
const logger = require('../utils/logger');
const { checkTcp } = require('./rdpMonitor');

const MAC_RE = /^([0-9A-Fa-f]{2})[:-]([0-9A-Fa-f]{2})[:-]([0-9A-Fa-f]{2})[:-]([0-9A-Fa-f]{2})[:-]([0-9A-Fa-f]{2})[:-]([0-9A-Fa-f]{2})$/;

function buildMagicPacket(mac) {
  const match = mac.match(MAC_RE);
  if (!match) throw new Error('Invalid MAC address format');
  const macBytes = Buffer.from(match.slice(1).join(''), 'hex');
  const packet = Buffer.alloc(102);
  for (let i = 0; i < 6; i++) packet[i] = 0xff;
  for (let i = 0; i < 16; i++) macBytes.copy(packet, 6 + i * 6);
  return packet;
}

function sendMagicPacket(mac) {
  return new Promise((resolve, reject) => {
    const packet = buildMagicPacket(mac);
    const broadcastAddr = config.rdp.wolBroadcastAddress;
    const socket = dgram.createSocket('udp4');
    socket.on('error', (err) => { socket.close(); reject(err); });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, 0, packet.length, 9, broadcastAddr, (err) => {
        socket.close();
        if (err) reject(err);
        else {
          logger.info({ mac, broadcastAddr }, 'WoL magic packet sent');
          resolve();
        }
      });
    });
  });
}

async function wakeAndWait(mac, host, port) {
  await sendMagicPacket(mac);
  const timeout = config.rdp.wolTimeout;
  const pollInterval = config.rdp.wolPollInterval;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    const result = await checkTcp(host, port, config.rdp.healthCheckTimeout);
    if (result.online) {
      const elapsed = Date.now() - start;
      logger.info({ mac, host, port, elapsed }, 'Host came online after WoL');
      return { online: true, elapsed };
    }
  }
  return { online: false, elapsed: Date.now() - start };
}

module.exports = { buildMagicPacket, sendMagicPacket, wakeAndWait };
