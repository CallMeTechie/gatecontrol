'use strict';

// Settings → Plugins moved to the plugin area (/plugins, docs/plugins.md
// "Plugin area"). The section only points there; old links land on the new
// pages: /settings#plugins → /plugins, ?plugin=<id> → /plugins/manage/<id>,
// ?install=<id> (dashboard notice of a former built-in integration) →
// /plugins/catalog/<id>.
(function () {
  if (!document.getElementById('pg-moved-card')) return;
  const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  function target() {
    let q;
    try { q = new URLSearchParams(location.search); } catch (_) { return '/plugins'; }
    const install = q.get('install');
    const plugin = q.get('plugin');
    if (install && ID_RE.test(install)) return '/plugins/catalog/' + encodeURIComponent(install);
    if (plugin && ID_RE.test(plugin)) return '/plugins/manage/' + encodeURIComponent(plugin);
    return '/plugins';
  }
  if (location.hash === '#plugins') location.replace(target());
  window.GCSettingsExt = window.GCSettingsExt || {};
  window.GCSettingsExt.plugins = { load() {} };
}());
