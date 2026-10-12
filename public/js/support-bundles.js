'use strict';

// Support bundles in the peer edit modal (docs/feature-support-bundle.md):
// list (time, client version, size, "neu") with view (System › Support-Pakete,
// #view/<peer>/<bundle>), download + delete, and "request a bundle" which the
// device picks up via heartbeat / peer info. Admin only — the API answers 403
// otherwise. All server values go through textContent.
(function () {
  var D = window.GCDialog;

  function T(key, params) {
    var str = (window.GC && GC.t && GC.t[key]) || key;
    Object.keys(params || {}).forEach(function (k) { str = str.split('{{' + k + '}}').join(String(params[k])); });
    return str;
  }

  function base(peerId) {
    return '/api/v1/peers/' + encodeURIComponent(peerId) + '/support-bundles';
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function productLabel(p) {
    if (p === 'pro') return 'Pro';
    if (p === 'community') return 'Community';
    if (p === 'android') return 'Android';
    return '';
  }

  var current = null; // peer id shown in the modal

  var SVGNS = 'http://www.w3.org/2000/svg';
  function icon(d) {
    var svg = document.createElementNS(SVGNS, 'svg');
    [['viewBox', '0 0 24 24'], ['width', '14'], ['height', '14'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'],
      ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']].forEach(function (a) { svg.setAttribute(a[0], a[1]); });
    d.split('|').forEach(function (part) {
      var path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', part);
      svg.appendChild(path);
    });
    return svg;
  }
  var ICON_DOWNLOAD = 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4|M7 10l5 5 5-5|M12 15V3';
  var ICON_DELETE = 'M4 7h16|M9 7V4h6v3|M6 7l1 13h10l1-13';

  // SQLite UTC 'YYYY-MM-DD HH:MM:SS' → local, short ("12.10.26, 10:14").
  function fmtTime(v) {
    var s = String(v || '');
    var ms = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
    if (!isFinite(ms)) return s;
    try {
      return new Intl.DateTimeFormat((window.GC && GC.language) === 'en' ? 'en-GB' : 'de-DE', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms));
    } catch (e) { return s + ' UTC'; }
  }

  function renderCount(bundles) {
    var tag = document.getElementById('edit-peer-support-count');
    if (!tag) return;
    var fresh = bundles.filter(function (b) { return b.is_new; }).length;
    tag.textContent = fresh ? fresh + ' ' + T('support_bundles.badge_new') : String(bundles.length);
    tag.className = 'tag ' + (fresh ? 'tag-amber' : 'tag-grey') + ' sb-tag';
    tag.hidden = !bundles.length;
  }

  function renderRequest(state, requestedAt) {
    var btn = document.getElementById('btn-edit-peer-support-request');
    var info = document.getElementById('edit-peer-support-request-state');
    if (!btn || !info) return;
    btn.dataset.requested = requestedAt ? '1' : '';
    btn.textContent = requestedAt ? T('support_bundles.request_cancel') : T('support_bundles.request');
    info.textContent = requestedAt ? T('support_bundles.requested_at', { time: requestedAt + ' UTC' }) : '';
    btn.disabled = !!state.busy;
  }

  function renderList(peerId, bundles) {
    var wrap = document.getElementById('edit-peer-support-list');
    if (!wrap) return;
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    renderCount(bundles);
    if (!bundles.length) {
      wrap.appendChild(el('div', 'form-hint', T('support_bundles.empty')));
      return;
    }
    var table = el('table', 'data-table sb-modal-table');
    var head = el('tr');
    ['support_bundles.col_time', 'support_bundles.col_client', 'support_bundles.col_size', ''].forEach(function (k) {
      head.appendChild(el('th', null, k ? T(k) : ''));
    });
    var thead = el('thead'); thead.appendChild(head); table.appendChild(thead);
    var tbody = el('tbody');
    bundles.forEach(function (b) {
      var tr = el('tr');
      tr.dataset.bundleId = String(b.id);
      var time = el('td', 'mono sb-nowrap', fmtTime(b.created_at));
      time.title = (b.created_at || '') + ' UTC';
      if (b.is_new) {
        var fresh = el('span', 'tag tag-amber sb-new-tag', T('support_bundles.badge_new'));
        fresh.style.fontSize = '10px'; fresh.style.marginLeft = '4px';
        time.appendChild(fresh);
      }
      if (b.reason === 'admin_request') {
        var tag = el('span', 'tag tag-purple', T('support_bundles.reason_admin'));
        tag.style.fontSize = '10px'; tag.style.marginLeft = '4px';
        time.appendChild(tag);
      }
      tr.appendChild(time);
      var client = (productLabel(b.client_product) + ' ' + (b.client_version || '')).trim() || '—';
      var tdClient = el('td', 'mono sb-nowrap', client);
      if (b.os) tdClient.title = b.os;
      tr.appendChild(tdClient);
      tr.appendChild(el('td', 'mono sb-nowrap', window.formatBytes ? window.formatBytes(b.size_bytes) : String(b.size_bytes)));
      var actions = el('td');
      actions.style.whiteSpace = 'nowrap';
      var view = el('a', 'btn btn-sm btn-ghost', T('support_bundles.view'));
      view.href = '/support-bundles#view/' + encodeURIComponent(peerId) + '/' + encodeURIComponent(b.id);
      view.dataset.action = 'support-view';
      actions.appendChild(view);
      var dl = el('a', 'btn btn-sm btn-ghost sb-icon-btn');
      dl.title = T('support_bundles.download');
      dl.setAttribute('aria-label', T('support_bundles.download'));
      dl.appendChild(icon(ICON_DOWNLOAD));
      dl.href = base(peerId) + '/' + encodeURIComponent(b.id) + '/download';
      dl.setAttribute('download', '');
      dl.dataset.action = 'support-download';
      actions.appendChild(dl);
      var del = el('button', 'btn btn-sm btn-ghost sb-icon-btn sb-danger');
      del.title = T('common.delete');
      del.setAttribute('aria-label', T('common.delete'));
      del.appendChild(icon(ICON_DELETE));
      del.type = 'button';
      del.dataset.action = 'support-delete';
      del.addEventListener('click', function () { removeBundle(peerId, b.id); });
      actions.appendChild(del);
      tr.appendChild(actions);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    var scroll = el('div', 'sb-table-wrap');
    scroll.appendChild(table);
    wrap.appendChild(scroll);
  }

  async function load(peerId) {
    var wrap = document.getElementById('edit-peer-support-list');
    if (wrap) { while (wrap.firstChild) wrap.removeChild(wrap.firstChild); wrap.appendChild(el('div', 'form-hint', T('common.loading'))); }
    try {
      var data = await window.api.get(base(peerId));
      if (current !== peerId) return;
      renderList(peerId, (data && data.bundles) || []);
      renderRequest({}, data && data.requestedAt);
    } catch (err) {
      if (current !== peerId || !wrap) return;
      while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
      wrap.appendChild(el('div', 'form-error', err.message || T('support_bundles.load_failed')));
    }
  }

  async function removeBundle(peerId, id) {
    var ok = await D.confirm({ message: T('support_bundles.confirm_delete'), danger: true, okLabel: T('common.delete') });
    if (!ok) return;
    try {
      var res = await window.api.del(base(peerId) + '/' + encodeURIComponent(id));
      if (res && res.ok === false) throw new Error(res.error || 'Error');
      window.showToast && window.showToast(T('support_bundles.deleted'), 'success');
    } catch (err) {
      window.showToast && window.showToast(err.message, 'error');
    }
    load(peerId);
  }

  async function toggleRequest() {
    var btn = document.getElementById('btn-edit-peer-support-request');
    if (!btn || current == null) return;
    var peerId = current;
    var requested = btn.dataset.requested === '1';
    btn.disabled = true;
    try {
      var res = requested ? await window.api.del(base(peerId) + '/request') : await window.api.post(base(peerId) + '/request', {});
      if (res && res.ok === false) throw new Error(res.error || 'Error');
      if (!requested) window.showToast && window.showToast(T('support_bundles.request_sent'), 'success');
    } catch (err) {
      window.showToast && window.showToast(err.message, 'error');
    }
    load(peerId);
  }

  function bind() {
    var btn = document.getElementById('btn-edit-peer-support-request');
    if (btn) btn.addEventListener('click', toggleRequest);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  window.GCSupportBundles = {
    /** Called by peers.js when the edit modal opens. */
    open: function (peer) {
      var group = document.getElementById('edit-peer-support-group');
      if (!group) return;
      // Every client device (Android, Pro, Community, plain WireGuard): the
      // admin can always ask for a bundle. Gateways never send one — their
      // section only shows when they somehow have bundles or a request.
      var hasAny = !!peer && ((Number(peer.support_bundles_total) || 0) > 0 || !!peer.support_bundle_requested_at);
      if (!peer || (peer.peer_type === 'gateway' && !hasAny)) {
        group.style.display = 'none';
        current = null;
        return;
      }
      group.style.display = '';
      current = peer.id;
      load(peer.id);
    },
  };
})();
