'use strict';
const { resolveGuacTarget } = require('./guacTarget');

const SUPPORTED_PROTOCOLS = ['rdp', 'vnc', 'ssh', 'telnet'];

function applyClipboard(settings, route) {
  settings['disable-copy'] = route.browser_clipboard ? 'false' : 'true';
  settings['disable-paste'] = route.browser_clipboard ? 'false' : 'true';
}

function applyAudio(settings, route) {
  if (route.protocol === 'rdp') {
    if (route.rdp_disable_audio === 1) settings['disable-audio'] = 'true';   // NULL/0 → nothing (2a default)
    return;
  }
  if (route.protocol === 'vnc') {
    const internal = !route.access_mode || route.access_mode === 'internal' || route.access_mode === 'both';
    if (route.browser_enable_audio && internal && route.audio_servername) {  // DA-2: non-gateway only
      settings['enable-audio'] = 'true';
      settings['audio-servername'] = route.audio_servername;
    }
  }
}

function applySftp(settings, route, creds) {
  if (!route.browser_enable_sftp) return;
  const internal = !route.access_mode || route.access_mode === 'internal' || route.access_mode === 'both';
  if (!internal) return;   // DA-2: gateway/external secondary target unreachable from guacd
  settings['enable-sftp'] = 'true';
  settings['sftp-hostname'] = route.sftp_host || route.host;
  settings['sftp-port'] = String(route.sftp_port || 22);
  if (route.sftp_username) settings['sftp-username'] = route.sftp_username;
  if (creds.sftp_password) settings['sftp-password'] = creds.sftp_password;
  if (creds.sftp_private_key) { settings['sftp-private-key'] = creds.sftp_private_key; if (creds.sftp_passphrase) settings['sftp-passphrase'] = creds.sftp_passphrase; }
  if (route.sftp_disable_download) settings['sftp-disable-download'] = 'true';
  if (route.sftp_disable_upload) settings['sftp-disable-upload'] = 'true';
}

// Without a password there is nothing for NLA (CredSSP) to send: with security 'any' FreeRDP asks
// for HYBRID first, a Windows PC with NLA switched off still offers it (only not required), and
// CredSSP fails with empty credentials ("Authentication failure") — guacamole-lite does not
// support guacd's "required" instruction, so the session cannot ask for them either. 'tls' skips
// NLA and Windows shows its own sign-in screen. nla_enabled=0 keeps standard RDP security.
function applySecurity(settings, route, creds = {}) {
  if (route.nla_enabled === 0) settings.security = 'rdp';
  else settings.security = creds.password ? 'any' : 'tls';
  if (route.domain && typeof route.domain === 'string' && route.domain.length > 0) {
    settings.domain = route.domain;
  }
}

// The keymaps of guacd 1.6 (server-layout): the layout guacd assumes at the RDP server when it
// turns key events into scancodes. Without one guacd loads en-us-qwerty — a German PC then
// gets y/z and the special characters wrong.
const KEYBOARD_LAYOUTS = Object.freeze([
  'en-us-qwerty', 'en-gb-qwerty', 'de-de-qwertz', 'de-ch-qwertz', 'fr-fr-azerty', 'fr-be-azerty', 'fr-ch-qwertz',
  'it-it-qwerty', 'es-es-qwerty', 'pt-br-qwerty', 'sv-se-qwerty', 'da-dk-qwerty', 'no-no-qwerty', 'hu-hu-qwertz',
  'cs-cz-qwertz', 'pl-pl-qwerty', 'ja-jp-qwerty', 'tr-tr-qwerty',
]);
const DEFAULT_KEYBOARD_LAYOUT = 'en-us-qwerty';

