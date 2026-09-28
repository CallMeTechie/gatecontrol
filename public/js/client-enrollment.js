'use strict';

// "Set up Android app" modal (templates/aurora/partials/modals/client-enrollment.njk).
// window.openClientEnrollment({ peerId, userId, title }) issues a one-shot
// setup code via POST /api/v1/enrollment and shows it as QR + typeable code
// with a live countdown. Used by the peers page (peerId) and the users page
// (userId → the app creates a new peer on redeem).
(function () {
  var modal = document.getElementById('modal-client-enroll');
  if (!modal) return;

  var qrImg = document.getElementById('client-enroll-qr');
  var codeEl = document.getElementById('client-enroll-code');
  var expiryEl = document.getElementById('client-enroll-expiry');
  var countdownEl = document.getElementById('client-enroll-countdown');
  var errorEl = document.getElementById('client-enroll-error');
  var titleEl = document.getElementById('client-enroll-title');
  var regenBtn = document.getElementById('client-enroll-regenerate');
  var defaultTitle = titleEl.textContent;

  var target = null;
  var expiresAt = 0;
  var timer = null;

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.style.display = '';
  }

  function tick() {
    var left = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    if (left === 0) {
      clearInterval(timer);
      timer = null;
      qrImg.style.opacity = '0.2';
      codeEl.style.textDecoration = 'line-through';
      expiryEl.style.display = 'none';
      showError(modal.dataset.expired);
      return;
    }
    var m = Math.floor(left / 60);
    var s = left % 60;
    countdownEl.textContent = m + ':' + (s < 10 ? '0' : '') + s;
  }

  async function generate() {
    if (timer) { clearInterval(timer); timer = null; }
    errorEl.style.display = 'none';
    qrImg.style.opacity = '0.2';
    codeEl.style.textDecoration = '';
    codeEl.textContent = '…';
    expiryEl.style.display = 'none';
    regenBtn.disabled = true;
    try {
      var body = {};
      if (target.peerId != null) body.peerId = target.peerId;
      if (target.userId != null) body.userId = target.userId;
      var data = await api.post('/api/v1/enrollment', body);
      if (!data || !data.ok) {
        codeEl.textContent = '';
        showError((data && data.error) || modal.dataset.error);
        return;
      }
      qrImg.src = data.qr;
      qrImg.style.opacity = '1';
      codeEl.textContent = data.code;
      expiresAt = data.expiresAt;
      expiryEl.style.display = '';
      tick();
      timer = setInterval(tick, 1000);
    } catch (err) {
      codeEl.textContent = '';
      showError(modal.dataset.error + (err && err.message ? ': ' + err.message : ''));
    } finally {
      regenBtn.disabled = false;
    }
  }

  regenBtn.addEventListener('click', function () { if (target) generate(); });

  // Stop the countdown once the modal is closed (any close path).
  new MutationObserver(function () {
    if (modal.style.display === 'none' && timer) { clearInterval(timer); timer = null; }
  }).observe(modal, { attributes: true, attributeFilter: ['style'] });

  window.openClientEnrollment = function (opts) {
    target = opts || {};
    titleEl.textContent = target.title || defaultTitle;
    qrImg.removeAttribute('src');
    openModal('modal-client-enroll');
    generate();
  };
})();
