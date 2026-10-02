'use strict';

// Support bundles in the peer edit modal (docs/feature-support-bundle.md):
// list (time, client version, size) with download + delete, and "request a
// bundle" which the device picks up via heartbeat / peer info. Admin only —
// the API answers 403 otherwise. All server values go through textContent.
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
    if (!bundles.length) {
      wrap.appendChild(el('div', 'form-hint', T('support_bundles.empty')));
      return;
    }
    var table = el('table', 'data-table');
    table.style.fontSize = '12px';
    var head = el('tr');
    ['support_bundles.col_time', 'support_bundles.col_client', 'support_bundles.col_size', ''].forEach(function (k) {
      head.appendChild(el('th', null, k ? T(k) : ''));
    });
    var thead = el('thead'); thead.appendChild(head); table.appendChild(thead);
    var tbody = el('tbody');
    bundles.forEach(function (b) {
      var tr = el('tr');
      tr.dataset.bundleId = String(b.id);
      var time = el('td', 'mono', (b.created_at || '') + ' UTC');
      if (b.reason === 'admin_request') {
        var tag = el('span', 'tag tag-purple', T('support_bundles.reason_admin'));
        tag.style.fontSize = '10px'; tag.style.marginLeft = '4px';
        time.appendChild(tag);
      }
      tr.appendChild(time);
      var client = (productLabel(b.client_product) + ' ' + (b.client_version || '')).trim() || '—';
      var tdClient = el('td', 'mono', client);
      if (b.os) tdClient.title = b.os;
      tr.appendChild(tdClient);
      tr.appendChild(el('td', 'mono', window.formatBytes ? window.formatBytes(b.size_bytes) : String(b.size_bytes)));
      var actions = el('td');
      actions.style.whiteSpace = 'nowrap';
      var dl = el('a', 'btn btn-sm btn-ghost', T('support_bundles.download'));
      dl.href = base(peerId) + '/' + encodeURIComponent(b.id) + '/download';
      dl.setAttribute('download', '');
      dl.dataset.action = 'support-download';
      actions.appendChild(dl);
      var del = el('button', 'btn btn-sm btn-ghost', T('common.delete'));
      del.type = 'button';
      del.dataset.action = 'support-delete';
      del.addEventListener('click', function () { removeBundle(peerId, b.id); });
      actions.appendChild(del);
      tr.appendChild(actions);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
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
      if (!peer || peer.peer_type === 'gateway') {
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