/** The layout for a language tag ('de', 'de-CH', 'fr-BE' …) → a KEYBOARD_LAYOUTS entry (default en-us-qwerty). */
function layoutForLanguage(tag) {
  if (typeof tag !== 'string') return DEFAULT_KEYBOARD_LAYOUT;
  const [lang = '', region = ''] = tag.trim().toLowerCase().replace(/_/g, '-').split('-');
  const byRegion = { 'de-ch': 'de-ch-qwertz', 'fr-ch': 'fr-ch-qwertz', 'fr-be': 'fr-be-azerty', 'en-gb': 'en-gb-qwerty', 'pt-br': 'pt-br-qwerty' };
  if (byRegion[lang + '-' + region]) return byRegion[lang + '-' + region];
  const byLang = { de: 'de-de-qwertz', fr: 'fr-fr-azerty', it: 'it-it-qwerty', es: 'es-es-qwerty', sv: 'sv-se-qwerty', da: 'da-dk-qwerty',
    no: 'no-no-qwerty', nb: 'no-no-qwerty', nn: 'no-no-qwerty', hu: 'hu-hu-qwertz', cs: 'cs-cz-qwertz', pl: 'pl-pl-qwerty', ja: 'ja-jp-qwerty', tr: 'tr-tr-qwerty' };
  return byLang[lang] || DEFAULT_KEYBOARD_LAYOUT;
}

/** The language of the person's browser: the first tag of Accept-Language, else the language of the page (i18n). */
function requestLanguage(req) {
  const h = req && req.headers ? req.headers['accept-language'] : null;
  const first = typeof h === 'string' ? h.split(',')[0].split(';')[0].trim() : '';
  if (/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(first)) return first;
  return (req && typeof req.language === 'string' && req.language) || null;
}

/** server-layout of an RDP session: the device's keyboard_layout, else the person's language (route.language). */
function applyKeyboard(settings, route) {
  if (route.protocol && route.protocol !== 'rdp') return;
  settings['server-layout'] = KEYBOARD_LAYOUTS.includes(route.keyboard_layout) ? route.keyboard_layout : layoutForLanguage(route.language);
}

// Experience of a browser session (guacd → browser): every extra Windows paints is a picture guacd
// encodes and the browser decodes, so the defaults are the light ones. Only an explicit 'lan' gets
// full-window drag and desktop composition; 'auto' — and no profile at all (most PCs registered by
// a plugin bring none) — is treated like 'broadband'; 'modem' drops font smoothing too.
function applyExperience(settings, route) {
  if (route.protocol !== 'rdp') return;
  const profile = route.network_profile || 'auto';
  const isLan = profile === 'lan';
  settings['enable-font-smoothing'] = profile === 'modem' ? 'false' : 'true';
  settings['enable-full-window-drag'] = isLan ? 'true' : 'false';
  settings['enable-desktop-composition'] = isLan ? 'true' : 'false';
}

function applyRedirects(settings, route) {
  // Only redirect_printers is mappable to guacd's enable-printing.
  // redirect_drives, redirect_usb, redirect_smartcard, multi_monitor, and
  // bandwidth_limit are native-client-only: guacd RDP has no/limited support
  // for drive/USB/smartcard redirection, and mapping a guacd-side drive share
  // requires a writable container path — both are out of scope for browser sessions.
  if (route.redirect_printers) settings['enable-printing'] = 'true';
}

// The disable_* flags: 1 → off, 0 → on — an explicit choice (rdp_routes always stores 0/1 from its
// form, column default 0; a plugin's false arrives as 0) — NULL/undefined (nothing set: a plugin's
// target without the option) → the light browser default: no wallpaper, no menu animations, theming
// on. color_depth: a set value is kept, none → 16 for RDP (VNC keeps 32). With the RDP graphics
// pipeline (guacd's default) guacd 1.6 always runs 32 bpp and ignores it; it counts without it.
const BROWSER_DEFAULT_COLOR_DEPTH = 16;
function flagOn(disableFlag, defaultOn) {
  if (disableFlag === 1 || disableFlag === true) return 'false';
  if (disableFlag === 0 || disableFlag === false) return 'true';
  return defaultOn ? 'true' : 'false';
}

function applyDisplay(settings, route) {
  settings['color-depth'] = String(route.color_depth || (route.protocol === 'vnc' ? 32 : BROWSER_DEFAULT_COLOR_DEPTH));
  if (route.protocol === 'rdp') {
    settings['enable-wallpaper'] = flagOn(route.disable_wallpaper, false);
    settings['enable-theming'] = flagOn(route.disable_themes, true);
    settings['enable-menu-animations'] = flagOn(route.disable_animations, false);
    if (route.resolution_mode === 'dynamic') settings['resize-method'] = 'display-update';
  }
}

