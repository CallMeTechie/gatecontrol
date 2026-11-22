'use strict';

// The upload of a gateway's speed test ends mid-body after its 10 s (gatecontrol-gateway
// src/inetq/speedtest.js); Caddy logs that as 499 or 502 with size 0. It is the end of a
// measurement: info in the logs, no problem (services/accessLog.js speedtestCut).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { speedtestCut } = require('../src/services/accessLog');
const logEvents = require('../src/services/logEvents');
const logProblems = require('../src/services/logProblems');

const UP = '/api/v1/gateway/speedtest/up';
function entry(method, uri, status) {
  return { ts: 1, hash: 'abc', status, method, host: 'gc.example.test', uri, remote_ip: '198.51.100.7', proto: 'HTTP/1.1', user_agent: '', duration: 3400, size: 0 };
}

describe('speed test upload ended by the gateway', () => {
  it('only POST …/speedtest/up with 499 or 502', () => {
    assert.equal(speedtestCut('POST', UP, 499), true);
    assert.equal(speedtestCut('POST', UP, 502), true);
    assert.equal(speedtestCut('POST', UP + '?x=1', 499), true);
    assert.equal(speedtestCut('POST', UP, 500), false);
    assert.equal(speedtestCut('POST', UP, 504), false);
    assert.equal(speedtestCut('POST', UP, 413), false);
    assert.equal(speedtestCut('GET', '/api/v1/gateway/speedtest/down', 499), false);
    assert.equal(speedtestCut('POST', '/api/v1/gateway/inetq', 502), false);
    assert.equal(speedtestCut('POST', UP + 'x', 499), false);
  });

  it('logs: info without an error code, every other 4xx / 5xx as before', () => {
    for (const s of [499, 502]) {
      const e = logEvents.fromAccess(entry('POST', UP, s));
      assert.deepEqual([e.level, e.code], ['info', null], String(s));
      assert.equal(logProblems.keyOf(e), null, 'no problem');
    }
    const other = logEvents.fromAccess(entry('POST', '/api/v1/gateway/inetq', 502));
    assert.deepEqual([other.level, other.code], ['error', 'http_502']);
    assert.equal(logProblems.keyOf(other), 'h:502:gc.example.test');
    assert.equal(logEvents.fromAccess(entry('GET', '/x', 499)).level, 'warn');
  });
});
