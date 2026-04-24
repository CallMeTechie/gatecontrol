'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  registerProcessErrorHandlers,
  createShutdownHandler,
} = require('../src/lifecycle');

function mockLogger() {
  const calls = { error: [], fatal: [], warn: [], info: [] };
  return {
    error: (...a) => calls.error.push(a),
    fatal: (...a) => calls.fatal.push(a),
    warn: (...a) => calls.warn.push(a),
    info: (...a) => calls.info.push(a),
    calls,
  };
}

describe('registerProcessErrorHandlers', () => {
  test('attaches a listener for unhandledRejection', () => {
    const before = process.listenerCount('unhandledRejection');
    const logger = mockLogger();
    registerProcessErrorHandlers(logger);
    assert.equal(process.listenerCount('unhandledRejection'), before + 1);
    // Cleanup: remove just the listener we added
    const listeners = process.listeners('unhandledRejection');
    process.removeListener('unhandledRejection', listeners[listeners.length - 1]);
  });

  test('unhandledRejection handler logs with error shape', () => {
    const logger = mockLogger();
    registerProcessErrorHandlers(logger);
    const listeners = process.listeners('unhandledRejection');
    const handler = listeners[listeners.length - 1];
    const err = new Error('boom');
    handler(err, Promise.resolve());
    assert.equal(logger.calls.error.length, 1);
    assert.equal(logger.calls.error[0][0].err.message, 'boom');
    assert.match(logger.calls.error[0][1], /Unhandled Promise rejection/);
    process.removeListener('unhandledRejection', handler);
  });

  test('unhandledRejection handler handles non-Error reasons', () => {
    const logger = mockLogger();
    registerProcessErrorHandlers(logger);
    const listeners = process.listeners('unhandledRejection');
    const handler = listeners[listeners.length - 1];
    handler('string-reason', Promise.resolve());
    assert.equal(logger.calls.error.length, 1);
    assert.equal(logger.calls.error[0][0].err, 'string-reason');
    process.removeListener('unhandledRejection', handler);
  });
});

describe('createShutdownHandler', () => {
  test('is idempotent — second call with same or different signal is ignored', () => {
    const logger = mockLogger();
    let closed = 0;
    const fakeServer = { close: (cb) => { closed++; cb(); }, closeIdleConnections: () => {} };
    const stop = () => {};
    let exited = false;
    const originalExit = process.exit;
    process.exit = () => { exited = true; };
    try {
      const shutdown = createShutdownHandler({
        server: fakeServer, stoppers: [stop], closeDb: () => {}, timeoutMs: 100, logger,
      });
      shutdown('SIGTERM');
      shutdown('SIGTERM');
      shutdown('SIGINT');
      assert.equal(closed, 1, 'server.close must be called exactly once');
      const warnMsgs = logger.calls.warn.map(a => a[0]);
      assert.ok(warnMsgs.some(m => /ignoring repeat signal/.test(m)), 'repeat-signal warning missing');
    } finally {
      process.exit = originalExit;
    }
  });

  test('runs stoppers, closes server, closes DB, calls exit(0)', async () => {
    const logger = mockLogger();
    let order = [];
    const fakeServer = {
      close: (cb) => { order.push('server.close'); cb(); },
      closeIdleConnections: () => { order.push('closeIdleConnections'); },
    };
    const stopper1 = () => order.push('stopper1');
    const stopper2 = () => order.push('stopper2');
    const closeDb = () => order.push('closeDb');
    const exits = [];
    const originalExit = process.exit;
    process.exit = (code) => { exits.push(code); };
    try {
      const shutdown = createShutdownHandler({
        server: fakeServer, stoppers: [stopper1, stopper2], closeDb, timeoutMs: 100, logger,
      });
      shutdown('SIGTERM');
      // yield to microtasks so server.close callback runs
      await new Promise(r => setImmediate(r));
      assert.deepEqual(order, ['stopper1', 'stopper2', 'server.close', 'closeDb', 'closeIdleConnections']);
      assert.deepEqual(exits, [0]);
    } finally {
      process.exit = originalExit;
    }
  });

  test('getServer is resolved lazily at shutdown-time (not factory-time)', async () => {
    const logger = mockLogger();
    let serverRef = null;
    const fakeServer = { close: (cb) => cb(), closeIdleConnections: () => {} };
    const originalExit = process.exit;
    let exited = false;
    process.exit = () => { exited = true; };
    try {
      const shutdown = createShutdownHandler({
        getServer: () => serverRef,
        stoppers: [],
        closeDb: () => {},
        timeoutMs: 100,
        logger,
      });
      // Factory already ran — now assign server (simulates HTTP listen starting late)
      serverRef = fakeServer;
      shutdown('SIGTERM');
      await new Promise(r => setImmediate(r));
      assert.ok(exited, 'shutdown must reach exit when server was assigned after factory');
    } finally {
      process.exit = originalExit;
    }
  });

  test('a stopper that throws does not abort shutdown', () => {
    const logger = mockLogger();
    let closedAndExited = false;
    const fakeServer = { close: (cb) => { cb(); } };
    const badStopper = () => { throw new Error('stopper boom'); };
    const goodStopper = () => {};
    const originalExit = process.exit;
    process.exit = () => { closedAndExited = true; };
    try {
      const shutdown = createShutdownHandler({
        server: fakeServer, stoppers: [badStopper, goodStopper], closeDb: () => {}, timeoutMs: 100, logger,
      });
      shutdown('SIGTERM');
      // stopper error should be logged, shutdown should still proceed
      assert.ok(logger.calls.warn.some(a => /stopper threw/.test(a[1] || '')));
      assert.ok(closedAndExited, 'shutdown must still reach exit even when a stopper throws');
    } finally {
      process.exit = originalExit;
    }
  });

  test('without server, runs stoppers + closeDb + exit directly', () => {
    const logger = mockLogger();
    let closedDb = false;
    let exited = false;
    const originalExit = process.exit;
    process.exit = () => { exited = true; };
    try {
      const shutdown = createShutdownHandler({
        server: null, stoppers: [], closeDb: () => { closedDb = true; }, timeoutMs: 100, logger,
      });
      shutdown('SIGINT');
      assert.ok(closedDb);
      assert.ok(exited);
    } finally {
      process.exit = originalExit;
    }
  });
});