function buildRdp(route, creds) {
  const t = resolveGuacTarget(route);
  const settings = { hostname: t.host, port: String(t.port), 'ignore-cert': 'true' };
  applySecurity(settings, route, creds);
  applyClipboard(settings, route);
  applyDisplay(settings, route);
  applyExperience(settings, route);
  applyKeyboard(settings, route);
  if (creds.username) settings.username = creds.username;
  if (creds.password) settings.password = creds.password;
  applyAudio(settings, route);
  applyRedirects(settings, route);
  applySftp(settings, route, creds);
  return { type: 'rdp', settings };
}

function buildVnc(route, creds) {
  const t = resolveGuacTarget(route);
  const settings = { hostname: t.host, port: String(t.port) };
  applyClipboard(settings, route);
  applyDisplay(settings, route);   // emits color-depth only (wallpaper/theming are rdp-guarded inside applyDisplay)
  if (creds.username) settings.username = creds.username;
  if (creds.password) settings.password = creds.password;
  applyAudio(settings, route);
  applySftp(settings, route, creds);
  return { type: 'vnc', settings };
}

function buildSsh(route, creds) {
  const t = resolveGuacTarget(route);
  const settings = {
    hostname: t.host, port: String(t.port || 22),
    'font-name': 'monospace', 'font-size': '12', 'color-scheme': 'gray-black',
  };
  applyClipboard(settings, route);
  if (creds.username) settings.username = creds.username;
  if (creds.password) settings.password = creds.password;
  if (creds.ssh_private_key) {
    settings['private-key'] = creds.ssh_private_key;
    if (creds.ssh_passphrase) settings.passphrase = creds.ssh_passphrase;
  }
  // NOTE: host-key pinning is DEFERRED (guacd upstream bug GUACAMOLE-1930 — verification
  // rejects even correct keys; see _phase2b-spike-findings.md). ssh ships accept-any.
  // Native SFTP for ssh: uses the ssh connection itself.
  if (route.browser_enable_sftp) {
    settings['enable-sftp'] = 'true';
    if (route.sftp_disable_download) settings['sftp-disable-download'] = 'true';
    if (route.sftp_disable_upload) settings['sftp-disable-upload'] = 'true';
  }
  return { type: 'ssh', settings };
}   // Task 5
function buildTelnet(route, creds) {
  const t = resolveGuacTarget(route);
  const settings = { hostname: t.host, port: String(t.port || 23),
    'font-name': 'monospace', 'font-size': '12', 'color-scheme': 'gray-black' };
  applyClipboard(settings, route);
  if (creds.username) settings.username = creds.username;
  if (creds.password) settings.password = creds.password;
  return { type: 'telnet', settings };
} // Task 6

function buildConnectionSettings(route, creds = {}) {
  const protocol = route.protocol || 'rdp';
  switch (protocol) {
    case 'rdp': return buildRdp(route, creds);
    case 'vnc': return buildVnc(route, creds);
    case 'ssh': return buildSsh(route, creds);
    case 'telnet': return buildTelnet(route, creds);
    default: throw new Error(`protocol_not_supported: ${protocol}`);
  }
}

// Keep PHASE2A_PROTOCOLS exported as an ALIAS so the existing route import
// (`src/routes/api/client/rdp.js` imports { PHASE2A_PROTOCOLS }) keeps working
// until Task 10 swaps it — otherwise mint throws `undefined.includes` (500) on
// every request between the Task-4 and Task-10 commits (review-chain C3).
const PHASE2A_PROTOCOLS = SUPPORTED_PROTOCOLS;

module.exports = { buildConnectionSettings, SUPPORTED_PROTOCOLS, PHASE2A_PROTOCOLS, buildRdp, buildVnc, buildSsh, buildTelnet, applyClipboard, applyDisplay, applyExperience, applySecurity, applyRedirects,
  applyKeyboard, layoutForLanguage, requestLanguage, KEYBOARD_LAYOUTS };
