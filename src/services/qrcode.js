'use strict';

const QRCode = require('qrcode');

/**
 * Generate QR code as data URL (PNG base64)
 */
async function toDataUrl(text) {
  return QRCode.toDataURL(text, {
    type: 'image/png',
    width: 280,
    margin: 2,
    color: {
      dark: '#1c1917',
      light: '#ffffff',
    },
  });
}

/**
 * Generate QR code as PNG buffer
 */
async function toBuffer(text) {
  return QRCode.toBuffer(text, {
    type: 'png',
    width: 280,
    margin: 2,
    color: {
      dark: '#1c1917',
      light: '#ffffff',
    },
  });
}

/**
 * Generate QR code as SVG string
 */
async function toSvg(text) {
  return QRCode.toString(text, {
    type: 'svg',
    width: 280,
    margin: 2,
    color: {
      dark: '#1c1917',
      light: '#ffffff',
    },
  });
}

module.exports = {
  toDataUrl,
  toBuffer,
  toSvg,
};
