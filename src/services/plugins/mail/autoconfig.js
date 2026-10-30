'use strict';

// gc.mail.autoconfig(email) (since 1.216.0): the IMAP and SMTP server of an
// address, as Thunderbird finds them —
//   1. Mozilla's ISPDB  https://autoconfig.thunderbird.net/v1.1/<domain>       → source 'ispdb'
//   2. the provider     https://autoconfig.<domain>/mail/config-v1.1.xml,
//                       https://<domain>/.well-known/autoconfig/mail/config-v1.1.xml → 'autoconfig'
//   3. DNS SRV          _imaps._tcp / _imap._tcp, _submissions._tcp / _submission._tcp → 'srv'
//   4. MX               the ISPDB entry of the mail exchanger's domain        → 'mx'
// Every HTTP request is checked like gc.http.fetch (public addresses only,
// pinned, https on 443 only, each redirect again). Only servers on the ports
// gc.mail allows count (IMAP 993/143, SMTP 465/587, never plain text).
// → { imap: { host, port, security }, smtp: { … }, source } or nulls and source null.

const dns = require('node:dns');
const netPolicy = require('../netPolicy');
const { PORTS, need } = require('./net');

const STEP_TIMEOUT_MS = 6000;
const TOTAL_TIMEOUT_MS = 25000;
const XML_MAX = 256 * 1024;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const EMAIL_RE = /^[^\s@<>()",;:\\[\]]{1,64}@([^\s@<>()",;:\\[\]]{1,253})$/;

const SOCKET = { SSL: 'tls', TLS: 'tls', STARTTLS: 'starttls' };

function entityDecode(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
}

function tag(block, name) {
  const m = new RegExp(`<${name}>([^<]{0,300})</${name}>`, 'i').exec(block);
  return m ? entityDecode(m[1]) : null;
}

/** A server of an autoconfig document that gc.mail may use, or null. */
function serverOf(block, kind, email, domain) {
  const host = (tag(block, 'hostname') || '').toLowerCase()
    .replace(/%EMAILDOMAIN%/gi, domain).replace(/%EMAILLOCALPART%/gi, email.split('@')[0]).replace(/%EMAILADDRESS%/gi, email);
  const port = Number(tag(block, 'port'));
  const security = SOCKET[String(tag(block, 'socketType') || '').toUpperCase()];
  if (!HOST_RE.test(host) || !security || PORTS[kind][port] !== security) return null;
  return { host, port, security };
}

/** Thunderbird's config-v1.1.xml → { imap, smtp } (the first usable server of each, TLS before STARTTLS). */
function parseConfig(xml, email, domain) {
  const pick = (re, kind) => {
    const found = [];
    for (const m of String(xml).matchAll(re)) {
      const s = serverOf(m[1], kind, email, domain);
      if (s) found.push(s);
    }
    return found.find((s) => s.security === 'tls') || found[0] || null;
  };
  return {
    imap: pick(/<incomingServer\s+type="imap"\s*>([\s\S]*?)<\/incomingServer>/gi, 'imap'),
    smtp: pick(/<outgoingServer\s+type="smtp"\s*>([\s\S]*?)<\/outgoingServer>/gi, 'smtp'),
  };
}

async function fetchXml(url, ctx) {
  const left = ctx.deadline - Date.now();
  if (left <= 500) return null;
  try {
    const res = await netPolicy.fetchWithPolicy(netPolicy.anyPublic([[443, 443]]), url, {
      method: 'GET', headers: { accept: 'application/xml, text/xml' }, timeoutMs: Math.min(STEP_TIMEOUT_MS, left), maxBytes: XML_MAX,
      redirect: 'follow', maxRedirects: 3, deadline: ctx.deadline, lookup: ctx.lookup, reserved: ctx.reserved,
    });
    return res.status === 200 ? res.body.toString('utf8') : null;
  } catch { return null; }
}

