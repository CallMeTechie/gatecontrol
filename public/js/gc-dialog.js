'use strict';

// Shared in-app dialogs (docs/feature-wave2.md §W1.2): the one replacement for
// the browser's confirm() / alert() / prompt(), which cannot be translated,
// cannot be styled and block the page.
//
// Loaded from templates/aurora/layout.njk before every page script, so
// window.GCDialog exists on every admin page:
//   GCDialog.confirm({ title, message, detail, okLabel, danger })  → Promise<boolean>
//   GCDialog.alert  ({ title, message, detail, okLabel, danger })  → Promise<void>
//   GCDialog.prompt ({ title, label, value, placeholder, hint, okLabel,
//                      maxLength, password, validate })            → Promise<string|null>
//   GCDialog.dialog ({ title, wide })  → { overlay, box, body, foot, close, promise }
// A destructive action passes `danger: true` and gets the red button.
//
// Look and behaviour are the zones dialog (.modal-overlay.zn-dialog, styles in
// pro.css — this module adds no CSS): Escape and the × close it, the overlay
// itself does not (a mis-click must not throw away what was typed), Enter in
// the prompt field confirms, focus returns where it was.
// Texts come from window.GC.t; each key also has an English fallback so a page
// that forgets to whitelist a key still shows something sensible.
// No innerHTML anywhere — every node is built with el()/textContent.
(function (root) {
  const doc = root && root.document;
  if (!doc) return;

  const FALLBACK = {
    'common.confirm': 'Confirm',
    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'common.ok': 'OK',
    'common.save': 'Save',
    'common.error': 'Error',
    'common.note': 'Note',
    'common.delete': 'Delete',
  };
  function t(key, params) {
    const dict = (root.GC && root.GC.t) || {};
    let s = dict[key];
    if (s == null) s = FALLBACK[key] != null ? FALLBACK[key] : key;
    s = String(s);
    if (params) {
      Object.keys(params).forEach((k) => {
        s = s.split('{{' + k + '}}').join(String(params[k])).split('{' + k + '}').join(String(params[k]));
      });
    }
    return s;
  }

  const PROPS = { value: 1, disabled: 1, placeholder: 1, maxLength: 1, tabIndex: 1, autocomplete: 1 };
  function el(tag, props, children) {
    const node = doc.createElement(tag);
    const p = props || {};
    if (p.type != null) node.type = p.type;
    Object.keys(p).forEach((k) => {
      const v = p[k];
      if (k === 'type' || v == null) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'on') Object.keys(v).forEach((ev) => node.addEventListener(ev, v[ev]));
      else if (PROPS[k]) node[k] = v;
      else if (v === false) return;
      else node.setAttribute(k, v === true ? '' : v);
    });
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c == null || c === false) return;
      node.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
    });
    return node;
  }
  function closeIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(ns, 'svg');
    [['viewBox', '0 0 24 24'], ['width', '16'], ['height', '16'], ['fill', 'none'], ['stroke', 'currentColor'],
      ['stroke-width', '2'], ['stroke-linecap', 'round'], ['aria-hidden', 'true']].forEach((a) => svg.setAttribute(a[0], a[1]));
    [[18, 6, 6, 18], [6, 6, 18, 18]].forEach((c) => {
      const line = doc.createElementNS(ns, 'line');
      ['x1', 'y1', 'x2', 'y2'].forEach((n, i) => line.setAttribute(n, String(c[i])));
      svg.appendChild(line);
    });
    return svg;
  }

  let seq = 0;

  /** The bare frame. `close(result)` resolves `promise` with that result. */
  function dialog(opts) {
    const o = opts || {};
    let done = false;
    let resolveFn;
    const promise = new Promise((res) => { resolveFn = res; });
    const titleId = 'gcd-' + (++seq);
    const closeBtn = el('button', { type: 'button', class: 'modal-close gcd-close', 'aria-label': t('common.close') }, [closeIcon()]);
    const body = el('div', { class: 'modal-body zn-dialog-body gcd-body' });
    const foot = el('div', { class: 'modal-foot zn-dialog-foot gcd-foot' });
    const box = el('div', { class: 'modal zn-dialog-box gcd-box' + (o.wide ? ' zn-dialog-wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, [
      el('div', { class: 'modal-head' }, [el('span', { class: 'modal-title', id: titleId, text: o.title || '' }), closeBtn]),
      body,
      foot,
    ]);
    const overlay = el('div', { class: 'modal-overlay zn-dialog gcd-dialog', style: 'display:flex' }, [box]);
    const prevFocus = doc.activeElement;
    function close(result) {
      if (done) return;
      done = true;
      doc.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (prevFocus && prevFocus.focus && doc.contains(prevFocus)) { try { prevFocus.focus(); } catch (_) { /* gone */ } }
      resolveFn(result);
    }
    // Capture phase: a page-wide Escape handler (app.js closes every overlay)
    // must not see the key while a dialog is on top.
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(null); }
      else if (e.key === 'Enter' && o.onEnter && e.target && e.target.tagName === 'INPUT') { e.preventDefault(); o.onEnter(); }
    }
    closeBtn.addEventListener('click', () => close(null));
    doc.addEventListener('keydown', onKey, true);
    doc.body.appendChild(overlay);
    return { overlay, box, body, foot, close, promise };
  }

  function messageNodes(d, o) {
    if (o.message != null && o.message !== '') d.body.appendChild(el('p', { class: 'zn-dialog-msg gcd-msg', text: String(o.message) }));
    if (o.detail) d.body.appendChild(el('p', { class: 'zn-dialog-detail gcd-detail', text: String(o.detail) }));
  }

  /** Yes/no. → Promise<boolean> (Escape/×/Cancel = false). */
  function confirmDialog(opts) {
    const o = typeof opts === 'string' ? { message: opts } : (opts || {});
    const d = dialog({ title: o.title || t('common.confirm') });
    messageNodes(d, o);
    const ok = el('button', {
      type: 'button',
      class: 'btn ' + (o.danger ? 'btn-danger' : 'btn-primary') + ' gcd-ok',
      text: o.okLabel || t('common.confirm'),
      on: { click: () => d.close(true) },
    });
    d.foot.appendChild(el('button', { type: 'button', class: 'btn btn-ghost gcd-cancel', text: o.cancelLabel || t('common.cancel'), on: { click: () => d.close(false) } }));
    d.foot.appendChild(ok);
    ok.focus();
    return d.promise.then((r) => r === true);
  }

  /** One button. → Promise<void>; `danger: true` for an error message. */
  function alertDialog(opts) {
    const o = typeof opts === 'string' ? { message: opts } : (opts || {});
    const d = dialog({ title: o.title || t(o.danger ? 'common.error' : 'common.note') });
    messageNodes(d, o);
    const ok = el('button', { type: 'button', class: 'btn btn-primary gcd-ok', text: o.okLabel || t('common.ok'), on: { click: () => d.close(true) } });
    d.foot.appendChild(ok);
    ok.focus();
    return d.promise.then(() => undefined);
  }

  /**
   * One text field. → Promise<string|null> (null = cancelled).
   * `validate(value)` returns an error text or null/'' when the value is fine.
   */
  function promptDialog(opts) {
    const o = opts || {};
    let submit;
    const d = dialog({ title: o.title || '', onEnter: () => submit() });
    if (o.message) d.body.appendChild(el('p', { class: 'zn-dialog-msg gcd-msg', text: String(o.message) }));
    const input = el('input', {
      type: o.password ? 'password' : 'text',
      class: 'form-input zn-input gcd-input',
      value: o.value == null ? '' : String(o.value),
      placeholder: o.placeholder || '',
      autocomplete: o.password ? 'new-password' : 'off',
      'aria-label': o.label || o.title || '',
      maxLength: o.maxLength || 255,
    });
    const err = el('div', { class: 'zn-field-error gcd-error', role: 'alert' });
    err.hidden = true;
    if (o.label) d.body.appendChild(el('label', { class: 'form-label', text: o.label }));
    d.body.appendChild(input);
    if (o.hint) d.body.appendChild(el('span', { class: 'form-hint', text: o.hint }));
    d.body.appendChild(err);
    submit = () => {
      const v = o.trim === false ? input.value : input.value.trim();
      const bad = o.validate ? o.validate(v) : null;
      if (bad) { err.textContent = bad; err.hidden = false; input.focus(); return; }
      d.close(v);
    };
    d.foot.appendChild(el('button', { type: 'button', class: 'btn btn-ghost gcd-cancel', text: t('common.cancel'), on: { click: () => d.close(null) } }));
    d.foot.appendChild(el('button', { type: 'button', class: 'btn ' + (o.danger ? 'btn-danger' : 'btn-primary') + ' gcd-ok', text: o.okLabel || t('common.save'), on: { click: () => submit() } }));
    input.focus();
    input.select();
    return d.promise.then((r) => (typeof r === 'string' ? r : null));
  }

  root.GCDialog = { t, el, dialog, confirm: confirmDialog, alert: alertDialog, prompt: promptDialog };
}(typeof self !== 'undefined' ? self : this));
