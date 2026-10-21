'use strict';

// Example plugin of the test suite (tests/plugins_*.test.js). It exercises the
// host API and tries a few things the sandbox must refuse (/escape).

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function attempt(fn) {
  try { const v = await fn(); return 'ALLOWED' + (v === undefined ? '' : ':' + String(v).slice(0, 40)); } catch (e) { return 'denied:' + (e.code || e.message); }
}

async function misbehave(gc) {
  const mode = await gc.storage.get('portal-mode');
  if (mode === 'slow') await new Promise((r) => setTimeout(r, 5000));
  if (mode === 'throw') throw new Error('broken on purpose');
  if (mode === 'garbage') return 'not a list';
  return null;
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
      case '/ws':
        try {
          const ws = await gc.http.websocket(String(req.body.url), req.body.opts || {});
          const want = Number(req.body.expect) || 0;
          const out = await new Promise((resolve) => {
            const got = [];
            let closed = null;
            const done = () => resolve({ got, closed });
            ws.on('message', (m) => { got.push(Buffer.isBuffer(m) ? { b64: m.toString('base64') } : m); if (got.length >= want && !req.body.waitClose) done(); });
            ws.on('close', (code, reason) => { closed = { code, reason }; done(); });
            setTimeout(done, 2000);
            for (const s of req.body.send || []) ws.send(typeof s === 'string' ? s : Buffer.from(String(s.b64), 'base64')).catch((e) => got.push({ sendError: e.code || e.message }));
          });
          if (!req.body.keepOpen) await ws.close(1000, 'bye');
          return { json: { ok: true, protocol: ws.protocol, ...out } };
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
      case '/user':
        return { json: { ok: true, user: await gc.users.get(Number(req.query.id)) } };
      case '/kiosk':
        // gc.kiosk.allow / list (permissions.kiosk, docs/feature-kiosk-devices.md)
        try {
          if (req.method === 'POST') await gc.kiosk.allow(req.body.userId, req.body.allowed);
          return { json: { ok: true, users: await gc.kiosk.list() } };
        } catch (e) { return { status: 400, json: { ok: false, code: e.code || null } }; }
      case '/actions':
        // gc.actions.list / get / run (permissions.actions, tests/plugins_actions.test.js); the body is passed on as is
        try {
          const b = req.body || {};
          let result;
          if (b.op === 'run') result = await gc.actions.run(b.opts);
          else if (b.op === 'get') result = await gc.actions.get(b.opts);
          else result = await gc.actions.list(b.opts);
          return { json: { ok: true, result } };
        } catch (e) { return { status: 400, json: { ok: false, code: e.code || null, error: e.message } }; }
      case '/license':
        return { json: { ok: true, license: await gc.license.status() } };
      case '/media':
        // gc.media.<op>(id, opts), gc.media.fetch(url, opts) (plugin.json `media`, tests/plugins_media.test.js)
        try {
          const b = req.body || {};
          const op = String(b.op);
          let result;
          if (op === 'usage') result = await gc.media.usage();
          else if (op === 'url') result = await gc.media.url(b.id, b.opts);
          else if (op === 'fetch') result = await gc.media.fetch(b.url, b.opts);
          else result = await gc.media[op](b.id);
          return { json: { ok: true, result } };
        } catch (e) { return { status: 400, json: { ok: false, code: e.code || null, error: e.message, ...(e.status ? { status: e.status } : {}) } }; }
      case '/gc': {
        // since 1.193.0 (tests/plugins_gatedrop.test.js): any gc function by its dotted path,
        // e.g. { fn: 'publicLinks.create', args: [{ … }] } → { ok, result } | { ok: false, code, error }
        const b = req.body || {};
        const parts = String(b.fn || '').split('.');
        let owner = gc;
        for (const k of parts.slice(0, -1)) owner = owner && Object.prototype.hasOwnProperty.call(owner, k) ? owner[k] : null;
        const fn = owner && Object.prototype.hasOwnProperty.call(owner, parts[parts.length - 1]) ? owner[parts[parts.length - 1]] : null;
        if (typeof fn !== 'function') return { status: 404, json: { ok: false, error: 'no such function' } };
        try { return { json: { ok: true, result: await fn(...(Array.isArray(b.args) ? b.args : [])) } }; } catch (e) {
          return { status: 400, json: { ok: false, code: e.code || null, error: e.message, ...(e.status ? { status: e.status } : {}) } };
        }
      }
      case '/events':
        // gc.events.emit (permissions.events, tests/plugins_events.test.js); the body is passed on as is
        try { return { json: { ok: true, result: await gc.events.emit(req.body) } }; } catch (e) { return { status: 400, json: { ok: false, code: e.code || null, error: e.message } }; }
      case '/service':
        // gc.services.call (permissions.services, tests/plugins_services.test.js)
        try { return { json: { ok: true, result: await gc.services.call(req.body) } }; } catch (e) { return { status: 400, json: { ok: false, code: e.code || null, error: e.message } }; }
      case '/service-available': {
        // gc.services.available(plugin, service) — positional, or the object form with { object: true }
        const b = req.body || {};
        try {
          const result = b.object ? await gc.services.available({ plugin: b.plugin, service: b.service }) : await gc.services.available(b.plugin, b.service);
          return { json: { ok: true, result } };
        } catch (e) { return { status: 400, json: { ok: false, code: e.code || null, error: e.message } }; }
      }
      case '/notify':
        await gc.notify('hello from the plugin', { severity: 'info' });
        return { json: { ok: true } };
      case '/notify-routes':
        // gc.notify.routes (tests/notify_routes.test.js): body { op: 'get'|'set', ...opts }
        try {
          const { op, ...o } = req.body || {};
          return { json: { ok: true, result: await (op === 'set' ? gc.notify.routes.set(o) : gc.notify.routes.get(o)) } };
        } catch (e) { return { status: 400, json: { ok: false, code: e.code || null, message: e.message } }; }
      case '/notify2':
        try { return { json: { ok: true, result: await gc.notify(req.body) } }; } catch (e) { return { status: 400, json: { ok: false, code: e.code || null } }; }
      case '/secret':
        if (req.method === 'POST') {
          try { await gc.settings.setSecret(String(req.body.key), req.body.value); } catch (e) { return { status: 400, json: { ok: false, code: e.code || null } }; }
          return { json: { ok: true } };
        }
        return { json: { ok: true, value: await gc.settings.get(String(req.query.key)) } };
      case '/legacy':
        return { json: { ok: true, snapshot: await gc.storage.get('legacy') } };
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

  // settings form status (GateControl ≥ 1.185.0): a sign-in that takes a moment, like an account would
  async settingsChanged(values, gc) {
    await new Promise((r) => setTimeout(r, 50));
    await gc.storage.set('signedIn', values.token === 'good' ? 'yes' : (values.token ? 'no' : null));
  },
  async settingsStatus({ lang }, gc) {
    const s = await gc.storage.get('signedIn');
    if (s === 'yes') return [{ group: 'account', tone: 'ok', text: lang === 'en' ? 'Signed in' : 'Angemeldet' }, { tone: 'info', text: 'Hallo\u0007 Welt' }];
    if (s === 'no') return [{ group: 'account', tone: 'error', text: 'Anmeldung fehlgeschlagen' }, { group: 'nope', tone: 'loud', text: 'x' }];
    return [];
  },
  async render(view, gc) {
    const s = await gc.settings.all();
    return { html: `<main><h1 id="hello">${esc(s.greeting)} ${esc(view.user && view.user.name)}</h1><p id="view">${esc(view.view)}:${esc(view.page)}</p><script>window.GC && GC.call('GET', 'ping');</script></main>` };
  },

  // portal tab / section only for viewers listed in the kv key "portal-viewers"
  // ("section-viewers" for sections) when set
  async portalVisible(payload, gc) {
    const ids = await gc.storage.get(payload.section ? 'section-viewers' : 'portal-viewers');
    return !Array.isArray(ids) || ids.includes(payload.user.id);
  },

  // Start tiles / search results from kv; "portal-mode" makes the plugin misbehave
  async portalTiles(payload, gc) {
    const bad = await misbehave(gc);
    if (bad) return bad;
    const tiles = (await gc.storage.get('portal-tiles')) || [];
    const u = payload.user;
    return tiles.map((x) => {
      if (x && x.title === '$viewer') return { ...x, title: 'viewer ' + u.id };
      // the whole viewer (tests/plugins_client_tiles.test.js)
      if (x && x.title === '$app') return { ...x, title: `v${u.id} ${u.portal}/${u.loggedIn}/${u.app} ${payload.lang}` };
      return x;
    });
  },
  async portalSearch(payload, gc) {
    const bad = await misbehave(gc);
    if (bad) return bad;
    const all = (await gc.storage.get('portal-results')) || [];
    return all.filter((r) => r && typeof r.title === 'string' && r.title.toLowerCase().includes(payload.q.toLowerCase()));
  },

  // quick actions of the apps (tests/plugins_quick_actions.test.js) from kv
  // "quick-actions" ('$viewer' as title → the viewer it got); "quick-mode" /
  // "quick-run-mode" make the plugin misbehave, "quick-result" is the run's
  // answer (a widget in it is passed on as is); "quick-last" keeps what the
  // run got — control / value only when the host sent them (a control run),
  // target only when the host sent one (a state run of a `targets` toggle)
  async quickActions(payload, gc) {
    const mode = await gc.storage.get('quick-mode');
    if (mode === 'slow') await new Promise((r) => setTimeout(r, 5000));
    if (mode === 'throw') throw new Error('broken on purpose');
    if (mode === 'garbage') return 'not a list';
    const list = (await gc.storage.get('quick-actions')) || [];
    const u = payload.user;
    return list.map((x) => (x && x.title === '$viewer' ? { ...x, title: `v${u.id} ${u.portal}/${u.loggedIn}/${u.app} ${payload.lang}` } : x));
  },
  async runQuickAction(payload, gc) {
    const mode = await gc.storage.get('quick-run-mode');
    // slow: answers only after the host gave up (timeout) and records nothing —
    // a late write of "quick-last" would land in whatever test runs then
    if (mode === 'slow') { await new Promise((r) => setTimeout(r, 4000)); return { ok: true, message: 'too late' }; }
    if (mode === 'throw') throw new Error('broken on purpose');
    if (mode === 'garbage') return 'not an object';
    await gc.storage.set('quick-last', {
      id: payload.id, user: payload.user, lang: payload.lang, via: payload.via, automation: payload.automation,
      ...('control' in payload || 'value' in payload ? { control: payload.control, value: payload.value } : {}),
      ...('target' in payload ? { target: payload.target } : {}),
    });
    const r = await gc.storage.get('quick-result');
    return r === null || r === undefined ? { ok: true, message: 'ran ' + payload.id, state: 'on' } : r;
  },

  // app tab (tests/plugins_app.test.js): hidden for the user ids in kv
  // "app-hidden"; "app-mode" makes the hook misbehave; the viewer it got is
  // kept in "app-last"
  async appVisible(user, gc) {
    const mode = await gc.storage.get('app-mode');
    if (mode === 'slow') await new Promise((r) => setTimeout(r, 5000));
    if (mode === 'throw') throw new Error('broken on purpose');
    await gc.storage.set('app-last', user);
    const hidden = await gc.storage.get('app-hidden');
    return !(Array.isArray(hidden) && hidden.includes(user.id));
  },

  // plugin media (tests/plugins_media.test.js): allowed for the user ids in kv
  // "media-access" (or true for everyone); "media-access-mode" throw/slow; the
  // last call is kept in "media-access-last"
  async mediaAccess(payload, gc) {
    const mode = await gc.storage.get('media-access-mode');
    if (mode === 'slow') await new Promise((r) => setTimeout(r, 2000));
    if (mode === 'throw') throw new Error('broken on purpose');
    await gc.storage.set('media-access-last', payload);
    const allowed = await gc.storage.get('media-access');
    return allowed === true || (Array.isArray(allowed) && allowed.includes(payload.user.id));
  },

  // services of services.provides (tests/plugins_services.test.js): the call is
  // kept in "service-last"; "service-mode" throw / slow / big; else an echo
  async service(payload, gc) {
    await gc.storage.set('service-last', payload);
    const mode = await gc.storage.get('service-mode');
    if (mode === 'throw') throw new Error('broken on purpose');
    if (mode === 'slow') await new Promise((r) => setTimeout(r, 2000));
    if (mode === 'big') return { blob: 'x'.repeat(17 * 1024) };
    return { ok: true, name: payload.name, caller: payload.caller, echo: payload.payload };
  },

  // callback buttons of its pushes (tests/notify_callbacks.test.js): every call
  // is appended to kv "notify-actions"; "notify-action-mode" throw / slow
  async notifyAction(payload, gc) {
    const mode = await gc.storage.get('notify-action-mode');
    if (mode === 'slow') await new Promise((r) => setTimeout(r, 2000));
    const calls = (await gc.storage.get('notify-actions')) || [];
    calls.push(payload);
    await gc.storage.set('notify-actions', calls);
    if (mode === 'throw') throw new Error('broken on purpose');
  },

  // notification sink (permissions.notifySink, tests/notify_routes.test.js):
  // every payload is appended to kv "sink-notices"; kv "sink-cover" decides
  // the answer — null (everyone in family + own), a list of user ids,
  // 'throw', or 'slow' (answers after 2 s)
  async deliverNotice(payload, gc) {
    const list = (await gc.storage.get('sink-notices')) || [];
    list.push(payload);
    await gc.storage.set('sink-notices', list);
    const mode = await gc.storage.get('sink-cover');
    if (mode === 'throw') throw new Error('broken on purpose');
    if (mode === 'slow') await new Promise((r) => setTimeout(r, 2000));
    if (Array.isArray(mode)) return { covered: mode };
    return { covered: [...payload.family, ...payload.own] };
  },

  // kv "sink-parents": user ids the sink treats as family parents ('throw' /
  // 'slow': fails / answers yes after 2 s)
  async mayRouteToFamily(payload, gc) {
    const parents = (await gc.storage.get('sink-parents')) || [];
    if (parents === 'throw') throw new Error('broken on purpose');
    if (parents === 'slow') { await new Promise((r) => setTimeout(r, 2000)); return true; }
    return parents.includes(payload.user.id);
  },

  // 1.192.0: "own chat" chosen — kv "sink-chats" maps "<userId>:<source>" → conversation id (created
  // on the first call, then reused); kv "sink-ensure" 'throw' / 'slow' (answers after 2 s) / 'none'
  async ensureNoticeChat(payload, gc) {
    const mode = await gc.storage.get('sink-ensure');
    if (mode === 'throw') throw new Error('broken on purpose');
    if (mode === 'slow') await new Promise((r) => setTimeout(r, 2000));
    if (mode === 'none') return null;
    const chats = (await gc.storage.get('sink-chats')) || {};
    const key = `${payload.user.id}:${payload.source}`;
    const created = !chats[key];
    if (created) chats[key] = `c${Object.keys(chats).length + 1}`;
    await gc.storage.set('sink-chats', chats);
    await gc.storage.set('sink-ensure-last', payload);
    return { conversationId: chats[key], created };
  },

  // public links (tests/plugins_gatedrop.test.js): every event is appended to kv "public-link-events"
  async publicLinkEvent(payload, gc) {
    const list = (await gc.storage.get('public-link-events')) || [];
    list.push(payload);
    await gc.storage.set('public-link-events', list);
  },

  // built-in data handed over by the host (tests/plugins_legacy.test.js)
  async legacyImport(snapshot, gc) {
    if (await gc.storage.get('legacy-refuse')) return { ok: false };
    await gc.storage.set('legacy', snapshot);
    const runs = ((await gc.storage.get('legacy-runs')) || 0) + 1;
    await gc.storage.set('legacy-runs', runs);
    return { ok: true, runs };
  },

  async tick(gc) {
    const n = (await gc.storage.get('ticks')) || 0;
    await gc.storage.set('ticks', n + 1);
    // "tick-slow-ms": the tick takes that long (tests/plugins_lifecycle.test.js)
    const slow = await gc.storage.get('tick-slow-ms');
    if (Number.isInteger(slow) && slow > 0) await new Promise((r) => setTimeout(r, slow));
  },
};
