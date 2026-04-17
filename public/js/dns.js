(function () {
  'use strict';

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (isNaN(d)) return '—';
      return d.toLocaleString();
    } catch { return '—'; }
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'style') node.setAttribute('style', attrs[k]);
        else node.setAttribute(k, attrs[k]);
      }
    }
    if (children != null) {
      const arr = Array.isArray(children) ? children : [children];
      for (const c of arr) {
        if (c == null) continue;
        if (typeof c === 'string') node.appendChild(document.createTextNode(c));
        else node.appendChild(c);
      }
    }
    return node;
  }

  function monoText(v) {
    return el('span', { style: 'font-family:var(--font-mono)' }, v == null ? '—' : String(v));
  }

  function dash() { return el('span', { style: 'color:var(--text-3)' }, '—'); }

  function tag(cls, text) {
    return el('span', { class: 'tag ' + cls }, text);
  }

  function sourceBadge(src) {
    if (!src) return tag('tag-grey', '—');
    if (src === 'admin') return tag('tag-blue', GC.t['peers.hostname_source_admin'] || 'manuell');
    if (src === 'agent') return tag('tag-green', GC.t['peers.hostname_source_agent'] || 'auto');
    if (src === 'stale') return tag('tag-amber', GC.t['peers.hostname_source_stale'] || 'stale');
    return tag('tag-grey', src);
  }

  function statDot(cls) {
    return el('span', { class: 'stat-dot ' + cls });
  }

  function replaceChildren(node, kids) {
    while (node.firstChild) node.removeChild(node.firstChild);
    const arr = Array.isArray(kids) ? kids : [kids];
    for (const k of arr) if (k != null) node.appendChild(k);
  }

  function setStatValue(id, value, dotClass) {
    const node = document.getElementById(id);
    if (!node) return;
    const kids = dotClass ? [statDot(dotClass), document.createTextNode(String(value))] : [document.createTextNode(String(value))];
    replaceChildren(node, kids);
  }

  function renderStatus(status) {
    const p = status.peers || {};
    setStatValue('dns-stat-total', p.total || 0);
    setStatValue('dns-stat-resolved', p.with_hostname || 0, 'stat-dot-green');
    setStatValue('dns-stat-auto', p.agent_source || 0, 'stat-dot-blue');
    setStatValue('dns-stat-stale', p.stale_source || 0, 'stat-dot-amber');

    const badge = status.enabled
      ? tag('tag-green', GC.t['dns.enabled'] || 'aktiv')
      : tag('tag-red', GC.t['dns.disabled'] || 'aus');
    replaceChildren(document.getElementById('dns-status-badge'), badge);
    document.getElementById('dns-domain').textContent = status.domain || '—';

    if (status.hostsFile) {
      document.getElementById('dns-hosts-path').textContent = status.hostsFile.path || '—';
      document.getElementById('dns-mtime').textContent =
        fmtDate(status.hostsFile.mtime) + ' (' + (status.hostsFile.size || 0) + ' B)';
    } else {
      document.getElementById('dns-hosts-path').textContent = '—';
      document.getElementById('dns-mtime').textContent = '—';
    }
  }

  function renderStatic(records) {
    const tbody = document.getElementById('dns-static-tbody');
    replaceChildren(tbody, []);
    if (!records || !records.length) {
      tbody.appendChild(el('tr', null,
        el('td', { colspan: '2', style: 'text-align:center;color:var(--text-3);padding:20px' }, '—')));
      return;
    }
    for (const r of records) {
      tbody.appendChild(el('tr', null, [
        el('td', null, monoText(r.fqdn)),
        el('td', null, monoText(r.ip)),
      ]));
    }
  }

  let allPeers = [];

  function renderPeers(peers) {
    const tbody = document.getElementById('dns-peer-tbody');
    replaceChildren(tbody, []);
    if (!peers.length) {
      tbody.appendChild(el('tr', null,
        el('td', { colspan: '6', style: 'text-align:center;color:var(--text-3);padding:20px' },
          GC.t['dns.no_peers'] || 'Keine Peers')));
      return;
    }
    for (const p of peers) {
      tbody.appendChild(el('tr', null, [
        el('td', null, p.name || ''),
        el('td', null, p.hostname ? monoText(p.hostname) : dash()),
        el('td', null, p.fqdn ? el('span', { style: 'font-family:var(--font-mono);font-size:11px' }, p.fqdn) : dash()),
        el('td', null, monoText(p.ip || '—')),
        el('td', null, sourceBadge(p.hostname_source)),
        el('td', null, el('span', { style: 'font-size:11px;color:var(--text-2)' }, fmtDate(p.hostname_reported_at))),
      ]));
    }
  }

  function applyFilter() {
    const q = (document.getElementById('dns-peer-search').value || '').trim().toLowerCase();
    if (!q) return renderPeers(allPeers);
    renderPeers(allPeers.filter((p) =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.hostname || '').toLowerCase().includes(q) ||
      (p.fqdn || '').toLowerCase().includes(q) ||
      (p.ip || '').includes(q)
    ));
  }

  async function load() {
    try {
      const data = await api.get('/api/system/dns/records');
      if (!data.ok) throw new Error(data.error || 'Load failed');
      renderStatus(data.status || {});
      renderStatic(data.staticRecords || []);
      allPeers = data.peers || [];
      applyFilter();
    } catch (err) {
      const tbody = document.getElementById('dns-peer-tbody');
      if (tbody) {
        replaceChildren(tbody, el('tr', null,
          el('td', { colspan: '6', style: 'text-align:center;color:var(--red);padding:20px' }, err.message)));
      }
    }
  }

  document.getElementById('btn-dns-reload').addEventListener('click', load);
  document.getElementById('dns-peer-search').addEventListener('input', applyFilter);
  load();
})();
