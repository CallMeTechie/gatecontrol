/* global GCRdpPlayerLogic, Guacamole */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GCRdpPlayer = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* helpers                                                              */
  /* ------------------------------------------------------------------ */

  function logic() {
    if (typeof GCRdpPlayerLogic !== 'undefined') return GCRdpPlayerLogic;
    throw new Error('GCRdpPlayer: GCRdpPlayerLogic must be loaded before rdp-player.js');
  }

  function guacCfg() {
    try {
      return (typeof window !== 'undefined' && window.GC && window.GC.guac)
        ? window.GC.guac : {};
    } catch (e) { return {}; }
  }

  /* ------------------------------------------------------------------ */
  /* factory                                                              */
  /* ------------------------------------------------------------------ */

  function create(opts) {
    var container   = opts.container;
    var wsBase      = opts.wsBase;
    var mint        = opts.mint;
    var onStateCb   = opts.onState || function () {};

    /* ---- mutable player state ---- */
    var currentState       = 'idle';
    var activeClient       = null;   // current Guacamole.Client
    var activeDisplayEl    = null;   // current display DOM element
    var activeProtocol     = null;   // 'rdp' | 'vnc' | …
    var sharedKeyboard     = null;   // one Guacamole.Keyboard for the player lifetime
    var established        = false;  // ever reached 'connected' in this session
    var userDisconnected   = false;
    var reconnectTimer     = null;
    var reconnectAttempt   = 0;
    var reconnectWindowStart = null;

    /* ---- beforeunload ---- */
    var beforeunloadHandler = function () { disconnect(); }; // eslint-disable-line no-use-before-define
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', beforeunloadHandler);
    }

    /* ================================================================ */
    /* state machine helpers                                             */
    /* ================================================================ */

    function emitState(newState, detail) {
      currentState = newState;
      try { onStateCb(newState, detail || {}); } catch (e) {}
    }

    function transition(event, detail) {
      var next = logic().nextState(currentState, event);
      if (next !== currentState) emitState(next, detail);
      return next;
    }

    /* ================================================================ */
    /* timer / cleanup helpers                                           */
    /* ================================================================ */

    function clearTimer() {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    }

    function removeDisplayEl() {
      if (activeDisplayEl && activeDisplayEl.parentNode) {
        activeDisplayEl.parentNode.removeChild(activeDisplayEl);
      }
      activeDisplayEl = null;
    }

    /* ================================================================ */
    /* reconnect scheduling                                             */
    /* ================================================================ */

    /**
     * Schedules the next performConnect() call with exponential back-off.
     * Guards the retry window — terminates the loop if exceeded.
     */
    function scheduleReconnect() {
      if (userDisconnected) return;
      clearTimer();
      var lg = logic();

      /* window guard */
      if (reconnectWindowStart !== null) {
        var windowMs = lg.retryWindowMs(guacCfg());
        if (Date.now() - reconnectWindowStart > windowMs) {
          transition('fatal', { reason: 'limit-reached' });
          return;
        }
      }

      var delay = lg.backoffMs(reconnectAttempt);
      reconnectAttempt++;

      reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        if (!userDisconnected) performConnect(); // eslint-disable-line no-use-before-define
      }, delay);
    }

    /* ================================================================ */
    /* connection core                                                   */
    /* ================================================================ */

    /**
     * Mint a token and open a Guacamole session.
     * Handles its own success/failure and wires the reconnect loop.
     */
    function performConnect() {

      mint().then(function (result) {
        if (userDisconnected) return;

        var token    = result.token;
        var wsPath   = result.wsPath;
        var protocol = result.protocol;
        activeProtocol = protocol;

        var tunnelUrl = wsBase + wsPath + '?token=' + encodeURIComponent(token);
        var tunnel    = new Guacamole.WebSocketTunnel(tunnelUrl);
        var client    = new Guacamole.Client(tunnel);
        activeClient  = client;

        /* append display element */
        var displayEl   = client.getDisplay().getElement();
        activeDisplayEl = displayEl;
        container.appendChild(displayEl);

        /* ---- Mouse (per-connection — new element each time) ---- */
        var mouse = new Guacamole.Mouse(displayEl);
        mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = function (ms) {
          if (activeClient) activeClient.sendMouseState(ms);
        };

        /* ---- Keyboard (shared across reconnects to avoid stale listeners) ---- */
        if (!sharedKeyboard) {
          sharedKeyboard = new Guacamole.Keyboard(document);
          sharedKeyboard.onkeydown = function (keysym) {
            if (activeClient) activeClient.sendKeyEvent(1, keysym);
          };
          sharedKeyboard.onkeyup = function (keysym) {
            if (activeClient) activeClient.sendKeyEvent(0, keysym);
          };
        }

        /* ---- Remote → local clipboard (best-effort, no background poll) ---- */
        client.onclipboard = function (stream, mimetype) {
          if (mimetype !== 'text/plain') {
            /* Signal guacd we cannot handle this stream */
            if (stream.sendAck) stream.sendAck('Unsupported', Guacamole.Status.Code.UNSUPPORTED);
            return;
          }
          var reader = new Guacamole.StringReader(stream);
          var buf = '';
          reader.ontext = function (text) { buf += text; };
          reader.onend = function () {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(buf).catch(function () {});
            }
          };
        };

        /* ---- per-connection drop guard (tunnel.onerror + onstatechange can both fire) ---- */
        var dropped = false;

        function handleUnintendedDrop(detail) {
          if (dropped || userDisconnected) return;
          dropped = true;
          removeDisplayEl();
          if (reconnectWindowStart === null) reconnectWindowStart = Date.now();
          transition('drop', detail);
          scheduleReconnect();
        }

        /* ---- Guacamole client state changes ---- */
        client.onstatechange = function (s) {
          if (s === Guacamole.Client.State.CONNECTED) {
            established       = true;
            reconnectAttempt  = 0;
            reconnectWindowStart = null;
            transition('open');
          } else if (s === Guacamole.Client.State.DISCONNECTED) {
            if (!userDisconnected) {
              handleUnintendedDrop({ reason: 'client-disconnected' });
            }
          }
        };

        /* ---- Tunnel error → treat as unintended drop ---- */
        tunnel.onerror = function (status) {
          handleUnintendedDrop({ reason: 'tunnel-error', status: status });
        };

        client.connect();

      }).catch(function (err) {
        if (userDisconnected) return;

        var status = err && err.status;
        var phase  = established ? 'reconnect' : 'initial';
        var cls    = logic().classifyMintFailure({ status: status, phase: phase });

        if (cls === 'fatal') {
          transition('fatal', { reason: 'mint-failure', status: status });
          return;
        }

        /* 'retry' — honour the retry window */
        if (reconnectWindowStart === null) reconnectWindowStart = Date.now();
        var windowMs = logic().retryWindowMs(guacCfg());
        if (Date.now() - reconnectWindowStart > windowMs) {
          transition('fatal', { reason: 'limit-reached' });
          return;
        }

        transition('drop', { reason: 'mint-failure', status: status });
        scheduleReconnect();
      });
    }

    /* ================================================================ */
    /* public API                                                        */
    /* ================================================================ */

    /**
     * Open a new Guacamole session (or re-open after disconnect/error).
     */
    function connect() {
      if (currentState === 'connecting' ||
          currentState === 'connected'  ||
          currentState === 'reconnecting') return;

      userDisconnected     = false;
      established          = false;
      reconnectAttempt     = 0;
      reconnectWindowStart = null;
      clearTimer();

      /* re-register beforeunload idempotently so reconnect still frees the guacd slot */
      if (typeof window !== 'undefined' && beforeunloadHandler) {
        window.removeEventListener('beforeunload', beforeunloadHandler);
        window.addEventListener('beforeunload', beforeunloadHandler);
      }

      transition('connect');
      performConnect();
    }

    /**
     * Intentionally close the session.  Idempotent.
     */
    function disconnect() {
      if (userDisconnected) return;
      userDisconnected = true;

      /* remove beforeunload handler (already disconnecting) */
      if (typeof window !== 'undefined') {
        window.removeEventListener('beforeunload', beforeunloadHandler);
      }

      clearTimer();

      if (activeClient) {
        try { activeClient.disconnect(); } catch (e) {}
        activeClient = null;
      }

      if (sharedKeyboard) {
        sharedKeyboard.onkeydown = null;
        sharedKeyboard.onkeyup   = null;
        if (typeof sharedKeyboard.reset === 'function') sharedKeyboard.reset();
        sharedKeyboard = null;
      }

      removeDisplayEl();
      emitState('disconnected');
    }

    /**
     * Scale the Guacamole display.
     * @param {string} mode  'fit' | 'native'
     */
    function setScale(mode) {
      if (!activeClient) return;
      var scaleMode = logic().scaleFor(mode, { protocol: activeProtocol });
      var display   = activeClient.getDisplay();
      if (scaleMode === 'native') {
        display.scale(1);
      } else {
        /* 'fit' — shrink/expand to fill container while preserving aspect ratio */
        var cw = container.offsetWidth;
        var ch = container.offsetHeight;
        var dw = display.getWidth();
        var dh = display.getHeight();
        if (dw > 0 && dh > 0) {
          display.scale(Math.min(cw / dw, ch / dh));
        }
      }
    }

    /** Enter browser fullscreen on the player container. */
    function requestFullscreen() {
      var fn = container.requestFullscreen       ||
               container.webkitRequestFullscreen ||
               container.mozRequestFullScreen    ||
               container.msRequestFullscreen;
      if (fn) fn.call(container);
    }

    /**
     * Send the Ctrl+Alt+Del key sequence to the remote desktop.
     * Keysyms: Ctrl 0xFFE3, Alt 0xFFE9, Delete 0xFFFF.
     */
    function sendCtrlAltDel() {
      if (!activeClient) return;
      activeClient.sendKeyEvent(1, 0xFFE3); /* Ctrl down   */
      activeClient.sendKeyEvent(1, 0xFFE9); /* Alt down    */
      activeClient.sendKeyEvent(1, 0xFFFF); /* Delete down */
      activeClient.sendKeyEvent(0, 0xFFFF); /* Delete up   */
      activeClient.sendKeyEvent(0, 0xFFE9); /* Alt up      */
      activeClient.sendKeyEvent(0, 0xFFE3); /* Ctrl up     */
    }

    /** Return the current state string. */
    function getState() {
      return currentState;
    }

    /**
     * Paste the local clipboard to the remote desktop.
     * MUST be called inside a user gesture (e.g. Paste button click).
     * Degrades gracefully if Clipboard API is unavailable or permission denied.
     * @returns {Promise<void>}
     */
    function paste() {
      if (!activeClient) return Promise.resolve();
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        emitState(currentState, { clipboardUnavailable: true });
        return Promise.resolve();
      }
      return navigator.clipboard.readText().then(function (text) {
        if (!activeClient) return;
        var stream = activeClient.createClipboardStream('text/plain');
        var writer = new Guacamole.StringWriter(stream);
        writer.sendText(text);
        writer.sendEnd();
      }).catch(function () {
        emitState(currentState, { clipboardUnavailable: true });
      });
    }

    return {
      connect:          connect,
      disconnect:       disconnect,
      setScale:         setScale,
      requestFullscreen: requestFullscreen,
      sendCtrlAltDel:   sendCtrlAltDel,
      getState:         getState,
      paste:            paste,
    };
  }

  return { create: create };
}));
