'use strict';

// The upload page of a public upload link (templates/public-link.njk, routes/
// publicLinks.js PUT /s/<token>/u, since 1.205.0): chosen or dropped files go
// up one after another, each with its progress; the body is the file itself
// (application/octet-stream — the type travels in ?type=), the name the
// visitor gave in ?by=. When all are done the page reloads (the visitor's own
// uploads, the limits left). No other script runs on these pages.

(function () {
  const form = document.getElementById('pl-up');
  if (!form) return;
  const input = document.getElementById('pl-input');
  const drop = document.getElementById('pl-drop');
  const prog = document.getElementById('pl-prog');
  const by = document.getElementById('pl-by');
  const token = form.dataset.token;
  const perFile = Number(form.dataset.perFile) || 0;
  let bytesLeft = Number(form.dataset.bytesLeft) || 0;
  const T = (k) => form.dataset['t' + k.charAt(0).toUpperCase() + k.slice(1)] || k;
  const CODES = { unsupported_type: 'type', type: 'type', too_large: 'tooLarge', limit: 'limit', quota_exceeded: 'full', server_full: 'full', storage_unavailable: 'full' };
  let busy = false;
  const queue = [];

  function row(file) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = file.name;
    const state = document.createElement('small');
    const bar = document.createElement('progress');
    bar.max = 100;
    bar.value = 0;
    li.append(name, state, bar);
    prog.appendChild(li);
    return { li, state, bar };
  }

  function fail(r, text) {
    r.li.dataset.state = 'error';
    r.state.textContent = T('failed') + ' – ' + text;
    r.bar.remove();
  }

  function send(file, r) {
    return new Promise((resolve) => {
      if (perFile && file.size > perFile) { fail(r, T('tooLarge')); resolve(false); return; }
      if (file.size > bytesLeft) { fail(r, T('limit')); resolve(false); return; }
      const q = new URLSearchParams({ name: file.name });
      if (file.type) q.set('type', file.type);
      if (by && by.value.trim()) q.set('by', by.value.trim());
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', '/s/' + encodeURIComponent(token) + '/u?' + q.toString());
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) r.bar.value = Math.round((e.loaded / e.total) * 100); };
      xhr.onload = () => {
        let body = null;
        try { body = JSON.parse(xhr.responseText); } catch { body = null; }
        if (xhr.status === 200 && body && body.ok) {
          r.li.dataset.state = 'done';
          r.state.textContent = T('done');
          r.bar.value = 100;
          bytesLeft -= file.size;
          resolve(true);
        } else {
          fail(r, T(CODES[body && body.code] || 'other'));
          resolve(false);
        }
      };
      xhr.onerror = () => { fail(r, T('other')); resolve(false); };
      xhr.send(file);
    });
  }

  async function run() {
    if (busy) return;
    busy = true;
    let any = false;
    while (queue.length) {
      const { file, r } = queue.shift();
      if (await send(file, r)) any = true;
    }
    busy = false;
    // the page lists the visitor's uploads and the limits left
    if (any && !prog.querySelector('[data-state="error"]')) setTimeout(() => window.location.reload(), 800);
  }

  function add(files) {
    for (const file of files) queue.push({ file, r: row(file) });
    run();
  }

  input.addEventListener('change', () => { add(Array.from(input.files || [])); input.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.dataset.over = ''; }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); delete drop.dataset.over; }));
  drop.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files) add(Array.from(e.dataTransfer.files)); });
  form.addEventListener('submit', (e) => e.preventDefault());
}());
