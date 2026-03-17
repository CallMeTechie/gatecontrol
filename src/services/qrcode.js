'use strict';

const QRCode = require('qrcode');

const QR_OPTIONS = {
  width: 280,
  margin: 2,
  color: {
    dark: '#1c1917',
    light: '#ffffff',
  },
};

/**
 * Generate QR code as data URL (PNG base64)
 */
async function toDataUrl(text) {
  return QRCode.toDataURL(text, { type: 'image/png', ...QR_OPTIONS });
}

module.exports = {
  toDataUrl,
};
