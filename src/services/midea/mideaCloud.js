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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---- transparent-send session codec (NOT the app-key ECB codec in mideaCrypto) ----
// AES-128-CBC with PKCS7 and the per-session DERIVED IV. Used for `order` (outbound
// command) and `reply` (inbound state frame). The existing mideaCrypto.encryptAesCbc
// (IV=0, no padding) and encryptAesEcb (app-key) are the WRONG codecs for this path
// (the latter produced 解密失败/1011 live).
function cbcAlgo(key) { return key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc'; }
function sessionCbcEncrypt(key, iv, buf) {
  const c = crypto.createCipheriv(cbcAlgo(key), key, iv);
  c.setAutoPadding(true);
  return Buffer.concat([c.update(buf), c.final()]);
}
function sessionCbcDecrypt(key, iv, buf) {
  const d = crypto.createDecipheriv(cbcAlgo(key), key, iv);
  d.setAutoPadding(true);
  return Buffer.concat([d.update(buf), d.final()]);
}

/**
 * Derive the per-session AES key + IV from the login response.
 * The top-level login response carries `accessToken` (64-hex = encrypted key) and
 * `randomData` (64-hex = encrypted IV). Decrypt both with a key/iv derived from the
 * app loginKey: tmp = sha256(loginKey).hex; tmpKey = ascii(tmp[0:16]); tmpIv = ascii(tmp[16:32]).
 * Matches midealocal MSmartCloudSecurity.set_aes_keys. Returns 16-byte Buffers.
 */
function deriveSessionKeys(loginKey, encAccessTokenHex, encRandomDataHex) {
  const tmp = sha256(Buffer.from(loginKey, 'ascii')).toString('hex');
  const tmpKey = Buffer.from(tmp.slice(0, 16), 'ascii');
  const tmpIv = Buffer.from(tmp.slice(16, 32), 'ascii');
  const aesKey = sessionCbcDecrypt(tmpKey, tmpIv, Buffer.from(encAccessTokenHex, 'hex'));
  const aesIv = sessionCbcDecrypt(tmpKey, tmpIv, Buffer.from(encRandomDataHex, 'hex'));
  return { aesKey, aesIv };
}

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
      // NUMERIC types per cloud.py BaseCloud.FORMAT=2 / CLIENT_TYPE=1 (NOT strings):
      // the Midea cloud validates these strictly and answers "value is illegal"
      // when they arrive JSON-encoded as "2"/"1".
      format: 2,
      clientType: 1,
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
      const err = new MideaCloudError(msg || '2FA required', 'MIDEA_CLOUD_2FA_REQUIRED');
      err.mideaCode = String(code);
      return err;
    }
    // Surface the Midea error code so an unverified cloud schema can be diagnosed
    // from the user-visible message (e.g. "value is illegal (Midea-Code 1010)").
    const err = new MideaCloudError(`${msg || 'cloud error'} (Midea-Code ${code})`, 'MIDEA_CLOUD_ERROR');
    // Raw numeric Midea code, for callers that branch on it (e.g. 3176 retry).
    err.mideaCode = String(code);
    return err;
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
          platform: 2,            // BaseCloud.FORMAT (number), cloud.py:283
          deviceId: this.deviceId,
        },
        iotData: {
          appId: this.cfg.appId,
          src: this.cfg.appId,
          clientType: 1,          // BaseCloud.CLIENT_TYPE (number), cloud.py:289
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
      const session = { accessToken, loginId, email };
      // Capture the per-session AES key/IV for transparent-send (live-validated path).
      // The top-level response carries encrypted accessToken/randomData; the bearer
      // header still comes from mdata.accessToken (above) — these are different values.
      // Stored as hex so they survive JSON saveConfig/loadConfig + setSession.
      if (r.accessToken && r.randomData) {
        try {
          const { aesKey, aesIv } = deriveSessionKeys(this.cfg.loginKey, r.accessToken, r.randomData);
          session.aesKey = aesKey.toString('hex');
          session.aesIv = aesIv.toString('hex');
        } catch (_e) {
          // Leave the session keys unset; sendCommand will throw a clear error if used.
        }
      }
      this.session = session;
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

  /**
   * Send a 0xAA AC frame to a device via the cloud transparent-send transport and
   * return the device's SYNCHRONOUS reply frame (decrypted) as a Buffer.
   *
   * @param {string|number} applianceCode  the numeric cloud appliance id (e.g. "153931628798542").
   * @param {Buffer} frame                 a frame from mideaAc.buildQuery/buildSet.
   * @returns {Promise<Buffer>}            the decrypted reply state frame (parse later via mideaAc.parseState).
   *
   * Outbound `order` = hex(AES-128-CBC-PKCS7(ascii(comma-decimal bytes))) with the
   * per-session key/IV. Inbound `data.reply` (hex) decrypts the same way to a
   * comma-decimal ASCII string → bytes. The cloud occasionally answers code 3176
   * ("asyn reply does not exist") = the device did not reply in time and the command
   * may NOT have been applied; we retry with a short backoff before giving up.
   */
  async sendCommand(applianceCode, frame) {
    if (!this.session || !this.session.aesKey || !this.session.aesIv) {
      throw new MideaCloudError('no session key (login required)', 'MIDEA_CLOUD_NO_SESSION');
    }
    const aesKey = Buffer.from(this.session.aesKey, 'hex');
    const aesIv = Buffer.from(this.session.aesIv, 'hex');
    const orderPlain = Buffer.from(Array.from(frame).join(','), 'ascii');   // comma-decimal
    const order = sessionCbcEncrypt(aesKey, aesIv, orderPlain).toString('hex');

    const maxAttempts = this.sendCommandRetries || 3;
    const backoffMs = this.sendCommandBackoffMs == null ? 1500 : this.sendCommandBackoffMs;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let data;
      try {
        data = await this._request('/v1/appliance/transparent/send', {
          applianceCode: String(applianceCode),
          order,
          funId: 0,
          waitResp: true,
          isFull: false,
        });
      } catch (e) {
        // 3176 = the device's async reply didn't arrive in the waitResp window.
        if (e && e.mideaCode === '3176') {
          if (attempt < maxAttempts) { await sleep(backoffMs); continue; }
          throw new MideaCloudError('device did not reply in time (Midea-Code 3176)', 'MIDEA_CLOUD_NO_REPLY');
        }
        throw e;
      }
      if (!data || !data.reply) {
        throw new MideaCloudError('cloud reply missing', 'MIDEA_CLOUD_NO_REPLY');
      }
      const replyBytes = sessionCbcDecrypt(aesKey, aesIv, Buffer.from(data.reply, 'hex'));
      return Buffer.from(replyBytes.toString('ascii').split(',').map((n) => parseInt(n, 10) & 0xff));
    }
    // Unreachable: the loop either returns or throws.
    throw new MideaCloudError('device did not reply in time', 'MIDEA_CLOUD_NO_REPLY');
  }
}

module.exports = { APP_VARIANTS, MideaCloud, MideaCloudError, computeUdpid };
