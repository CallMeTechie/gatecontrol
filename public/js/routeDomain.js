(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RouteDomain = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function isValidPrefix(prefix) {
    const p = String(prefix == null ? '' : prefix).trim().toLowerCase();
    if (p === '') return true;
    return p.split('.').every(l => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l));
  }
  function assembleRouteDomain(prefix, base) {
    const b = String(base || '').trim().toLowerCase();
    if (!b) return '';
    const p = String(prefix || '').trim().toLowerCase();
    return p ? `${p}.${b}` : b;
  }
  return { assembleRouteDomain, isValidPrefix };
});
