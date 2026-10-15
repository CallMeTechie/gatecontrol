'use strict';

// Profile picture and favourite colour (docs/feature-avatars.md) — shared by
// the user profile (users.js), the own profile (profile.js) and the portal's
// "Meine Geräte" tab (portal.js). window.GCAvatar:
//
//   paint(node, look)       picture (<img>) or initials on the favourite
//                           colour (class av-c-<key>) inside `node`
//   prepare(file)           → Promise<Blob>: centre square, at most 256×256,
//                           WebP quality 0.85 (JPEG when the browser cannot
//                           encode WebP), smaller quality until ≤ 96 KB
//   editor(host, opts)      preview, "Profilbild ändern" (file input),
//                           "Entfernen" and ten colour swatches (red is not
//                           offered — it means "away"); opts:
//     urls       { profile, avatar, color }   GET / PUT+DELETE / PUT
//     csrf()     the page's CSRF token
//     T(key)     strings (avatar.*)
//     toast(text, tone), confirm(text) → Promise<boolean>
//     help       key of the help text under the swatches
//     onChange(look)  after every change (header avatars)
//
// DOM nodes and textContent only — never innerHTML.
(function () {
  const doc = document;
  const MAX_BYTES = 96 * 1024;
  const MIN_SIZE = 64;
  const TARGET = 256;
  const COLOR_KEYS = ['blue', 'teal', 'green', 'lime', 'yellow', 'orange', 'pink', 'purple', 'indigo', 'slate'];

  function safeSrc(v) {
    const s = String(v == null ? '' : v);
    return /^\/avatars\/[A-Za-z0-9_-]{22,64}\.(png|jpg|webp)$/.test(s) ? s : null;
  }

  function paint(node, look) {
    if (!node) return;
    const l = look || {};
    COLOR_KEYS.forEach((k) => node.classList.remove('av-c-' + k));
    if (COLOR_KEYS.indexOf(l.color) >= 0) node.classList.add('av-c-' + l.color);
    const src = safeSrc(l.avatarUrl);
    node.classList.toggle('has-img', !!src);
    while (node.firstChild) node.removeChild(node.firstChild);
    if (src) {
      const img = doc.createElement('img');
      img.className = 'av-img';
      img.alt = '';
      img.src = src;
      node.appendChild(img);
    } else {
      node.textContent = l.initials || '?';
    }
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('read')); };
      img.src = url;
    });
  }

  function toBlob(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
  }

  /** Centre square, ≤ 256 px, WebP 0.85 (else JPEG), ≤ 96 KB. */
  async function prepare(file) {
    const img = await loadImage(file);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const side = Math.min(w, h);
    if (!side || side < MIN_SIZE) throw new Error('too_small');
    const size = Math.min(TARGET, side);
    const canvas = doc.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, Math.floor((w - side) / 2), Math.floor((h - side) / 2), side, side, 0, 0, size, size);
    // JPEG has no transparency: white behind it.
    const flat = doc.createElement('canvas');
    flat.width = size;
    flat.height = size;
    const fctx = flat.getContext('2d');
    fctx.fillStyle = '#ffffff';
    fctx.fillRect(0, 0, size, size);
    fctx.drawImage(canvas, 0, 0);
    for (const q of [0.85, 0.75, 0.6, 0.45, 0.3]) {
      let blob = await toBlob(canvas, 'image/webp', q);
      // Browsers without a WebP encoder hand back PNG.
      if (!blob || blob.type !== 'image/webp') blob = await toBlob(flat, 'image/jpeg', q);
      if (blob && blob.size <= MAX_BYTES) return blob;
    }
    throw new Error('too_large');
  }

  function el(tag, cls, text) {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  async function request(method, url, body, type, csrf) {
    const headers = { Accept: 'application/json', 'X-CSRF-Token': csrf || '' };
    if (type) headers['Content-Type'] = type;
    const res = await fetch(url, { method, headers, body: body == null ? undefined : body, credentials: 'same-origin' });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, body: data || {} };
  }

  function editor(host, opts) {
    if (!host) return null;
    const o = opts || {};
    const T = o.T || ((k) => k);
    const toast = o.toast || (() => {});
    const confirmFn = o.confirm || ((text) => (window.GCDialog ? window.GCDialog.confirm({ message: text, danger: true }) : Promise.resolve(true)));
    const csrf = o.csrf || (() => '');
    let look = null;
    let palette = COLOR_KEYS.map((k) => ({ key: k }));
    let busy = false;

    while (host.firstChild) host.removeChild(host.firstChild);
    host.classList.add('av-editor');
    const preview = el('span', 'av-preview');
    preview.setAttribute('aria-hidden', 'true');
    const side = el('div', 'av-side');
    const actions = el('div', 'av-actions');
    const file = el('input', 'av-file');
    file.type = 'file';
    file.accept = 'image/png,image/jpeg,image/webp,image/*';
    file.hidden = true;
    const change = el('button', o.buttonClass || 'btn btn-sm', T('avatar.change'));
    change.type = 'button';
    const remove = el('button', o.ghostClass || 'btn btn-sm btn-ghost', T('avatar.remove'));
    remove.type = 'button';
    actions.append(change, remove, file);
    const hint = el('p', 'av-hint', T('avatar.hint'));
    const swLabel = el('div', 'av-label', T('avatar.color'));
    const sw = el('div', 'av-swatches');
    sw.setAttribute('role', 'radiogroup');
    sw.setAttribute('aria-label', T('avatar.color'));
    const help = el('p', 'av-help', T(o.help || 'avatar.color_help'));
    const msg = el('p', 'av-msg');
    msg.setAttribute('role', 'status');
    side.append(actions, hint, swLabel, sw, help, msg);
    host.append(preview, side);

    function say(text, bad) {
      msg.textContent = text || '';
      msg.classList.toggle('is-bad', !!bad);
    }
    function errText(res) {
      const b = res && res.body;
      return (b && b.error) || T('avatar.err.failed');
    }
    function render() {
      paint(preview, look);
      remove.hidden = !(look && look.avatarUrl);
      while (sw.firstChild) sw.removeChild(sw.firstChild);
      palette.forEach((c) => {
        if (COLOR_KEYS.indexOf(c.key) < 0) return;
        const on = !!look && look.color === c.key;
        const b = el('button', 'av-swatch av-c-' + c.key);
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.setAttribute('aria-label', T('avatar.color.' + c.key));
        b.title = T('avatar.color.' + c.key);
        b.tabIndex = on || (!look && c === palette[0]) ? 0 : -1;
        b.addEventListener('click', () => pickColor(c.key));
        sw.appendChild(b);
      });
      change.disabled = busy;
      remove.disabled = busy;
    }
    function changed() {
      render();
      if (typeof o.onChange === 'function') o.onChange(look);
    }

    async function pickColor(key) {
      if (busy || (look && look.color === key)) return;
      busy = true; render();
      try {
        const res = await request('PUT', o.urls.color, JSON.stringify({ color: key }), 'application/json', csrf());
        if (res.status !== 200 || !res.body.ok) { say(errText(res), true); return; }
        look = Object.assign({}, look, { color: res.body.color, colorHex: res.body.colorHex });
        say('');
        toast(T('avatar.color_saved'), 'success');
      } catch (_) { say(T('avatar.err.failed'), true); } finally { busy = false; changed(); }
    }

    change.addEventListener('click', () => { if (!busy) file.click(); });
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      file.value = '';
      if (!f) return;
      busy = true; render();
      say('');
      try {
        let blob;
        try { blob = await prepare(f); } catch (e) {
          say(T(e && e.message === 'too_small' ? 'avatar.err.too_small' : (e && e.message === 'too_large' ? 'avatar.err.too_large' : 'avatar.err.read')), true);
          return;
        }
        const res = await request('PUT', o.urls.avatar, blob, blob.type, csrf());
        if (res.status !== 200 || !res.body.ok) { say(errText(res), true); return; }
        look = Object.assign({}, look, { avatarUrl: res.body.avatarUrl });
        toast(T('avatar.saved'), 'success');
      } catch (_) { say(T('avatar.err.failed'), true); } finally { busy = false; changed(); }
    });
    remove.addEventListener('click', async () => {
      if (busy || !(look && look.avatarUrl)) return;
      if (!(await confirmFn(T('avatar.remove_confirm')))) return;
      busy = true; render();
      try {
        const res = await request('DELETE', o.urls.avatar, null, null, csrf());
        if (res.status !== 200 || !res.body.ok) { say(errText(res), true); return; }
        look = Object.assign({}, look, { avatarUrl: null });
        say('');
        toast(T('avatar.removed'), 'success');
      } catch (_) { say(T('avatar.err.failed'), true); } finally { busy = false; changed(); }
    });

    function set(user, pal) {
      look = user ? { avatarUrl: user.avatarUrl || null, color: user.color, colorHex: user.colorHex, initials: user.initials } : null;
      if (Array.isArray(pal) && pal.length) palette = pal;
      render();
    }

    render();
    if (o.urls && o.urls.profile) {
      request('GET', o.urls.profile, null, null, csrf()).then((res) => {
        if (res.status === 200 && res.body.ok) { set(res.body.user, res.body.palette); if (typeof o.onChange === 'function') o.onChange(look); } else host.hidden = true;
      }).catch(() => { host.hidden = true; });
    }
    return { set, get: () => look };
  }

  window.GCAvatar = { paint, prepare, editor, COLOR_KEYS };
})();
