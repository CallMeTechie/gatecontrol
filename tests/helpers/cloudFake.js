'use strict';

// A fake Google Drive + Microsoft Graph for tests/cloud_accounts.test.js:
// the transport stub of src/services/cloudAccounts/http.js. Nothing leaves
// the machine. It checks what the real providers would: PKCE (the verifier
// against the challenge of the authorization address), the bearer token on
// every API call (401 when unknown or expired), refresh tokens, Range, the
// resumable upload sessions of Drive and the upload sessions of OneDrive —
// and records every request (calls) so the tests can see hosts and headers.

const crypto = require('node:crypto');

const OOXML = 'application/vnd.openxmlformats-officedocument.';
const FOLDER = 'application/vnd.google-apps.folder';

function b64url(b) { return Buffer.from(b).toString('base64url'); }
function sha256url(s) { return b64url(crypto.createHash('sha256').update(s).digest()); }
function json(status, body, headers) { return { status, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body }; }
function unq(s) { return s.replace(/\\(.)/g, '$1'); }

function rangeOf(h, size) {
  const m = /^bytes=(\d+)-(\d+)$/.exec(String(h || ''));
  if (!m) return null;
  return { start: Number(m[1]), end: Math.min(size - 1, Number(m[2])) };
}

function fakeCloud() {
  const S = {
    calls: [],
    codes: new Map(),   // code → { provider, challenge, purpose }
    access: new Map(),  // access token → { provider, exp }
    refresh: new Map(), // refresh token → provider
    revoked: [],
    hook: null,         // (req) → answer | null: a test's own answer first
    google: { files: new Map(), seq: 0, sessions: new Map(), exports: [] },
    ms: { items: new Map(), seq: 0, sessions: new Map(), driveId: 'drive-ben', contentAuth: [] },
  };
  S.google.files.set('root', { id: 'root', name: 'Meine Ablage', mimeType: FOLDER, parents: [], created: 0 });
  S.ms.items.set('root-ms', { id: 'root-ms', name: 'root', folder: true, parentId: null });

  /** The provider "signs in" the person: a code bound to the challenge of the authorization address. */
  S.issueCode = (provider, authorizeUrl) => {
    const u = new URL(authorizeUrl);
    const code = 'code-' + crypto.randomBytes(6).toString('hex');
    S.codes.set(code, { provider, challenge: u.searchParams.get('code_challenge'), method: u.searchParams.get('code_challenge_method') });
    return code;
  };
  S.expireAll = () => { for (const v of S.access.values()) v.exp = 0; };

  function issue(provider, extra) {
    const access = 'acc-' + crypto.randomBytes(8).toString('hex');
    const refresh = 'ref-' + crypto.randomBytes(8).toString('hex');
    S.access.set(access, { provider, exp: Date.now() + 3600 * 1000 });
    S.refresh.set(refresh, provider);
    return Object.assign({ access_token: access, refresh_token: refresh, expires_in: 3599, token_type: 'Bearer', scope: 'x' }, extra || {});
  }

  function token(provider, form) {
    const p = new URLSearchParams(form);
    if (p.get('client_secret') !== `${provider}-secret`) return json(401, { error: 'invalid_client' });
    if (p.get('grant_type') === 'authorization_code') {
      const c = S.codes.get(p.get('code'));
      S.codes.delete(p.get('code'));
      if (!c || c.provider !== provider || c.method !== 'S256' || sha256url(p.get('code_verifier') || '') !== c.challenge) return json(400, { error: 'invalid_grant' });
      if (provider === 'microsoft') {
        const idt = [b64url('{"alg":"none"}'), b64url(JSON.stringify({ preferred_username: 'ben@contoso.com', oid: 'oid-ben' })), 'sig'].join('.');
        return json(200, issue(provider, { id_token: idt }));
      }
      return json(200, issue(provider));
    }
    if (p.get('grant_type') === 'refresh_token') {
      const r = p.get('refresh_token');
      if (S.refresh.get(r) !== provider) return json(400, { error: 'invalid_grant' });
      const t = issue(provider);
      if (provider === 'google') { S.refresh.delete(t.refresh_token); delete t.refresh_token; } else S.refresh.delete(r);
      return json(200, t);
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  function authed(req, provider) {
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''));
    const t = m && S.access.get(m[1]);
    return !!t && t.provider === provider && t.exp > Date.now();
  }

  // ─── Google Drive ────────────────────────────

  S.gAdd = (f) => {
    const id = f.id || 'g' + (++S.google.seq);
    const file = Object.assign({ id, parents: ['root'], modifiedTime: '2026-10-01T10:00:00.000Z', created: ++S.google.seq }, f);
    if (file.data && file.size == null) file.size = file.data.length;
    S.google.files.set(id, file);
    return file;
  };
  const gView = (f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, ...(f.size != null ? { size: String(f.size) } : {}), modifiedTime: f.modifiedTime, trashed: !!f.trashed });

  function google(req, u) {
    const p = u.pathname;
    if (!authed(req, 'google')) return json(401, { error: { code: 401, errors: [{ reason: 'authError' }] } });
    const G = S.google;
    if (p === '/drive/v3/about') {
      if ((u.searchParams.get('fields') || '').includes('storageQuota')) return json(200, { storageQuota: { limit: '16106127360', usage: '1073741824' } });
      return json(200, { user: { displayName: 'Anna', emailAddress: 'anna@example.com', permissionId: 'perm-anna' } });
    }
    if (p === '/drive/v3/files' && req.method === 'GET') {
      const q = u.searchParams.get('q') || '';
      const parent = (/'((?:[^'\\]|\\.)*)' in parents/.exec(q) || [])[1];
      const name = (/name = '((?:[^'\\]|\\.)*)'/.exec(q) || [])[1];
      const mt = /mimeType (=|!=) '([^']*)'/.exec(q);
      let list = [...G.files.values()].filter((f) => f.id !== 'root' && !f.trashed && f.parents.includes(unq(parent || 'root')));
      if (name != null) list = list.filter((f) => f.name === unq(name));
      if (mt) list = list.filter((f) => (mt[1] === '=' ? f.mimeType === mt[2] : f.mimeType !== mt[2]));
      list.sort((a, b) => a.created - b.created);
      const size = Number(u.searchParams.get('pageSize') || 100);
      const from = Number((u.searchParams.get('pageToken') || 'p0').slice(1));
      const page = list.slice(from, from + size);
      return json(200, { files: page.map(gView), ...(from + size < list.length ? { nextPageToken: 'p' + (from + size) } : {}) });
    }
    if (p === '/drive/v3/files' && req.method === 'POST') {
      const b = JSON.parse(req.body.toString('utf8'));
      const f = S.gAdd({ name: b.name, mimeType: b.mimeType, parents: b.parents || ['root'] });
      return json(200, { id: f.id, name: f.name });
    }
    let m = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(p);
    if (m) {
      const f = G.files.get(decodeURIComponent(m[1]));
      if (!f) return json(404, { error: { code: 404, errors: [{ reason: 'notFound' }] } });
      if (req.method === 'DELETE') { G.files.delete(f.id); return { status: 204 }; }
      if (m[2]) {
        const mime = u.searchParams.get('mimeType');
        G.exports.push({ id: f.id, mime });
        return { status: 200, headers: { 'content-type': mime }, body: Buffer.from(`EXPORT ${f.name} as ${mime}`) };
      }
      if (u.searchParams.get('alt') === 'media') {
        const r = rangeOf(req.headers.range, f.data.length);
        return r ? { status: 206, body: f.data.subarray(r.start, r.end + 1) } : { status: 200, body: f.data };
      }
      return json(200, gView(f));
    }
    if (p === '/upload/drive/v3/files' && req.method === 'POST' && u.searchParams.get('uploadType') === 'resumable' && !u.searchParams.get('upload_id')) {
      const meta = JSON.parse(req.body.toString('utf8') || '{}');
      const sid = 's' + (++G.seq);
      G.sessions.set(sid, { meta, total: Number(req.headers['x-upload-content-length']), parts: [] });
      return { status: 200, headers: { location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${sid}` } };
    }
    m = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if (m && req.method === 'PATCH') {
      const sid = 's' + (++G.seq);
      G.sessions.set(sid, { existing: decodeURIComponent(m[1]), total: Number(req.headers['x-upload-content-length']), parts: [] });
      return { status: 200, headers: { location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${sid}` } };
    }
    if (p === '/upload/drive/v3/files' && req.method === 'PUT') {
      const s = G.sessions.get(u.searchParams.get('upload_id'));
      if (!s) return json(404, { error: { code: 404 } });
      const cr = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers['content-range']));
      if (!cr || Number(cr[2]) - Number(cr[1]) + 1 !== req.body.length) return json(400, { error: { code: 400 } });
      s.parts.push(req.body);
      if (Number(cr[2]) + 1 < s.total) return { status: 308 };
      const data = Buffer.concat(s.parts);
      if (s.existing) { const f = G.files.get(s.existing); f.data = data; f.size = data.length; return json(200, { id: f.id }); }
      const f = S.gAdd({ name: s.meta.name, mimeType: 'application/octet-stream', parents: s.meta.parents, data });
      return json(200, { id: f.id });
    }
    return json(404, { error: { code: 404, errors: [{ reason: 'notFound' }] } });
  }

  // ─── Microsoft Graph ─────────────────────────

  S.msAdd = (f) => {
    const id = f.id || 'M' + (++S.ms.seq) + '!1';
    const item = Object.assign({ id, parentId: 'root-ms', lastModifiedDateTime: '2026-09-30T08:00:00Z' }, f);
    S.ms.items.set(id, item);
    return item;
  };
  const msView = (i) => ({ id: i.id, name: i.name, lastModifiedDateTime: i.lastModifiedDateTime, parentReference: { driveId: S.ms.driveId },
    ...(i.folder ? { folder: { childCount: 0 } } : { size: i.data.length, file: i.mime ? { mimeType: i.mime } : {} }), ...(i.package ? { package: { type: 'oneNote' } } : {}) });
  const msId = (id) => (id === 'root' ? 'root-ms' : id);
  const childrenOf = (pid) => [...S.ms.items.values()].filter((i) => i.parentId === pid);
  function resolvePath(rootId, path) {
    let cur = S.ms.items.get(msId(rootId));
    for (const seg of path.split('/').map(decodeURIComponent)) {
      if (!cur) return null;
      cur = childrenOf(cur.id).find((i) => i.name === seg) || null;
    }
    return cur;
  }

  function graph(req, u) {
    const p = u.pathname;
    if (!authed(req, 'microsoft')) return json(401, { error: { code: 'InvalidAuthenticationToken' } });
    const M = S.ms;
    if (p === '/v1.0/me/drive' || p === `/v1.0/drives/${M.driveId}`) {
      if ((u.searchParams.get('$select') || '').includes('quota')) return json(200, { quota: { remaining: 4000000000, total: 5368709120 } });
      return json(200, { id: M.driveId, owner: { user: { displayName: 'Ben', id: 'oid-ben' } } });
    }
    let m = /^\/v1\.0\/(?:me\/drive|drives\/[^/]+)\/(?:root|items\/([^/:]+))\/children$/.exec(p);
    if (m) {
      const pid = msId(m[1] ? decodeURIComponent(m[1]) : 'root');
      if (!M.items.get(pid)) return json(404, { error: { code: 'itemNotFound' } });
      if (req.method === 'POST') {
        const b = JSON.parse(req.body.toString('utf8'));
        if (childrenOf(pid).some((i) => i.name === b.name)) {
          if (b['@microsoft.graph.conflictBehavior'] === 'fail') return json(409, { error: { code: 'nameAlreadyExists' } });
          b.name += ' 1';
        }
        return json(201, msView(S.msAdd({ name: b.name, folder: true, parentId: pid })));
      }
      const top = Number(u.searchParams.get('$top') || 200);
      const skip = Number(u.searchParams.get('$skiptoken') || 0);
      const all = childrenOf(pid);
      const page = all.slice(skip, skip + top);
      const next = skip + top < all.length ? `https://graph.microsoft.com${p}?$top=${top}&$skiptoken=${skip + top}` : null;
      return json(200, { value: page.map(msView), ...(next ? { '@odata.nextLink': next } : {}) });
    }
    m = /^\/v1\.0\/(?:me\/drive|drives\/[^/]+)\/items\/([^/:]+):\/(.+?):(\/content|\/createUploadSession)?$/.exec(p);
    if (m) {
      const root = decodeURIComponent(m[1]);
      const rel = m[2];
      const rest = m[3] || '';
      if (rest === '/content' && req.method === 'PUT') {
        const segs = rel.split('/');
        const parent = segs.length > 1 ? resolvePath(root, segs.slice(0, -1).join('/')) : M.items.get(msId(root));
        if (!parent) return json(404, { error: { code: 'itemNotFound' } });
        const name = decodeURIComponent(segs[segs.length - 1]);
        const old = childrenOf(parent.id).find((i) => i.name === name);
        if (old) { old.data = req.body; return json(200, msView(old)); }
        return json(201, msView(S.msAdd({ name, parentId: parent.id, data: req.body, mime: 'application/octet-stream' })));
      }
      if (rest === '/createUploadSession') {
        const segs = rel.split('/');
        const parent = segs.length > 1 ? resolvePath(root, segs.slice(0, -1).join('/')) : M.items.get(msId(root));
        if (!parent) return json(404, { error: { code: 'itemNotFound' } });
        const sid = 'u' + (++M.seq);
        M.sessions.set(sid, { parentId: parent.id, name: decodeURIComponent(segs[segs.length - 1]), parts: [] });
        return json(200, { uploadUrl: `https://api.onedrive.com/rup/${sid}` });
      }
      const it = resolvePath(root, rel);
      if (!it) return json(404, { error: { code: 'itemNotFound' } });
      if (req.method === 'DELETE') { M.items.delete(it.id); return { status: 204 }; }
      if (rest === '/content') return { status: 302, headers: { location: `https://contoso-my.sharepoint.com/personal/dl/${encodeURIComponent(it.id)}?tempauth=t` } };
      return json(200, msView(it));
    }
    m = /^\/v1\.0\/(?:me\/drive|drives\/[^/]+)\/items\/([^/:]+)(\/content)?$/.exec(p);
    if (m) {
      const it = M.items.get(msId(decodeURIComponent(m[1])));
      if (!it) return json(404, { error: { code: 'itemNotFound' } });
      if (m[2]) return { status: 302, headers: { location: `https://contoso-my.sharepoint.com/personal/dl/${encodeURIComponent(it.id)}?tempauth=t` } };
      return json(200, msView(it));
    }
    return json(404, { error: { code: 'itemNotFound' } });
  }

  function content(req, u) {
    S.ms.contentAuth.push(req.headers.authorization || null);
    let m = /^\/personal\/dl\/(.+)$/.exec(u.pathname);
    if (m && u.hostname === 'contoso-my.sharepoint.com') {
      const it = S.ms.items.get(decodeURIComponent(m[1]));
      if (!it) return { status: 404 };
      const r = rangeOf(req.headers.range, it.data.length);
      return r ? { status: 206, body: it.data.subarray(r.start, r.end + 1) } : { status: 200, body: it.data };
    }
    m = /^\/rup\/(.+)$/.exec(u.pathname);
    if (m && u.hostname === 'api.onedrive.com') {
      const s = S.ms.sessions.get(m[1]);
      if (!s) return { status: 404 };
      if (req.method === 'DELETE') { S.ms.sessions.delete(m[1]); return { status: 204 }; }
      const cr = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers['content-range']));
      s.parts.push(req.body);
      if (Number(cr[2]) + 1 < Number(cr[3])) return json(202, { nextExpectedRanges: [`${Number(cr[2]) + 1}-`] });
      const data = Buffer.concat(s.parts);
      const old = childrenOf(s.parentId).find((i) => i.name === s.name);
      if (old) { old.data = data; return json(200, msView(old)); }
      return json(201, msView(S.msAdd({ name: s.name, parentId: s.parentId, data, mime: 'application/octet-stream' })));
    }
    return { status: 404 };
  }

  /** The transport (src/services/cloudAccounts/http.js _setTransportForTest). */
  S.transport = async (req) => {
    const u = new URL(req.url);
    S.calls.push({ method: req.method, url: req.url, host: u.hostname, headers: req.headers });
    if (S.hook) { const r = await S.hook(req, u); if (r) return r; }
    if (u.hostname === 'oauth2.googleapis.com' && u.pathname === '/token') return token('google', req.body.toString('utf8'));
    if (u.hostname === 'oauth2.googleapis.com' && u.pathname === '/revoke') { S.revoked.push(new URLSearchParams(req.body.toString('utf8')).get('token')); return { status: 200 }; }
    if (u.hostname === 'login.microsoftonline.com' && /\/oauth2\/v2\.0\/token$/.test(u.pathname)) return token('microsoft', req.body.toString('utf8'));
    if (u.hostname === 'www.googleapis.com') return google(req, u);
    if (u.hostname === 'graph.microsoft.com') return graph(req, u);
    return content(req, u);
  };
  return S;
}

module.exports = { fakeCloud, OOXML, FOLDER };
