'use strict';

// The former admin API of the built-in Remote Desktops (/api/v1/rdp). The
// feature is the plugin "Fernzugriff" (gatecontrol-remote) now; its admin API
// lives under /api/v1/plugins/<id>/api. What is left here:
//
//   * the four calls the Windows app makes with its token (wake-on-LAN and
//     status), answered by the plugin's hook clientFacade
//     (services/remote/facade.js: wake, statusAdmin, statusAll) — without the
//     plugin 403 remote_plugin_required, the answer of a server without the
//     feature;
//   * everything else: 410 moved_to_plugin, like the other former built-in
//     integrations (routes/api/index.js).

const { Router } = require('express');
const { middleware: facade, unavailable, DATASET_PLUGIN } = require('../../services/remote/facade');

const router = Router();

// app tokens only (the facade passes a browser session on to the 410 below)
const appOnly = (req, res, next) => (req.tokenAuth ? unavailable(req, res) : next());
router.get('/status', facade('statusAll'), appOnly);
router.post('/:id/wol', facade('wake'), appOnly);
router.get('/:id/wol/status', facade('statusAdmin'), appOnly);
router.get('/:id/status', facade('statusAdmin'), appOnly);

router.use((req, res) => res.status(410).json({ ok: false, code: 'moved_to_plugin', plugin: DATASET_PLUGIN }));

module.exports = router;
