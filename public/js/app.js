'use strict';

// ─── Toggle switches ────────────────────────────────────
document.querySelectorAll('.toggle').forEach(t => {
  if (t.dataset.managed) return; // Skip toggles managed by specific JS (e.g. route auth)
  // Accessibility: add ARIA attributes and keyboard support
  if (!t.getAttribute('role')) t.setAttribute('role', 'switch');
  if (!t.getAttribute('tabindex')) t.setAttribute('tabindex', '0');
  t.setAttribute('aria-checked', t.classList.contains('on') ? 'true' : 'false');
  t.addEventListener('click', () => {
    t.classList.toggle('on');
    t.setAttribute('aria-checked', t.classList.contains('on') ? 'true' : 'false');
  });
  t.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      t.click();
    }
  });
});

// ─── Tab switching ──────────────────────────────────────
document.querySelectorAll('.tabs').forEach(tabs => {
  tabs.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
    });
  });
});

// ─── API helper ─────────────────────────────────────────
function handleCsrfRotation(data) {
  if (data && data.csrfToken) {
    window.GC.csrfToken = data.csrfToken;
  }
  return data;
}

function apiUrl(url) {
  // Rewrite /api/ to /api/v1/ for all API calls
  if (url.startsWith('/api/') && !url.startsWith('/api/v1/')) {
    return '/api/v1/' + url.slice(5);
  }
  return url;
}

window.api = {
  async get(url) {
    url = apiUrl(url);
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    try { return await res.json(); } catch { throw new Error('Invalid response from server'); }
  },

  async post(url, data) {
    url = apiUrl(url);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-CSRF-Token': window.GC.csrfToken,
      },
      body: JSON.stringify(data),
    });
    // Return 400 validation errors as data (with ok: false + fields) instead of throwing
    if (res.status === 400) {
      try { return await res.json().then(handleCsrfRotation); } catch { throw new Error('Invalid response from server'); }
    }
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    try { return await res.json().then(handleCsrfRotation); } catch { throw new Error('Invalid response from server'); }
  },

  async put(url, data) {
    url = apiUrl(url);
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-CSRF-Token': window.GC.csrfToken,
      },
      body: JSON.stringify(data),
    });
    if (res.status === 400) {
      try { return await res.json().then(handleCsrfRotation); } catch { throw new Error('Invalid response from server'); }
    }
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    try { return await res.json().then(handleCsrfRotation); } catch { throw new Error('Invalid response from server'); }
  },

  async del(url) {
    url = apiUrl(url);
    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Accept': 'application/json',
        'X-CSRF-Token': window.GC.csrfToken,
      },
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    try { return await res.json().then(handleCsrfRotation); } catch { throw new Error('Invalid response from server'); }
  },
};

// ─── Bytes formatter ────────────────────────────────────
window.formatBytes = function(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(bytes);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
};

// ─── Flash auto-dismiss ─────────────────────────────────
document.querySelectorAll('.flash').forEach(el => {
  setTimeout(() => {
    el.style.transition = 'opacity 0.3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 5000);
});

// ─── Language switcher (topbar) ─────────────────────────
(function() {
  var langSwitcher = document.getElementById('lang-switcher');
  if (langSwitcher) {
    langSwitcher.addEventListener('click', async function(e) {
      var btn = e.target.closest('[data-lang]');
      if (!btn || btn.classList.contains('active')) return;
      try {
        await api.post('/api/settings/language', { language: btn.dataset.lang });
        window.location.reload();
      } catch(err) { console.error('Language switch failed:', err); }
    });
  }
})();

// ─── Profile dropdown ───────────────────────────────────
(function() {
  var profile = document.getElementById('topbar-profile');
  var dropdown = document.getElementById('topbar-dropdown');
  if (!profile || !dropdown) return;

  profile.querySelector('.topbar-avatar').addEventListener('click', function(e) {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  });

  document.addEventListener('click', function(e) {
    if (!profile.contains(e.target)) dropdown.classList.remove('open');
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') dropdown.classList.remove('open');
  });
})();

// ─── Button loading states ──────────────────────────────
window.btnLoading = function(btn) {
  if (!btn) return;
  btn._origText = btn.textContent;
  btn.classList.add('is-loading');
  btn.disabled = true;
};
window.btnReset = function(btn) {
  if (!btn) return;
  btn.classList.remove('is-loading');
  btn.disabled = false;
  if (btn._origText) btn.textContent = btn._origText;
};

// ─── Modal system (global) ──────────────────────────────
(function() {
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  var previousFocus = null;

  window.openModal = function(id) {
    var overlay = document.getElementById(id);
    if (!overlay) return;
    previousFocus = document.activeElement;
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    // Focus first focusable element inside modal
    var modal = overlay.querySelector('.modal');
    if (modal) {
      var first = modal.querySelector(FOCUSABLE);
      if (first) first.focus();
    }
  };

  window.closeModal = function(id) {
    var overlay = document.getElementById(id);
    if (!overlay) return;
    overlay.style.display = 'none';
    document.body.style.overflow = '';
    if (previousFocus) {
      previousFocus.focus();
      previousFocus = null;
    }
  };

  // Close on close button only (not overlay click)
  document.addEventListener('click', function(e) {
    if (e.target.closest('[data-close-modal]')) {
      var overlay = e.target.closest('.modal-overlay');
      if (overlay) {
        overlay.style.display = 'none';
        document.body.style.overflow = '';
        if (previousFocus) { previousFocus.focus(); previousFocus = null; }
      }
    }
  });

  // Escape key + focus trap (Tab/Shift+Tab)
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay').forEach(function(m) { m.style.display = 'none'; });
      document.body.style.overflow = '';
      if (previousFocus) { previousFocus.focus(); previousFocus = null; }
      return;
    }

    if (e.key !== 'Tab') return;

    // Find the currently visible modal
    var active = null;
    document.querySelectorAll('.modal-overlay').forEach(function(m) {
      if (m.style.display === 'flex') active = m;
    });
    if (!active) return;

    var modal = active.querySelector('.modal');
    if (!modal) return;

    var focusable = Array.from(modal.querySelectorAll(FOCUSABLE));
    if (focusable.length === 0) return;

    var first = focusable[0];
    var last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
})();

// ─── Shared escapeHtml ──────────────────────────────────
window.escapeHtml = function(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g, '&#039;');
};

