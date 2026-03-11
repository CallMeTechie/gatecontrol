'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Set up test log file
const testLogDir = path.join(__dirname, 'tmp-access-logs');
const testLogFile = path.join(testLogDir, 'access.log');

process.env.GC_CADDY_DATA_DIR = testLogDir;
delete require.cache[require.resolve('../config/default')];

// Sample Caddy JSON log entries
const sampleEntries = [
  { ts: 1710000000, request: { method: 'GET', host: 'example.com', uri: '/', remote_ip: '1.2.3.4', proto: 'HTTP/2.0', headers: { 'User-Agent': ['Mozilla/5.0'] } }, status: 200, duration: 0.015, size: 4096 },
  { ts: 1710000010, request: { method: 'POST', host: 'example.com', uri: '/api/data', remote_ip: '5.6.7.8', proto: 'HTTP/2.0', headers: {} }, status: 201, duration: 0.045, size: 128 },
  { ts: 1710000020, request: { method: 'GET', host: 'nas.example.com', uri: '/dashboard', remote_ip: '1.2.3.4', proto: 'HTTP/3.0', headers: {} }, status: 200, duration: 0.008, size: 8192 },
  { ts: 1710000030, request: { method: 'GET', host: 'example.com', uri: '/missing', remote_ip: '9.9.9.9', proto: 'HTTP/2.0', headers: {} }, status: 404, duration: 0.002, size: 150 },
  { ts: 1710000040, request: { method: 'GET', host: 'nas.example.com', uri: '/error', remote_ip: '1.2.3.4', proto: 'HTTP/2.0', headers: {} }, status: 502, duration: 0.001, size: 0 },
];

before(() => {
  fs.mkdirSync(testLogDir, { recursive: true });
  const lines = sampleEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(testLogFile, lines);
});

after(() => {
  fs.rmSync(testLogDir, { recursive: true, force: true });
});

// Require after env setup
const accessLog = require('../src/services/accessLog');

describe('accessLog.getRecent', () => {
  it('returns all entries newest-first', async () => {
    const result = await accessLog.getRecent(50, {});
    assert.equal(result.entries.length, 5);
    assert.equal(result.total, 5);
    // Newest first (ts: 1710000040 should be first)
    assert.equal(result.entries[0].status, 502);
    assert.equal(result.entries[4].status, 200);
  });

  it('maps fields correctly', async () => {
    const result = await accessLog.getRecent(1, {});
    const entry = result.entries[0];
    assert.equal(entry.method, 'GET');
    assert.equal(entry.host, 'nas.example.com');
    assert.equal(entry.uri, '/error');
    assert.equal(entry.status, 502);
    assert.equal(entry.remote_ip, '1.2.3.4');
    assert.equal(entry.duration, 1); // 0.001s = 1ms
    assert.ok(entry.timestamp); // ISO string
  });

  it('filters by domain', async () => {
    const result = await accessLog.getRecent(50, { domain: 'nas' });
    assert.equal(result.total, 2);
    result.entries.forEach(e => assert.ok(e.host.includes('nas')));
  });

  it('filters by status class', async () => {
    const result = await accessLog.getRecent(50, { status: '200' });
    assert.equal(result.total, 3); // three 2xx entries
    result.entries.forEach(e => assert.ok(e.status >= 200 && e.status < 300));
  });

  it('filters by 4xx status', async () => {
    const result = await accessLog.getRecent(50, { status: '400' });
    assert.equal(result.total, 1);
    assert.equal(result.entries[0].status, 404);
  });

  it('filters by 5xx status', async () => {
    const result = await accessLog.getRecent(50, { status: '500' });
    assert.equal(result.total, 1);
    assert.equal(result.entries[0].status, 502);
  });

  it('filters by HTTP method', async () => {
    const result = await accessLog.getRecent(50, { method: 'POST' });
    assert.equal(result.total, 1);
    assert.equal(result.entries[0].method, 'POST');
  });

  it('paginates correctly', async () => {
    const page1 = await accessLog.getRecent(2, { page: 1 });
    assert.equal(page1.entries.length, 2);
    assert.equal(page1.page, 1);
    assert.equal(page1.totalPages, 3);

    const page2 = await accessLog.getRecent(2, { page: 2 });
    assert.equal(page2.entries.length, 2);
    assert.equal(page2.page, 2);

    const page3 = await accessLog.getRecent(2, { page: 3 });
    assert.equal(page3.entries.length, 1);
  });

  it('handles missing log file gracefully', async () => {
    // Temporarily rename log file
    fs.renameSync(testLogFile, testLogFile + '.bak');
    const result = await accessLog.getRecent(50, {});
    assert.equal(result.entries.length, 0);
    assert.equal(result.total, 0);
    fs.renameSync(testLogFile + '.bak', testLogFile);
  });

  it('skips malformed JSON lines', async () => {
    const original = fs.readFileSync(testLogFile, 'utf8');
    fs.writeFileSync(testLogFile, 'not-json\n' + original);
    const result = await accessLog.getRecent(50, {});
    assert.equal(result.total, 5); // malformed line skipped
    // Restore
    fs.writeFileSync(testLogFile, original);
  });
});