async function fromXml(url, ctx, email, domain) {
  const xml = await (ctx.fetchXml || fetchXml)(url, ctx);
  if (!xml || !/<clientConfig/i.test(xml)) return null;
  const r = parseConfig(xml, email, domain);
  return r.imap && r.smtp ? r : null;
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((resolve) => { const t = setTimeout(() => resolve(null), ms); t.unref(); })]);
}

async function srv(ctx, name) {
  try { return (await withTimeout(ctx.resolver.resolveSrv(name), STEP_TIMEOUT_MS)) || []; } catch { return []; }
}

async function fromSrv(ctx, domain) {
  const best = async (names) => {
    for (const [name, port, security] of names) {
      const list = (await srv(ctx, `${name}.${domain}`)).filter((r) => r && typeof r.name === 'string' && r.name !== '.')
        .sort((a, b) => a.priority - b.priority || b.weight - a.weight);
      for (const r of list) {
        const host = r.name.toLowerCase().replace(/\.$/, '');
        if (HOST_RE.test(host) && r.port === port) return { host, port, security };
      }
    }
    return null;
  };
  const imap = await best([['_imaps._tcp', 993, 'tls'], ['_imap._tcp', 143, 'starttls']]);
  const smtp = imap ? await best([['_submissions._tcp', 465, 'tls'], ['_submission._tcp', 587, 'starttls']]) : null;
  return imap && smtp ? { imap, smtp } : null;
}

/** example.co.uk-like suffixes: keep three labels when the second-level label is a generic one. */
function baseDomain(host) {
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const sld = parts[parts.length - 2];
  const keep = parts[parts.length - 1].length === 2 && /^(?:co|com|net|org|ac|gov|edu|or|ne|gv)$/.test(sld) ? 3 : 2;
  return parts.slice(-keep).join('.');
}

async function fromMx(ctx, email, domain) {
  let mx;
  try { mx = await withTimeout(ctx.resolver.resolveMx(domain), STEP_TIMEOUT_MS); } catch { mx = null; }
  if (!Array.isArray(mx) || !mx.length) return null;
  const first = mx.filter((r) => r && typeof r.exchange === 'string').sort((a, b) => a.priority - b.priority)[0];
  if (!first) return null;
  const base = baseDomain(first.exchange.toLowerCase().replace(/\.$/, ''));
  if (!HOST_RE.test(base) || base === domain) return null;
  return fromXml(`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(base)}`, ctx, email, domain);
}

/**
 * @param {string} emailRaw
 * @param {{ lookup?, reserved?, resolver?, fetchXml? }} [opts] — resolver / fetchXml: the tests' stand-ins
 */
async function autoconfig(emailRaw, opts = {}) {
  const email = typeof emailRaw === 'string' ? emailRaw.trim() : '';
  const m = EMAIL_RE.exec(email);
  need(m, 'ERR_INVALID', 'invalid email address');
  const { domainToASCII } = require('node:url');
  const domain = domainToASCII(m[1].toLowerCase());
  need(domain && HOST_RE.test(domain), 'ERR_INVALID', 'invalid email domain');
  const address = `${email.slice(0, email.lastIndexOf('@'))}@${domain}`;
  const ctx = { deadline: Date.now() + TOTAL_TIMEOUT_MS, lookup: opts.lookup, reserved: opts.reserved, resolver: opts.resolver || dns.promises,
    fetchXml: opts.fetchXml || null };
  const q = encodeURIComponent(address);
  const steps = [
    ['ispdb', () => fromXml(`https://autoconfig.thunderbird.net/v1.1/${domain}`, ctx, address, domain)],
    ['autoconfig', () => fromXml(`https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${q}`, ctx, address, domain)],
    ['autoconfig', () => fromXml(`https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${q}`, ctx, address, domain)],
    ['srv', () => fromSrv(ctx, domain)],
    ['mx', () => fromMx(ctx, address, domain)],
  ];
  for (const [source, step] of steps) {
    if (Date.now() >= ctx.deadline) break;
    const r = await step();
    if (r) return { imap: r.imap, smtp: r.smtp, source };
  }
  return { imap: null, smtp: null, source: null };
}

module.exports = { autoconfig, parseConfig, baseDomain };
