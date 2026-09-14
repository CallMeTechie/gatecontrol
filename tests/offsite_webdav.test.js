'use strict';

// WebDAV transport (docs/feature-release-b.md §7) against a local fake
// WebDAV server: Basic auth, PROPFIND depth 0/1, MKCOL, PUT, DELETE.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const webdav = require('../src/services/offsite/webdav');

describe('WebDAV transport', () => {
  const files = new Map(); // path → Buffer
  const cols = new Set(['/dav/']);
  const log = [];
  let server;
  let base;

  before(async () => {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        log.push(`${req.method} ${req.url} depth=${req.headers.depth || ''}`);
        if (req.headers.authorization !== 'Basic ' + Buffer.from('alice:s3cr3t:with colon').toString('base64')) {
          res.writeHead(401, { 'www-authenticate': 'Basic realm="x"' }); res.end(); return;
        }
        const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (req.method === 'PROPFIND') {
          if (!cols.has(p)) { res.writeHead(404); res.end(); return; }
          const entries = [`<D:response><D:href>${encodeURI(p)}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>`];
          if (req.headers.depth === '1') {
            for (const [fp, buf] of files) {
              if (fp.startsWith(p) && !fp.slice(p.length).includes('/')) {
                entries.push(`<D:response><D:href>${encodeURI(fp).replace(/&/g, '&amp;')}</D:href><D:propstat><D:prop><D:resourcetype/><lp1:getcontentlength xmlns:lp1="DAV:">${buf.length}</lp1:getcontentlength><D:getlastmodified>Mon, 14 Sep 2026 03:00:00 GMT</D:getlastmodified></D:prop></D:propstat></D:response>`);
              }
            }
            for (const c of cols) {
              if (c !== p && c.startsWith(p) && !c.slice(p.length, -1).includes('/')) {
                entries.push(`<D:response><D:href>${c}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>`);
              }
            }
          }
          res.writeHead(207, { 'content-type': 'application/xml' });
          res.end(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${entries.join('')}</D:multistatus>`);
          return;
        }
        if (req.method === 'MKCOL') {
          const parent = p.replace(/[^/]+\/$/, '');
          if (!cols.has(parent)) { res.writeHead(409); res.end(); return; }
          cols.add(p); res.writeHead(201); res.end(); return;
        }
        if (req.method === 'PUT') {
          const dir = p.replace(/[^/]+$/, '');
          if (!cols.has(dir)) { res.writeHead(409); res.end(); return; }
          files.set(p, Buffer.concat(chunks)); res.writeHead(201); res.end(); return;
        }
        if (req.method === 'DELETE') { const had = files.delete(p); res.writeHead(had ? 204 : 404); res.end(); return; }
        res.writeHead(405); res.end();
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const cfg = () => ({ url: `${base}/dav/gatecontrol`, username: 'alice', password: 's3cr3t:with colon' });

  it('test() creates the missing folder, writes + deletes a probe', async () => {
    const detail = await webdav.test(cfg());
    assert.match(detail, /folder created, write \+ delete ok/);
    assert.ok(cols.has('/dav/gatecontrol/'));
    assert.ok(![...files.keys()].some((k) => k.includes('write-test')));
  });

  it('upload + list (namespace prefixes, encoded names, sub-collections skipped)', async () => {
    await webdav.upload(cfg(), 'gatecontrol-20260914-030000.gcbk', Buffer.from('abc'));
    await webdav.upload(cfg(), 'a b&c.txt', Buffer.from('12345'));
    cols.add('/dav/gatecontrol/sub/');
    const list = await webdav.list(cfg());
    assert.deepEqual(list.map((f) => f.name).sort(), ['a b&c.txt', 'gatecontrol-20260914-030000.gcbk']);
    const f = list.find((x) => x.name === 'gatecontrol-20260914-030000.gcbk');
    assert.equal(f.size, 3);
    assert.equal(f.modified, '2026-09-14T03:00:00.000Z');
  });

  it('remove deletes; a missing file is fine', async () => {
    await webdav.remove(cfg(), 'a b&c.txt');
    assert.equal(files.has('/dav/gatecontrol/a b&c.txt'), false);
    await webdav.remove(cfg(), 'a b&c.txt');
  });

  it('wrong password → 401 with a hint', async () => {
    await assert.rejects(webdav.list({ ...cfg(), password: 'nope' }), (e) => e.code === 'TRANSPORT' && /401 \(check username\/password/.test(e.message));
  });

  it('missing parent folder → MKCOL 409 is reported', async () => {
    await assert.rejects(webdav.test({ ...cfg(), url: `${base}/dav/nope/deeper/` }), (e) => /MKCOL 409/.test(e.message));
  });

  it('parseMultistatus tolerates other prefixes / default namespace', () => {
    const r = webdav.parseMultistatus('<multistatus xmlns="DAV:"><response><href>/x/a.gcbk</href><propstat><prop><getcontentlength>7</getcontentlength></prop></propstat></response></multistatus>');
    assert.deepEqual(r, [{ href: '/x/a.gcbk', size: 7, modified: null, collection: false }]);
  });
});
