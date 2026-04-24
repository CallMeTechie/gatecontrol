'use strict';

// Process-lifecycle helpers extracted from server.js so they are
// testable in isolation. Two concerns live here:
//
//   1. Process-level error handlers — unhandledRejection and
//      uncaughtException. Without these, a single unhandled rejection
//      silently terminates the Node process (Node >= 15 default), which
//      in a long-running server means a mysterious restart loop with no
//      log entry. We log the failure with full stack and let
//      uncaughtException exit(1) since process state is corrupt after
//      an uncaught exception.
//
//   2. Graceful shutdown — stops background tasks, drains in-flight
//      HTTP requests, closes idle keepalive connections (otherwise
//      server.close() waits for idle clients up to shutdownTimeout),
//      and force-closes everything after the deadline. Idempotent:
//      a second SIGTERM during shutdown is logged and ignored, not
//      run again.

function registerProcessErrorHandlers(logger) {
  process.on('unhandledRejection', (reason, promise) => {
    logger.error({
      err: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason,
    }, 'Unhandled Promise rejection — investigate and fix');
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err: { message: err.message, stack: err.stack } },
      'Uncaught exception — exiting (process state may be corrupt)');
    // Exit intentionally — Node best practice: process state is corrupt
    // after an uncaught exception. Supervisord will restart.
    process.exit(1);
  });
}

function createShutdownHandler(opts) {
  // opts.server may be assigned AFTER the factory runs (the HTTP
  // listener is started inside an async start() that returns before
  // this handler is registered). Resolve it lazily inside shutdown().
  // Callers can pass either opts.server (a plain reference — looked up
  // each invocation) or opts.getServer (a function returning the server).
  const { stoppers = [], closeDb, timeoutMs, logger, getServer } = opts;
  let shuttingDown = false;

  return function shutdown(signal) {
    if (shuttingDown) {
      logger.warn(`${signal} received during shutdown; ignoring repeat signal`);
      return;
    }
    shuttingDown = true;
    logger.info(`${signal} received, shutting down gracefully`);

    for (const stop of stoppers) {
      try { stop(); } catch (err) {
        logger.warn({ err: err.message }, 'stopper threw during shutdown — continuing');
      }
    }

    const closeAndExit = () => {
      try { closeDb && closeDb(); } catch (err) {
        logger.warn({ err: err.message }, 'closeDb threw during shutdown — continuing');
      }
      logger.info('Shutdown complete');
      process.exit(0);
    };

    const server = typeof getServer === 'function' ? getServer() : opts.server;
    if (server) {
      server.close(closeAndExit);
      // Nudge idle HTTP/2 + keepalive sockets. Without this, server.close()
      // blocks until the shutdownTimeout because idle clients hold
      // connections open. Available in Node >= 18.
      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }
      // Hard deadline: force-close everything and exit even if some
      // requests are stuck.
      setTimeout(() => {
        logger.warn('Forcing shutdown after timeout — closing all remaining connections');
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        closeAndExit();
      }, timeoutMs);
    } else {
      closeAndExit();
    }
  };
}

module.exports = { registerProcessErrorHandlers, createShutdownHandler };
