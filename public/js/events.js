// public/js/events.js
(function () {
  'use strict';
  var BACKOFF = [1000, 2000, 5000, 15000];
  var PROBE_AFTER = 3;
  var failures = 0, es = null, stopped = false;

  function backoff() {
    return BACKOFF[Math.min(failures, BACKOFF.length - 1)] + Math.floor(Math.random() * 1000);
  }
  function dispatch(type, payload) {
    document.dispatchEvent(new CustomEvent('gc:' + type, { detail: payload }));
  }
  function connect() {
    if (stopped || !window.EventSource) return;
    es = new EventSource('/api/v1/events');
    ['gateway', 'peer', 'activity', 'monitor', 'gateway_discovery'].forEach(function (t) {
      es.addEventListener(t, function (e) {
        try { dispatch(t, JSON.parse(e.data)); } catch (_) {}
      });
    });
    es.onopen = function () {
      failures = 0;
      document.dispatchEvent(new CustomEvent('gc:reconnected'));
    };
    es.onerror = function () {
      es.close();
      failures++;
      if (failures >= PROBE_AFTER) {
        fetch('/api/v1/ping', { credentials: 'same-origin' })
          .then(function (r) {
            if (r.status === 401) { stopped = true; window.location = '/login'; return; }
            setTimeout(connect, backoff());
          })
          .catch(function () { setTimeout(connect, backoff()); });
      } else {
        setTimeout(connect, backoff());
      }
    };
  }
  connect();
})();
