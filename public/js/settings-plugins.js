'use strict';

// Einstellungen › Plugins is the plugin area, a page of its own
// (/settings/plugins, docs/plugins.md "Plugin area"). Choosing the entry in the
// settings navigation opens it; old links land on its views:
// /settings#plugins → /settings/plugins, ?plugin=<id> → …/manage/<id>,
// ?install=<id> (dashboard notice of a former built-in integration) →
// …/catalog/<id>. Restoring the last section ("plugins") does not navigate.
(function () {
  if (!document.getElementById('pg-moved-card')) return;
  const BASE = '/settings/plugins';
  const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  function target() {
    let q;
    try { q = new URLSearchParams(location.search); } catch (_) { return BASE; }
    const install = q.get('install');
    const plugin = q.get('plugin');
    if (install && ID_RE.test(install)) return BASE + '/catalog/' + encodeURIComponent(install);
    if (plugin && ID_RE.test(plugin)) return BASE + '/manage/' + encodeURIComponent(plugin);
    return BASE;
  }
  if (location.hash === '#plugins') { location.replace(target()); return; }
  // capture phase: before settings.js switches to the (empty) section
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('.st-nav-item[data-section="plugins"]') : null;
    if (!b) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    location.assign(BASE);
  }, true);
  const sel = document.getElementById('st-select');
  if (sel) sel.addEventListener('change', (e) => { if (sel.value === 'plugins') { e.stopImmediatePropagation(); location.assign(BASE); } }, true);
  try { if (localStorage.getItem('gc-settings-section') === 'plugins') localStorage.removeItem('gc-settings-section'); } catch (_) { /* optional */ }
  window.GCSettingsExt = window.GCSettingsExt || {};
  window.GCSettingsExt.plugins = { load() {} };
}());
