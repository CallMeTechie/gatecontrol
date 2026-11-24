'use strict';

// The old app API /api/v1/client/rdp* of the Android and Windows apps.
// The built-in Remote Desktops is gone: its devices live in the plugin
// "Fernzugriff" (gatecontrol-remote), which answers these endpoints through
// its hook clientFacade (services/remote/facade.js). Without the plugin —
// or for a request the plugin declines — the answer is `unavailable`:
// 403 "Remote Desktop feature not available" (code remote_plugin_required),
// the answer the apps always got from a server without the feature.
//
//   GET    /rdp                        list
//   GET    /rdp/:id/status             status
//   GET    /rdp/:id/connect            connect (credentials ECDH only)
//   POST   /rdp/:id/browser-session    browserSession (guacamole token)
//   POST   /rdp/:id/session            sessionStart
//   PATCH  /rdp/:id/session            sessionHeartbeat
//   DELETE /rdp/:id/session            sessionEnd

const { Router } = require('express');
const { middleware: facade, unavailable } = require('../../../services/remote/facade');

const router = Router();

router.get('/rdp', facade('list'), unavailable);
router.get('/rdp/:id/status', facade('status'), unavailable);
router.get('/rdp/:id/connect', facade('connect'), unavailable);
router.post('/rdp/:id/browser-session', facade('browserSession'), unavailable);
router.post('/rdp/:id/session', facade('sessionStart'), unavailable);
router.patch('/rdp/:id/session', facade('sessionHeartbeat'), unavailable);
router.delete('/rdp/:id/session', facade('sessionEnd'), unavailable);

module.exports = router;
