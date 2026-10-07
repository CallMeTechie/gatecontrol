'use strict';

// Example plugin of the test suite (tests/plugins_*.test.js). It exercises the
// host API and tries a few things the sandbox must refuse (/escape).

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function attempt(fn) {
  try { const v = await fn(); return 'ALLOWED' + (v === undefined ? '' : ':' + String(v).slice(0, 40)); } catch (e) { return 'denied:' + (e.code || e.message); }
}

module.exports = {
  async start(gc) {
    gc.log.info('hello started');
  },

  async request(req, gc) {
    switch (req.path) {
      case '/ping':
        return { json: { ok: true, method: req.method, user: req.user, query: req.query, body: req.body, lang: req.lang } };
      case '/fetch':
        try {
          const r = await gc.http.fetch(String(req.query.url || ''), { timeoutMs: 3000 });
          return { json: { ok: true, status: r.status, body: r.body } };
        } catch (e) {
          return { status: 502, json: { ok: false, code: e.code || null, error: e.message } };
        }
      case '/fetch2':
        try {
          const r = await gc.http.fetch(String(req.body.url), req.body.opts || {});
          return { json: { ok: true, status: r.status, headers: r.headers, body: r.body, url: r.url, redirects: r.redirects } };
        } catch (e) {
          return { status: 502, json: { ok: false, code: e.code || null, error: e.message } };
        }
      case '/target':
        try {
          const r = await gc.net.fetchTarget(String(req.body.target), String(req.body.path || '/'), req.body.opts || {});
          return { json: { ok: true, status: r.status, headers: r.headers, body: r.body } };
        } catch (e) {
          return { status: 502, json: { ok: false, code: e.code || null, error: e.message } };
        }
      case '/targets':
        return { json: { ok: true, targets: await gc.net.targets() } };
      case '/tcp':
        try {
          const sock = await gc.net.tcpTarget(String(req.body.target), { index: req.body.index, port: req.body.port, timeoutMs: 3000 });
          const got = await new Promise((resolve) => {
            const chunks = [];
            sock.on('data', (d) => { chunks.push(d); if (Buffer.concat(chunks).length >= String(req.body.send).length) resolve(Buffer.concat(chunks).toString()); });
            sock.on('close', () => resolve(Buffer.concat(chunks).toString()));
            setTimeout(() => resolve(Buffer.concat(chunks).toString()), 2000);
            sock.write(String(req.body.send));
          });
          await sock.destroy();
          return { json: { ok: true, echo: got } };
        } catch (e) {
          return { status: 502, json: { ok: false, code: e.code || null, error: e.message } };
        }
      case '/discover':
        try {
          const found = await gc.net.discover(Buffer.from('probe'), { ports: req.body.ports, timeoutMs: 500 });
          return { json: { ok: true, found: found.map((f) => ({ address: f.address, data: f.data.toString() })) } };
        } catch (e) {
          return { status: 502, json: { ok: false, code: e.code || null, error: e.message } };
        }
      case '/greetings':
        if (req.method === 'POST') {
          const r = await gc.db.run('INSERT INTO greetings (text) VALUES (?)', [String(req.body && req.body.text)]);
          return { status: 201, json: { ok: true, id: r.lastInsertRowid } };
        }
        return { json: { ok: true, rows: (await gc.db.query('SELECT id, text FROM greetings ORDER BY id')).rows } };
      case '/sql':
        try { return { json: { ok: true, result: await gc.db.query(String(req.body && req.body.sql)) } }; } catch (e) { return { status: 400, json: { ok: false, error: e.message } }; }
      case '/kv':
        if (req.method === 'POST') { await gc.storage.set(String(req.body.key), req.body.value); return { json: { ok: true } }; }
        return { json: { ok: true, value: await gc.storage.get(String(req.query.key)) } };
      case '/file': {
        const fs = require('node:fs');
        const path = require('node:path');
        const f = path.join(gc.plugin.filesDir, 'notes', 'a.txt');
        if (req.method === 'POST') { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, String(req.body.text)); return { json: { ok: true } }; }
        return { json: { ok: true, text: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null } };
      }
      case '/ticks':
        return { json: { ok: true, ticks: (await gc.storage.get('ticks')) || 0 } };
      case '/settings':
        return { json: { ok: true, values: await gc.settings.all() } };
      case '/users':
        return { json: { ok: true, users: await gc.users.list() } };
      case '/license':
        return { json: { ok: true, license: await gc.license.status() } };
      case '/notify':
        await gc.notify('hello from the plugin', { severity: 'info' });
        return { json: { ok: true } };
      case '/crash':
        setTimeout(() => process.exit(3), 20);
        return { json: { ok: true } };
      case '/escape': {
        const out = {};
        out.readPasswd = await attempt(() => require('node:fs').readFileSync('/etc/passwd', 'utf8').length);
        out.childProcess = await attempt(() => require('node:child_process').execSync('id').toString());
        out.childProcessEsm = await attempt(async () => { const m = await import('node:child_process'); return typeof m.execSync; });
        out.sqlite = await attempt(async () => { const m = await import('node:sqlite'); return typeof m.DatabaseSync; });
        out.netConnect = await attempt(() => { require('node:net').connect(9, '127.0.0.1'); });
        out.httpRequest = await attempt(() => { require('node:http').get('http://127.0.0.1:2019/config/'); });
        out.fetch = await attempt(() => fetch('http://127.0.0.1:2019/config/'));
        out.killParent = await attempt(() => process.kill(process.ppid, 0));
        out.debugParent = await attempt(() => process._debugProcess(process.ppid));
        out.binding = await attempt(() => process.binding('fs'));
        out.worker = await attempt(() => require('node:worker_threads'));
        out.env = Object.keys(process.env).sort().join(',');
        return { json: { ok: true, results: out } };
      }
      default:
        return { status: 404, json: { ok: false, error: 'not_found' } };
    }
  },

  async render(view, gc) {
    const s = await gc.settings.all();
    return { html: `<main><h1 id="hello">${esc(s.greeting)} ${esc(view.user && view.user.name)}</h1><p id="view">${esc(view.view)}:${esc(view.page)}</p><script>window.GC && GC.call('GET', 'ping');</script></main>` };
  },

  async tick(gc) {
    const n = (await gc.storage.get('ticks')) || 0;
    await gc.storage.set('ticks', n + 1);
  },
};