// ─── Shared error helpers ───────────────────────────────
window.showError = function(containerId, message) {
  const el = document.getElementById(containerId);
  if (el) { el.textContent = message; el.style.display = 'block'; }
};
window.hideError = function(containerId) {
  const el = document.getElementById(containerId);
  if (el) { el.textContent = ''; el.style.display = 'none'; }
};

/**
 * Show field-level validation errors under input fields.
 * @param {Object} fields - { fieldName: "error message" }
 * @param {Object} fieldMap - { fieldName: "input-element-id" }
 */
window.showFieldErrors = function(fields, fieldMap) {
  // Clear previous field errors
  document.querySelectorAll('.field-error').forEach(function(el) { el.remove(); });
  document.querySelectorAll('.field-invalid').forEach(function(el) { el.classList.remove('field-invalid'); });

  if (!fields || !fieldMap) return;
  var firstInput = null;
  for (var field in fields) {
    var inputId = fieldMap[field];
    if (!inputId) continue;
    var input = document.getElementById(inputId);
    if (!input) continue;
    input.classList.add('field-invalid');
    var errEl = document.createElement('div');
    errEl.className = 'field-error';
    errEl.textContent = fields[field];
    input.parentNode.insertBefore(errEl, input.nextSibling);
    if (!firstInput) firstInput = input;
  }
  if (firstInput) firstInput.focus();
};

window.clearFieldErrors = function() {
  document.querySelectorAll('.field-error').forEach(function(el) { el.remove(); });
  document.querySelectorAll('.field-invalid').forEach(function(el) { el.classList.remove('field-invalid'); });
};

// ─── Shared message helper ──────────────────────────────
window.showMessage = function(containerId, message, type) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.textContent = message;
  el.className = 'flash ' + (type === 'error' ? 'flash-error' : 'flash-success');
  el.style.display = 'block';
  if (type !== 'error') setTimeout(() => { el.style.display = 'none'; }, 5000);
};

// ─── Mobile sidebar toggle ──────────────────────────────
(function() {
  var toggle = document.getElementById('sidebar-toggle');
  var sidebar = document.getElementById('sidebar');
  var overlay = document.getElementById('sidebar-overlay');
  if (!toggle || !sidebar) return;

  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function isOpen() {
    return toggle.getAttribute('aria-expanded') === 'true';
  }

  function openSidebar() {
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', window.GC.t['sidebar.toggle_close'] || 'Close navigation menu');
    sidebar.classList.add('open');
    if (overlay) overlay.classList.add('visible');
    document.body.style.overflow = 'hidden';
    var first = sidebar.querySelector(FOCUSABLE);
    if (first) first.focus();
  }

  function closeSidebar() {
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', window.GC.t['sidebar.toggle_open'] || 'Open navigation menu');
    sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('visible');
    document.body.style.overflow = '';
    toggle.focus();
  }

  toggle.addEventListener('click', function() {
    if (isOpen()) closeSidebar();
    else openSidebar();
  });

  if (overlay) {
    overlay.addEventListener('click', function() {
      if (isOpen()) closeSidebar();
    });
  }

  sidebar.addEventListener('click', function(e) {
    if (e.target.closest('.nav-item')) {
      if (isOpen()) closeSidebar();
    }
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && isOpen()) {
      closeSidebar();
    }
  });

  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Tab' || !isOpen()) return;

    var focusable = Array.from(sidebar.querySelectorAll(FOCUSABLE));
    focusable.unshift(toggle);
    if (focusable.length === 0) return;

    var first = focusable[0];
    var last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  var mq = window.matchMedia('(min-width: 901px)');
  function handleResize(e) {
    if (e.matches && isOpen()) {
      closeSidebar();
      document.body.style.overflow = '';
    }
  }
  if (mq.addEventListener) mq.addEventListener('change', handleResize);
  else if (mq.addListener) mq.addListener(handleResize);
})();

console.log('%cGateControl', 'font-size:16px;font-weight:bold;color:#0a6e4f');
