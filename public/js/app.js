'use strict';

// ─── Toggle switches ────────────────────────────────────
document.querySelectorAll('.toggle').forEach(t => {
  t.addEventListener('click', () => t.classList.toggle('on'));
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

window.api = {
  async get(url) {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  },

  async post(url, data) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-CSRF-Token': window.GC.csrfToken,
      },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json().then(handleCsrfRotation);
  },

  async put(url, data) {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-CSRF-Token': window.GC.csrfToken,
      },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json().then(handleCsrfRotation);
  },

  async del(url) {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Accept': 'application/json',
        'X-CSRF-Token': window.GC.csrfToken,
      },
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json().then(handleCsrfRotation);
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
  if (el) { el.textContent = message; el.classList.remove('hidden'); }
};
window.hideError = function(containerId) {
  const el = document.getElementById(containerId);
  if (el) { el.textContent = ''; el.classList.add('hidden'); }
};

// ─── Shared message helper ──────────────────────────────
window.showMessage = function(containerId, message, type) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.textContent = message;
  el.className = 'mt-4 p-3 rounded-lg text-sm ' + (type === 'error' ? 'bg-red-900/50 text-red-200' : 'bg-green-900/50 text-green-200');
  el.classList.remove('hidden');
  if (type !== 'error') setTimeout(() => el.classList.add('hidden'), 3000);
};

console.log('%cGateControl', 'font-size:16px;font-weight:bold;color:#0a6e4f');
