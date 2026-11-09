'use strict';

// Peak memory of an off-site upload stays bounded, whatever the size of the
// archive: it is written to a file and sent from read streams (WebDAV PUT,
// S3 multipart), never held as one Buffer. scripts/offsite-memory-check.js
// does the measuring in its own process (RSS sampled every 10 ms during build
// + uploads); up to 1.258.1 the archive alone added its full size.

require('./helpers/test-env');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');

function check(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(__dirname, '..', 'scripts', 'offsite-memory-check.js'), ...args],
      { timeout: 240000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) { reject(new Error(`${err.message}\n${stderr}`)); return; }
        resolve(JSON.parse(stdout.trim().split('\n').pop()));
      });
  });
}

describe('off-site upload memory', () => {
  it('an archive of ~160 MB goes up (WebDAV + S3 multipart) with far less extra memory than its size', { timeout: 300000 }, async () => {
    const r = await check(['--mb', '160', '--part-mb', '16']);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.archive_mb > 150, JSON.stringify(r));
    // measured ~45 MB for 50 … 800 MB archives (V8/zlib working memory, not the archive)
    assert.ok(r.extra_mb < 100, `extra RSS ${r.extra_mb} MB for a ${r.archive_mb} MB archive: ${JSON.stringify(r)}`);
  });
});
