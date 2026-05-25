'use strict';

const eventBus = require('../../services/eventBus');

const KEEPALIVE_MS = 25000;
const DRAIN_TIMEOUT_MS = 30000;

function sseHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let lagging = false;
  let drainTimer = null;
  let drainHandler = null;

  function cleanup() {
    eventBus.unsubscribe(listener);
    clearInterval(keepalive);
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
    if (drainHandler) { res.removeListener('drain', drainHandler); drainHandler = null; }
  }

  function send(evt) {
    if (lagging) return;
    let ok;
    try {
      ok = res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt.payload)}\n\n`);
    } catch {
      // socket destroyed mid-write (client vanished between checks) — tear down now
      cleanup();
      try { res.end(); } catch { /* already destroyed */ }
      return;
    }
    if (ok === false) {
      lagging = true;
      drainTimer = setTimeout(() => { cleanup(); res.end(); }, DRAIN_TIMEOUT_MS);
      drainHandler = () => {
        lagging = false;
        drainHandler = null;
        if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
      };
      res.once('drain', drainHandler);
    }
  }

  const listener = (evt) => send(evt);
  eventBus.subscribe(listener, () => true);

  const keepalive = setInterval(() => { if (lagging) return; res.write(': ping\n\n'); }, KEEPALIVE_MS);

  req.on('close', cleanup);
}

module.exports = sseHandler;
