'use strict';

// Pure rules of "Versionen" and "Handbuch" on the Gateways page (no DOM) —
// public/js/gateway-docs.js uses them in the browser, tests/gateway_docs.test.js
// in node. Addresses: #versions, #versions/<installed version> ("Was ist neu?":
// what an update from there brings), #handbook, #handbook/<anchor> and
// #handbook/<topic of public/js/handbook.js> (a help link of the interface).
(function (root, factory) {
  const node = typeof module !== 'undefined' && module.exports;
  const api = factory(node ? require('./handbook') : root.GCHandbook);
  if (node) module.exports = api;
  else root.GCGatewayDocsKit = api;
})(typeof self !== 'undefined' ? self : this, function (H) {
  const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
  const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
  const TOPIC_RE = /^[a-z][a-z0-9_]{0,40}(?:\.[a-z0-9_]{1,40}){0,2}$/;
  // the chapters the in-app handbook holds (services/gatewayHandbook.js CHAPTERS)
  const CHAPTER_RE = /^0[3-7]-/;

  /** "#versions/1.31.0" → { view: 'versions', from }, "#handbook/x" → { view: 'handbook', target }; else null. */
  function parseHash(hash) {
    const h = String(hash || '');
    let m = /^#versions(?:\/([^/?#]*))?$/.exec(h);
    if (m) return { view: 'versions', from: m[1] && VERSION_RE.test(m[1]) ? m[1] : null };
    m = /^#handbook(?:\/([^/?#]*))?$/.exec(h);
    if (m) {
      let x = m[1] || '';
      try { x = decodeURIComponent(x); } catch (_) { x = ''; }
      return { view: 'handbook', target: SLUG_RE.test(x) || isTopic(x) ? x : null };
    }
    return null;
  }

  function versionsHash(from) { return '#versions' + (from && VERSION_RE.test(String(from)) ? '/' + from : ''); }
  function handbookHash(target) { return '#handbook' + (target ? '/' + encodeURIComponent(target) : ''); }

  /** A help topic (public/js/handbook.js) whose chapter is part of the in-app handbook. */
  function isTopic(topic) {
    const t = H && H.TOPICS && Object.prototype.hasOwnProperty.call(H.TOPICS, topic) ? H.TOPICS[topic] : null;
    return !!(t && TOPIC_RE.test(topic) && CHAPTER_RE.test(t.de) && CHAPTER_RE.test(t.en));
  }

  /**
   * The anchor of the in-app handbook for `target` (an anchor, or a topic):
   * the topic's "<file>#<GitHub anchor>" through `anchors` of the handbook
   * (GET /api/v1/gateways/handbook), else the chapter; null when unknown.
   */
  function resolve(target, anchors, lang) {
    if (!target) return null;
    const a = anchors && typeof anchors === 'object' ? anchors : {};
    if (isTopic(target)) {
      const l = H.langOf(lang);
      const ref = H.TOPICS[target][l];
      const hit = Object.prototype.hasOwnProperty.call(a, ref) ? a[ref] : a[ref.split('#')[0]];
      return typeof hit === 'string' && SLUG_RE.test(hit) ? hit : null;
    }
    return SLUG_RE.test(target) ? target : null;
  }

  /** version → names of the gateways that report it (telemetry.gateway_version), sorted. */
  function runningOn(gateways) {
    const out = {};
    (Array.isArray(gateways) ? gateways : []).forEach((g) => {
      const v = g && g.health && g.health.telemetry ? String(g.health.telemetry.gateway_version || '').replace(/^v/i, '') : '';
      if (!VERSION_RE.test(v)) return;
      (out[v] = out[v] || []).push(String(g.name || g.peer_id || ''));
    });
    Object.keys(out).forEach((v) => out[v].sort((x, y) => x.localeCompare(y)));
    return out;
  }

  /** "läuft auf A, B und 2 weiteren": up to `max` names, then a count. */
  function namesText(names, max, more) {
    const n = Array.isArray(names) ? names : [];
    const lim = max || 3;
    if (n.length <= lim) return n.join(', ');
    return n.slice(0, lim).join(', ') + ' ' + String(more || '+{{n}}').split('{{n}}').join(String(n.length - lim));
  }

  return { VERSION_RE, SLUG_RE, parseHash, versionsHash, handbookHash, isTopic, resolve, runningOn, namesText };
});
