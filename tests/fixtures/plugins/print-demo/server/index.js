'use strict';

// Server part of the print test plugin (tests/print_scan.test.js): gc.print
// through its admin API (/api/v1/plugins/print-demo/api/…).

async function attempt(fn) {
  try { return { ok: true, result: await fn() }; } catch (e) { return { ok: false, code: e.code || null, error: e.message }; }
}

module.exports = {
  async request(req, gc) {
    const b = req.body || {};
    const P = gc.print;
    switch (req.path) {
      case '/has': return { json: { ok: true, print: !!P } };
      case '/devices': return { json: await attempt(() => P.devices()) };
      case '/store': return { json: await attempt(async () => (await gc.media.info(b.mediaId))) };
      case '/submit': return { json: await attempt(() => P.submit(b)) };
      case '/test': return { json: await attempt(() => P.testPage(b)) };
      case '/jobs': return { json: await attempt(() => P.jobs(b)) };
      case '/cancel': return { json: await attempt(() => P.cancel(b.id)) };
      case '/pages': return { json: await attempt(() => P.pages(b)) };
      case '/scan': return { json: await attempt(() => P.scan(b)) };
      case '/scan-status': return { json: await attempt(() => P.scanStatus(b.id)) };
      case '/pdf': return { json: await attempt(() => P.pdf(b)) };
      default: return { status: 404, json: { ok: false } };
    }
  },
};
