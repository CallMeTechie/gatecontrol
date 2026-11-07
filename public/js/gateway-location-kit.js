'use strict';

// Pure helpers of the gateway locations (no DOM, docs/feature-gateway-locations.md):
// the address in one line, the fleet grouped by location, the stored choice
// "Gruppieren nach", the pool partners for "Auch für … übernehmen", the
// countries of the address form and the checks of the form. Used by
// public/js/gateway-locations.js and gateway-wizard.js in the browser and by
// tests/gateway_location_kit.test.js in node. The data comes from
// GET /api/v1/gateway-locations and GET /api/v1/gateways (`location`).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GCGatewayLocationKit = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const MODES = ['locations', 'pools'];
  const MODE_KEY = 'gc.gw.fleetGroup';
  const LIMITS = { name: 80, street: 120, postal_code: 16, city: 80 };
  // ISO 3166-1 alpha-2; the names come from Intl.DisplayNames in the browser's language.
  const COUNTRIES = ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ '
    + 'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE '
    + 'GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP '
    + 'KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF '
    + 'NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN '
    + 'SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA '
    + 'ZM ZW').split(' ');
  // first in the list: German-speaking countries
  const FIRST = ['DE', 'AT', 'CH'];

  function text(v) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); }

  /** "Musterweg 12, 10115 Berlin" — street, then postcode and town; '' when nothing is set. */
  function addressLine(loc) {
    if (!loc) return '';
    const place = [text(loc.postal_code), text(loc.city)].filter(Boolean).join(' ');
    return [text(loc.street), place].filter(Boolean).join(', ');
  }

  /** Name of a country code in a language ('DE' → "Deutschland"); the code when the browser has no names. */
  function countryName(code, lang) {
    const c = text(code).toUpperCase();
    if (!c) return '';
    try {
      if (typeof Intl !== 'undefined' && Intl.DisplayNames) {
        const n = new Intl.DisplayNames([lang === 'en' ? 'en' : 'de'], { type: 'region' }).of(c);
        if (n) return n;
      }
    } catch (e) { /* unknown code or old browser */ }
    return c;
  }

  /** [{ code, name }]: DE, AT, CH first, then the rest by name. */
  function countryOptions(lang) {
    const rest = COUNTRIES.filter((c) => FIRST.indexOf(c) < 0)
      .map((c) => ({ code: c, name: countryName(c, lang) }))
      .sort((a, b) => a.name.localeCompare(b.name, lang === 'en' ? 'en' : 'de'));
    return FIRST.map((c) => ({ code: c, name: countryName(c, lang) })).concat(rest);
  }

  function byName(a, b) {
    return String(a.name).localeCompare(String(b.name), 'de', { sensitivity: 'base' }) || (a.id || 0) - (b.id || 0);
  }

  /**
   * The fleet by location: [{ location, gateways }] — locations with at least
   * one gateway, by name; then { location: null, gateways } for the gateways
   * without one (only when there are any). Locations without gateways are left
   * out (they show in the dialog "Standorte" only).
   */
  function fleetSections(gateways, locations) {
    const known = new Map((locations || []).map((l) => [String(l.id), l]));
    const by = new Map();
    const none = [];
    (gateways || []).forEach((g) => {
      const id = g && g.location && g.location.id != null ? String(g.location.id) : null;
      if (id && !known.has(id)) known.set(id, g.location);
      if (!id) { none.push(g); return; }
      if (!by.has(id)) by.set(id, []);
      by.get(id).push(g);
    });
    const out = [...by.keys()].map((id) => ({ location: known.get(id), gateways: by.get(id) }))
      .sort((a, b) => byName(a.location, b.location));
    if (none.length) out.push({ location: null, gateways: none });
    return out;
  }

  /** "Gruppieren nach": the stored choice when there are locations, else 'pools'; 'locations' by default. */
  function mode(stored, locationCount) {
    if (!(locationCount > 0)) return 'pools';
    return MODES.indexOf(stored) >= 0 ? stored : 'locations';
  }

  /**
   * The gateways that share a pool with peerId ({ peer_id, name }, without
   * itself, each once) and the first such pool's name.
   */
  function poolPartners(pools, peerId, gateways) {
    const id = String(peerId);
    const names = new Map((gateways || []).map((g) => [String(g.peer_id), g.name]));
    const seen = new Set();
    const out = [];
    let pool = null;
    (pools || []).forEach((p) => {
      const ids = ((p && p.members) || []).map((m) => String(m.peer_id));
      if (ids.indexOf(id) < 0) return;
      ids.forEach((m) => {
        if (m === id || seen.has(m)) return;
        seen.add(m);
        if (!pool) pool = p.name;
        out.push({ peer_id: Number(m), name: names.get(m) || ('#' + m) });
      });
    });
    return { pool, partners: out };
  }

  /** Field checks of the address form (the server checks the same) → { field: code } | null. */
  function check(form) {
    const f = form || {};
    const errors = {};
    const name = text(f.name);
    if (!name) errors.name = 'name_required';
    else if (name.length > LIMITS.name) errors.name = 'too_long';
    ['street', 'postal_code', 'city'].forEach((k) => { if (text(f[k]).length > LIMITS[k]) errors[k] = 'too_long'; });
    const pc = text(f.postal_code);
    if (pc && !errors.postal_code && !/^[\p{L}\p{N}][\p{L}\p{N} -]*$/u.test(pc)) errors.postal_code = 'postal_invalid';
    const c = text(f.country).toUpperCase();
    if (c && COUNTRIES.indexOf(c) < 0) errors.country = 'country_invalid';
    return Object.keys(errors).length ? errors : null;
  }

  /** The body for POST/PUT /api/v1/gateway-locations from the form values. */
  function body(form) {
    const f = form || {};
    return { name: text(f.name), street: text(f.street), postal_code: text(f.postal_code), city: text(f.city), country: text(f.country).toUpperCase() };
  }

  return { MODES, MODE_KEY, LIMITS, COUNTRIES, addressLine, countryName, countryOptions, fleetSections, mode, poolPartners, check, body };
});
