'use strict';

const crypto = require('node:crypto');
const { sha256, md5, strxor } = require('./mideaCrypto');

// PUBLIC constants extracted from the official apps (msmart/cloud.py) — NOT secrets.
// References: SmartHomeCloud._Security (cloud.py:377+) and NetHomePlusCloud._Security (cloud.py:556+)
const APP_VARIANTS = {
  msmarthome: {
    appId: '1010',
    base: 'https://mp-prod.appsmb.com',
    proxied: true,
    hmacKey: 'PROD_VnoClJI9aikS8dyy',
    iotKey: 'meicloud',
    loginKey: 'ac21b9f9cbfe4ca5a88562ef25e2b768',
  },
  nethome: {
    appId: '1017',
    base: 'https://mapp.appsmb.com',
    proxied: false,
    appKey: '3742e9e5842d4ad59c2db887e12449f9',
  },
};

class MideaCloudError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MideaCloudError';
    this.code = code;
  }
}

function hexToken(n) { return crypto.randomBytes(n).toString('hex'); }

/**
 * Compute the udpid for a device id byte buffer (6 bytes).
 * udpid = strxor(sha256(idBytes)[0:16], sha256(idBytes)[16:32]).hex()
 * Matches msmart compute_device_udpid (cloud.py / device.py).
 */
function computeUdpid(deviceIdBytes) {
  const h = sha256(deviceIdBytes);               // 32 bytes
  return strxor(h.slice(0, 16), h.slice(16, 32)).toString('hex');
}

/** Format a UTC timestamp: YYYYMMDDHHmmss */
function timestamp() {
  return new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
}

class MideaCloud {
  constructor(app = 'msmarthome') {
    if (!APP_VARIANTS[app]) throw new Error(`unknown midea app variant: ${app}`);
    this.app = app;
    this.cfg = APP_VARIANTS[app];
    this.deviceId = hexToken(8);
    this.session = null;                          // { accessToken|sessionId, loginId, ... }
  }

  getSession() { return this.session; }
  setSession(s) { this.session = s; }

  // ---- low-level request: returns parsed result object or throws MideaCloudError ----
  async _request(endpoint, body, opts = {}) {
    if (this.app === 'msmarthome') return this._requestMSmart(endpoint, body, opts);
    return this._requestNetHome(endpoint, body);
  }

