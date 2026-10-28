'use strict';

// Folders of a connected account for the storage target dialog ("Ordner
// wählen"): the folders below `parent` and a new folder. Google with
// drive.file shows only folders GateControl created itself — the dialog
// therefore offers "Neuer Ordner" first.

const http = require('./http');
const providers = require('./providers');

const { CloudError } = http;
const FOLDER = 'application/vnd.google-apps.folder';
const NAME_RE = /^[^\\/:*?"<>|\u0000-\u001f]{1,120}$/;
const ID_RE = { google: /^[A-Za-z0-9_-]{1,200}$/, microsoft: /^[A-Za-z0-9!._-]{1,200}$/ };
const MAX_PAGES = 5;

function checkId(provider, v) {
  if (v == null || v === '') return 'root';
  if (typeof v !== 'string' || !ID_RE[provider].test(v)) throw new CloudError('ERR_INVALID', 'invalid folder');
  return v;
}

/** → { driveId (OneDrive, null for Google), folders: [{ id, name }] } (by name). */
async function list(provider, api, parentId) {
  const parent = checkId(provider, parentId);
  const out = [];
  let driveId = null;
  if (provider === 'google') {
    let token = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ q: `'${parent}' in parents and mimeType = '${FOLDER}' and trashed = false`, fields: 'nextPageToken,files(id,name)',
        orderBy: 'name', pageSize: '200', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
      if (token) q.set('pageToken', token);
      const res = await api.call({ url: `${providers.GOOGLE.drive}/files?${q.toString()}` });
      if (res.status !== 200) throw await providers.apiError(res, 'folders');
      const j = await http.readJson(res.stream);
      for (const f of Array.isArray(j.files) ? j.files : []) out.push({ id: String(f.id), name: String(f.name || '') });
      token = j.nextPageToken;
      if (!token) break;
    }
  } else {
    let url = `${providers.GRAPH}/me/drive/${parent === 'root' ? 'root' : `items/${encodeURIComponent(parent)}`}/children?$top=200&$select=id,name,folder,parentReference`;
    for (let page = 0; page < MAX_PAGES && url; page++) {
      const res = await api.call({ url });
      if (res.status !== 200) throw await providers.apiError(res, 'folders');
      const j = await http.readJson(res.stream);
      for (const f of Array.isArray(j.value) ? j.value : []) {
        if (!driveId && f.parentReference && typeof f.parentReference.driveId === 'string') driveId = f.parentReference.driveId;
        if (f.folder) out.push({ id: String(f.id), name: String(f.name || '') });
      }
      const next = j['@odata.nextLink'];
      url = typeof next === 'string' && next.startsWith(`${providers.GRAPH}/me/drive/`) ? next : null;
    }
    if (!driveId) {
      const res = await api.call({ url: `${providers.GRAPH}/me/drive?$select=id` });
      if (res.status === 200) driveId = String((await http.readJson(res.stream)).id || '') || null;
      else await http.drain(res.stream);
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { driveId, folders: out };
}

/** A new folder `name` below `parent` → { id, name }. */
async function make(provider, api, parentId, name) {
  const parent = checkId(provider, parentId);
  const n = String(name == null ? '' : name).trim();
  if (!NAME_RE.test(n) || n === '.' || n === '..') throw new CloudError('ERR_INVALID', 'invalid folder name');
  let res;
  if (provider === 'google') {
    res = await api.call({ method: 'POST', url: `${providers.GOOGLE.drive}/files?fields=id,name&supportsAllDrives=true`, headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ name: n, mimeType: FOLDER, parents: [parent] })) });
  } else {
    res = await api.call({ method: 'POST', url: `${providers.GRAPH}/me/drive/${parent === 'root' ? 'root' : `items/${encodeURIComponent(parent)}`}/children`,
      headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ name: n, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' })) });
  }
  if (res.status !== 200 && res.status !== 201) throw await providers.apiError(res, 'create folder');
  const j = await http.readJson(res.stream);
  return { id: String(j.id), name: String(j.name || n) };
}

module.exports = { list, make };
