'use strict';

// S3 transport (docs/feature-release-b.md §7): SigV4 against the published
// AWS examples, then upload/list/delete/test against a local fake S3 server
// that re-derives the signature from what actually arrived on the wire.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const s3 = require('../src/services/offsite/s3');
const gcbk = require('../src/services/offsite/gcbk');
const { archiveFile, downloadBuffer } = require('./helpers/offsiteFiles');

const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const sigOf = (h) => /Signature=([0-9a-f]{64})$/.exec(h.authorization)[1];

describe('SigV4 known-answer tests (AWS documentation)', () => {
  const s3Doc = {
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    date: new Date('2013-05-24T00:00:00Z'),
  };

  it('AWS SigV4 test suite: get-vanilla', () => {
    const h = s3.signRequest({
      method: 'GET', url: new URL('https://example.amazonaws.com/'), payloadHash: EMPTY,
      region: 'us-east-1', service: 'service', accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', date: new Date('2015-08-30T12:36:00Z'),
    });
    assert.equal(h.authorization,
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, '
      + 'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });

  it('S3: GET object with Range', () => {
    const h = s3.signRequest({
      ...s3Doc, method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY }, payloadHash: EMPTY,
    });
    assert.match(h.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
    assert.equal(sigOf(h), 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('S3: PUT object (key with $, extra headers)', () => {
    const body = 'Welcome to Amazon S3.';
    const hash = s3._sha256hex(body);
    assert.equal(hash, '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    const h = s3.signRequest({
      ...s3Doc, method: 'PUT', url: new URL(`https://examplebucket.s3.amazonaws.com/${s3.uriEncode('test$file.text', true)}`),
      headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY', 'x-amz-content-sha256': hash },
      payloadHash: hash,
    });
    assert.equal(sigOf(h), '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  it('S3: GET bucket lifecycle (query without value)', () => {
    const h = s3.signRequest({
      ...s3Doc, method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/?lifecycle'),
      headers: { 'x-amz-content-sha256': EMPTY }, payloadHash: EMPTY,
    });
    assert.equal(sigOf(h), 'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  });

  it('S3: list objects (sorted query parameters)', () => {
    const h = s3.signRequest({
      ...s3Doc, method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J'),
      headers: { 'x-amz-content-sha256': EMPTY }, payloadHash: EMPTY,
    });
    assert.equal(sigOf(h), '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });

  it('URL styles', () => {
    const cfg = { endpoint: 'https://s3.example.com:9000', bucket: 'bk', region: 'x' };
    assert.equal(s3.objectUrl({ ...cfg, path_style: true }, 'gc/a b.gcbk').toString(), 'https://s3.example.com:9000/bk/gc/a%20b.gcbk');
    assert.equal(s3.objectUrl({ ...cfg, path_style: false }, 'gc/a.gcbk').toString(), 'https://bk.s3.example.com:9000/gc/a.gcbk');
    assert.equal(s3.objectUrl({ bucket: 'bk', region: 'eu-central-1' }, 'k').host, 'bk.s3.eu-central-1.amazonaws.com');
    assert.equal(s3.objectUrl({ ...cfg, path_style: true }, '', { 'list-type': '2', prefix: 'a b+c/' }).search, '?list-type=2&prefix=a%20b%2Bc%2F');
  });
});

describe('fake S3 server', () => {
  const AK = 'AKTEST123';
  const SK = 'secret/key+test';
  const REGION = 'eu-test-1';
  const objects = new Map(); // key → Buffer
  const seen = [];
  const uploads = new Map(); // UploadId → { key, parts: Map(n → { etag, body }) }
  const fault = { part: 0, complete: false, aborted: [] };
  const bodies = []; // { method, url, length, chunked, got } of every request with a body
  let server;
  let cfg;

  function verify(req, body) {
    const auth = req.headers.authorization || '';
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(auth);
    if (!m || m[1] !== AK || m[3] !== REGION) return false;
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    if (req.headers['x-amz-content-sha256'] !== hash) return false;
    const date = req.headers['x-amz-date'];
    const d = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
    const headers = {};
    for (const name of m[4].split(';')) if (name !== 'host' && name !== 'x-amz-date') headers[name] = req.headers[name];
    const url = new URL(`http://${req.headers.host}${req.url}`);
    const h = s3.signRequest({ method: req.method, url, headers, payloadHash: hash, region: REGION, accessKeyId: AK, secretAccessKey: SK, date: d });
    return sigOf(h) === m[5];
  }

  const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

  before(async () => {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        seen.push(`${req.method} ${req.url}`);
        if (body.length) bodies.push({ method: req.method, url: req.url, length: req.headers['content-length'], chunked: !!req.headers['transfer-encoding'], got: body.length });
        if (!verify(req, body)) {
          res.writeHead(403, { 'content-type': 'application/xml' });
          res.end('<Error><Code>SignatureDoesNotMatch</Code><Message>bad sig</Message></Error>');
          return;
        }
        const url = new URL(`http://x${req.url}`);
        const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const bucket = parts.shift();
        if (bucket !== 'bk') { res.writeHead(404); res.end('<Error><Code>NoSuchBucket</Code></Error>'); return; }
        const key = parts.join('/');
        const uploadId = url.searchParams.get('uploadId');
        if (req.method === 'POST' && url.searchParams.has('uploads')) {
          const id = crypto.randomBytes(8).toString('hex');
          uploads.set(id, { key, parts: new Map() });
          res.writeHead(200, { 'content-type': 'application/xml' });
          res.end(`<?xml version="1.0"?><InitiateMultipartUploadResult><Bucket>bk</Bucket><Key>${xml(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
          return;
        }
        if (uploadId) {
          const u = uploads.get(uploadId);
          if (!u || u.key !== key) { res.writeHead(404); res.end('<Error><Code>NoSuchUpload</Code></Error>'); return; }
          if (req.method === 'PUT') {
            const n = Number(url.searchParams.get('partNumber'));
            if (fault.part === n) { res.writeHead(500); res.end('<Error><Code>InternalError</Code><Message>disk</Message></Error>'); return; }
            const etag = `"${crypto.createHash('md5').update(body).digest('hex')}"`;
            u.parts.set(n, { etag, body });
            res.writeHead(200, { etag }); res.end(); return;
          }
          if (req.method === 'POST') {
            const listed = [...body.toString('utf8').matchAll(/<Part><PartNumber>(\d+)<\/PartNumber><ETag>([^<]+)<\/ETag><\/Part>/g)]
              .map((m) => ({ n: Number(m[1]), etag: m[2].replace(/&quot;/g, '"') }));
            if (fault.complete || !listed.length || listed.some((p) => !u.parts.has(p.n) || u.parts.get(p.n).etag !== p.etag)) {
              res.writeHead(200, { 'content-type': 'application/xml' }); res.end('<?xml version="1.0"?><Error><Code>InvalidPart</Code><Message>late</Message></Error>'); return;
            }
            objects.set(key, Buffer.concat(listed.map((p) => u.parts.get(p.n).body)));
            uploads.delete(uploadId);
            res.writeHead(200, { 'content-type': 'application/xml' }); res.end('<CompleteMultipartUploadResult><ETag>"x-2"</ETag></CompleteMultipartUploadResult>'); return;
          }
          if (req.method === 'DELETE') { uploads.delete(uploadId); fault.aborted.push(uploadId); res.writeHead(204); res.end(); return; }
        }
        if (req.method === 'PUT') { objects.set(key, body); res.writeHead(200); res.end(); return; }
        if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); res.end(); return; }
        if (req.method === 'GET' && key && objects.has(key)) { res.writeHead(200); res.end(objects.get(key)); return; }
        if (req.method === 'GET' && !key && url.searchParams.get('list-type') === '2') {
          const prefix = url.searchParams.get('prefix') || '';
          const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
          const start = Number(url.searchParams.get('continuation-token') || 0);
          const page = all.slice(start, start + 2); // tiny pages → pagination exercised
          const more = start + 2 < all.length;
          res.writeHead(200, { 'content-type': 'application/xml' });
          res.end(`<?xml version="1.0"?><ListBucketResult><IsTruncated>${more}</IsTruncated>${
            page.map((k) => `<Contents><Key>${xml(k)}</Key><Size>${objects.get(k).length}</Size><LastModified>2026-09-14T03:00:00.000Z</LastModified></Contents>`).join('')
          }${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ''}</ListBucketResult>`);
          return;
        }
        res.writeHead(400); res.end();
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    cfg = { endpoint: `http://127.0.0.1:${server.address().port}`, region: REGION, bucket: 'bk', prefix: 'gc/backups', access_key_id: AK, secret_access_key: SK, path_style: true };
  });
  after(() => server.close());

  it('upload stores the object under the prefix', async () => {
    await s3.upload(cfg, 'gatecontrol-20260914-030000.gcbk', Buffer.from('archive-1'));
    assert.equal(objects.get('gc/backups/gatecontrol-20260914-030000.gcbk').toString(), 'archive-1');
  });

  it('list pages through continuation tokens and strips the prefix; subfolders ignored', async () => {
    for (const n of ['gatecontrol-20260913-030000.gcbk', 'gatecontrol-20260912-030000.gcbk', 'notes with space.txt']) {
      await s3.upload(cfg, n, Buffer.from(n));
    }
    objects.set('gc/backups/sub/x.gcbk', Buffer.from('x'));
    objects.set('other/y.gcbk', Buffer.from('y'));
    const files = await s3.list(cfg);
    assert.deepEqual(files.map((f) => f.name).sort(), [
      'gatecontrol-20260912-030000.gcbk', 'gatecontrol-20260913-030000.gcbk', 'gatecontrol-20260914-030000.gcbk', 'notes with space.txt',
    ]);
    assert.equal(files.find((f) => f.name === 'gatecontrol-20260914-030000.gcbk').size, 9);
    assert.ok(seen.filter((s) => s.includes('continuation-token')).length >= 1, 'second page requested');
  });

  it('delete removes the object', async () => {
    await s3.remove(cfg, 'notes with space.txt');
    assert.equal(objects.has('gc/backups/notes with space.txt'), false);
  });

  it('test() lists, writes and deletes a probe', async () => {
    const detail = await s3.test(cfg);
    assert.match(detail, /write \+ delete ok/);
    assert.ok(![...objects.keys()].some((k) => k.includes('write-test')), 'probe removed');
  });

  it('a wrong secret surfaces the S3 error code', async () => {
    await assert.rejects(s3.upload({ ...cfg, secret_access_key: 'nope' }, 'x.gcbk', Buffer.from('x')),
      (e) => e.code === 'TRANSPORT' && /403 SignatureDoesNotMatch: bad sig/.test(e.message));
  });

  it('an archive file up to the part size: one PUT streamed with Content-Length, signed with its SHA-256 (computed while writing, or read from the file)', async () => {
    const data = crypto.randomBytes(300 * 1024 + 5);
    bodies.length = 0;
    await s3.upload(cfg, 'file-1.gcbk', archiveFile(data));
    // the hash gcbk.writeBackupArchive computed (one part: the whole file)
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    await s3.upload(cfg, 'file-2.gcbk', archiveFile(data, { partSize: s3._limits.part, partHashes: [hash] }));
    assert.ok(objects.get('gc/backups/file-1.gcbk').equals(data));
    assert.ok(objects.get('gc/backups/file-2.gcbk').equals(data));
    assert.equal(bodies.length, 2);
    assert.ok(bodies.every((b) => b.method === 'PUT' && !b.chunked && Number(b.length) === data.length));
    // a wrong precomputed hash is what the server refuses: the hash really is the one sent
    await assert.rejects(s3.upload(cfg, 'file-3.gcbk', archiveFile(data, { partSize: s3._limits.part, partHashes: ['0'.repeat(64)] })), /403 SignatureDoesNotMatch/);
    assert.ok((await downloadBuffer(s3, cfg, 'file-1.gcbk')).equals(data));
  });

  describe('multipart (the part size lowered)', () => {
    const PART = 64 * 1024;
    let saved;
    before(() => { saved = s3._limits.part; s3._limits.part = PART; });
    after(() => { s3._limits.part = saved; });

    it('above the part size: parts read from the file one by one, each signed with its own SHA-256, then completed', async () => {
      const data = crypto.randomBytes(3 * PART + 17); // four parts, the last one short
      bodies.length = 0;
      seen.length = 0;
      await s3.upload(cfg, 'big.gcbk', archiveFile(data));
      assert.ok(objects.get('gc/backups/big.gcbk').equals(data));
      const partPuts = bodies.filter((b) => b.method === 'PUT' && /partNumber=/.test(b.url));
      assert.deepEqual(partPuts.map((b) => b.got), [PART, PART, PART, 17]);
      assert.ok(partPuts.every((b) => !b.chunked && Number(b.length) === b.got));
      assert.ok(seen.some((x) => /^POST .*\?uploads=$/.test(x)), 'initiated');
      assert.equal(uploads.size, 0, 'completed');
    });

    it('with the part hashes gcbk.writeBackupArchive computed while writing the archive', async () => {
      const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'gc-s3-parts-'));
      try {
        const json = require('node:path').join(dir, 'b.json');
        require('node:fs').writeFileSync(json, JSON.stringify({ version: 1, data: { blob: crypto.randomBytes(200 * 1024).toString('base64') } }));
        const out = require('node:path').join(dir, 'a.gcbk');
        const r = await gcbk.writeBackupArchive(json, out, { passphrase: 'a long passphrase', kdf: { N: 1024, r: 8, p: 1 }, partSize: PART });
        assert.ok(r.size > 3 * PART);
        assert.equal(r.partHashes.length, Math.ceil(r.size / PART));
        bodies.length = 0;
        await s3.upload(cfg, 'from-archive.gcbk', { path: out, ...r });
        assert.ok(objects.get('gc/backups/from-archive.gcbk').equals(require('node:fs').readFileSync(out)));
        assert.equal(bodies.filter((b) => /partNumber=/.test(b.url)).length, r.partHashes.length);
      } finally { require('node:fs').rmSync(dir, { recursive: true, force: true }); }
    });

    it('a failing part: the multipart upload is aborted, the error says what S3 said, no object', async () => {
      fault.part = 2;
      fault.aborted.length = 0;
      try {
        await assert.rejects(s3.upload(cfg, 'broken.gcbk', archiveFile(crypto.randomBytes(2 * PART + 1))),
          (e) => e.code === 'TRANSPORT' && /S3 PUT 500 InternalError: disk/.test(e.message));
      } finally { fault.part = 0; }
      assert.equal(fault.aborted.length, 1);
      assert.equal(uploads.size, 0);
      assert.equal(objects.has('gc/backups/broken.gcbk'), false);
    });

    it('completing fails late (200 with an <Error> body): aborted too', async () => {
      fault.complete = true;
      fault.aborted.length = 0;
      try {
        await assert.rejects(s3.upload(cfg, 'late.gcbk', archiveFile(crypto.randomBytes(PART + 1))), /InvalidPart/);
      } finally { fault.complete = false; }
      assert.equal(fault.aborted.length, 1);
      assert.equal(objects.has('gc/backups/late.gcbk'), false);
    });

    it('a Buffer (the write probe) still goes up as one PUT', async () => {
      await s3.upload(cfg, 'probe.bin', crypto.randomBytes(PART * 2));
      assert.equal(objects.get('gc/backups/probe.bin').length, PART * 2);
    });
  });

  it('downloadTo: into a file, limited', async () => {
    objects.set('gc/backups/dl.gcbk', crypto.randomBytes(5000));
    assert.ok((await downloadBuffer(s3, cfg, 'dl.gcbk')).equals(objects.get('gc/backups/dl.gcbk')));
    await assert.rejects(downloadBuffer(s3, cfg, 'dl.gcbk', undefined, { maxBytes: 4000 }), { code: 'TOO_LARGE' });
  });

  it('unreachable endpoint → TRANSPORT error', async () => {
    await assert.rejects(s3.list({ ...cfg, endpoint: 'http://127.0.0.1:1' }), { code: 'TRANSPORT' });
  });
});