  /**
   * NetHome Plus request.
   * Sign = sha256(path + unquote_plus(urlencode(sorted(form))) + appKey)
   * Matches NetHomePlusCloud._Security.sign (cloud.py:562-573).
   */
  async _requestNetHome(endpoint, data) {
    const c = this.cfg;
    // Common fields per BaseCloud._build_request_body (cloud.py:124-141) +
    // NetHomePlusCloud._build_request_body (cloud.py:507-518): sessionId is
    // ALWAYS part of the signed form ('' before login, real value after).
    const form = {
      ...data,
      appId: c.appId,
      format: '2',
      clientType: '1',
      language: 'en_US',
      src: c.appId,
      stamp: timestamp(),
      deviceId: this.deviceId,
      sessionId: (this.session && this.session.sessionId) || '',
    };
    // sign = sha256(path + unquote_plus(urlencode(sorted(form))) + appKey)
    // For typical Midea values (hex, email) this reduces to: path + sorted(k=v).join('&') + appKey
    const path = new URL(c.base + endpoint).pathname;
    const sorted = Object.keys(form).sort().map((k) => `${k}=${form[k]}`).join('&');
    form.sign = sha256(Buffer.from(path + sorted + c.appKey, 'ascii')).toString('hex');

    const res = await fetch(c.base + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    if (res.status === 429) throw new MideaCloudError('rate limited', 'MIDEA_CLOUD_RATE_LIMITED');
    const json = await res.json();
    if (String(json.errorCode) !== '0') {
      throw this._mapError(json.errorCode, json.msg || json.message);
    }
    return json.result;
  }

  /**
   * MSmartHome request.
   * sign = HMAC-SHA256(hmacKey, iotKey + jsonBody + random)
   * Matches SmartHomeCloud._Security.sign (cloud.py:404-410).
   * URL = base + /mas/v5/app/proxy?alias=<endpoint>
   */
  async _requestMSmart(endpoint, data, opts = {}) {
    const c = this.cfg;
    // Per SmartHomeCloud._build_request_body (cloud.py:256-267) every API body
    // carries the common fields + reqId + stamp. The /mj/user/login body is the
    // ONE exception in cloud.py (built manually, sent raw), so login passes raw.
    const body = opts.raw ? data : {
      appId: c.appId,
      src: c.appId,
      format: '2',
      clientType: '1',
      language: 'en_US',
      deviceId: this.deviceId,
      stamp: timestamp(),
      reqId: hexToken(16),
      ...data,
    };
    const random = hexToken(16);
    const jsonBody = JSON.stringify(body);
    const sign = crypto.createHmac('sha256', Buffer.from(c.hmacKey, 'ascii'))
      .update(c.iotKey + jsonBody + random, 'ascii').digest('hex');
    // accessToken header is ALWAYS present ('' before login) per cloud.py:246.
    const headers = {
      'Content-Type': 'application/json',
      secretVersion: '1',
      sign,
      random,
      accessToken: (this.session && this.session.accessToken) || '',
    };
    const url = `${c.base}/mas/v5/app/proxy?alias=${endpoint}`;
    const res = await fetch(url, { method: 'POST', headers, body: jsonBody });
    if (res.status === 429) throw new MideaCloudError('rate limited', 'MIDEA_CLOUD_RATE_LIMITED');
    const json = await res.json();
    if (String(json.code) !== '0') throw this._mapError(json.code, json.msg || json.message);
    return json.data;
  }

  _mapError(code, msg) {
    const m = String(msg || '').toLowerCase();
    if (m.includes('2fa') || m.includes('verification') || m.includes('captcha')) {
      return new MideaCloudError(msg || '2FA required', 'MIDEA_CLOUD_2FA_REQUIRED');
    }
    return new MideaCloudError(msg || `cloud error ${code}`, 'MIDEA_CLOUD_ERROR');
  }

  async _getLoginId(account) {
    const r = await this._request('/v1/user/login/id/get', { loginAccount: account });
    return r.loginId;
  }

  /**
   * Hash password for cloud auth.
   * encrypt_password: sha256(loginId + sha256(password).hex + loginKey/appKey)
   * Matches SmartHomeCloud._Security.encrypt_password (cloud.py:412-421) and
   * NetHomePlusCloud._Security.encrypt_password (cloud.py:575-584).
   */
  _hashPassword(loginId, password) {
    const c = this.cfg;
    const inner = sha256(Buffer.from(password, 'ascii')).toString('hex');
    const key = this.app === 'msmarthome' ? c.loginKey : c.appKey;
    return sha256(Buffer.from(loginId + inner + key, 'ascii')).toString('hex');
  }

  /**
   * Hash iampwd for MSmartHome cloud auth.
   * encrypt_iam_password: sha256(loginId + md5(md5(password).hex).hex + loginKey)
   * Matches SmartHomeCloud._Security.encrypt_iam_password (cloud.py:423-438).
   */
  _hashIamPassword(loginId, password) {
    const c = this.cfg;
    const m1 = md5(Buffer.from(password, 'ascii')).toString('hex');
    const m2 = md5(Buffer.from(m1, 'ascii')).toString('hex');
    return sha256(Buffer.from(loginId + m2 + c.loginKey, 'ascii')).toString('hex');
  }

  /**
   * Login to the cloud.
   * NetHome: POST /v1/user/login → session.sessionId
   * MSmartHome: POST /mj/user/login → session.accessToken (via mdata.accessToken)
   */
  async login(email, password) {
    const loginId = await this._getLoginId(email);
    if (this.app === 'nethome') {
      // cloud.py:532-539 sends only loginAccount + password (+ common fields).
      const r = await this._request('/v1/user/login', {
        loginAccount: email,
        password: this._hashPassword(loginId, password),
      });
      this.session = { sessionId: r.sessionId, loginId, email };
    } else {
      // MSmartHome: nested data/iotData per cloud.py:281-306, sent raw (the one
      // request cloud.py does NOT pass through _build_request_body).
      const r = await this._request('/mj/user/login', {
        data: {
          platform: '2',
          deviceId: this.deviceId,
        },
        iotData: {
          appId: this.cfg.appId,
          src: this.cfg.appId,
          clientType: '1',
          loginAccount: email,
          iampwd: this._hashIamPassword(loginId, password),
          password: this._hashPassword(loginId, password),
          // cloud.py uses secrets.token_urlsafe(120) → base64url, not hex.
          pushToken: crypto.randomBytes(120).toString('base64url'),
          stamp: timestamp(),
          reqId: hexToken(16),
        },
      }, { raw: true });
      // accessToken lives in mdata per cloud.py:306
      const accessToken = r.mdata ? r.mdata.accessToken : r.accessToken;
      this.session = { accessToken, loginId, email };
    }
    return { ok: true, accountId: loginId };
  }

  /**
   * List AC devices from the cloud.
   * Filters by type 0xac/172 (air conditioner).
   */
  async listDevices() {
    // NetHome carries sessionId via the common signed form; MSmart via header.
    const r = await this._request('/v1/appliance/user/list/get', {});
    const list = r.list || r.appliances || [];
    return list.map((a) => ({
      sn: a.sn || a.applianceCode,
      name: a.name,
      type: a.type,
      id: a.id,
      online: a.onlineStatus === '1',
    })).filter((a) => {
      const t = String(a.type).toLowerCase();
      return t === '0xac' || t === '172' || Number(a.type) === 0xac;
    });
  }

  /**
   * Get V3 token + key for a device.
   * Tries both big-endian and little-endian device id bytes to compute udpid.
   * Matches BaseCloud.get_token (cloud.py:163-183) with endianness fallback.
   */
  async getToken(deviceId) {
    const idNum = BigInt(deviceId);
    for (const endian of ['le', 'be']) {
      const idBytes = Buffer.alloc(6);
      if (endian === 'le') idBytes.writeUIntLE(Number(idNum), 0, 6);
      else idBytes.writeUIntBE(Number(idNum), 0, 6);
      const udpid = computeUdpid(idBytes);
      // A genuine API/network error (429/2FA/etc) propagates; only a "no matching
      // udpId" result falls through to try the other endianness.
      const r = await this._request('/v1/iot/secure/getToken', { udpid });
      const entry = (r.tokenlist || []).find((t) => t.udpId === udpid);
      if (entry) return { token: entry.token, key: entry.key };
    }
    throw new MideaCloudError('no token for device', 'MIDEA_CLOUD_NO_TOKEN');
  }
}

module.exports = { APP_VARIANTS, MideaCloud, MideaCloudError, computeUdpid };
