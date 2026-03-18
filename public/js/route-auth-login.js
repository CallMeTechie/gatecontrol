'use strict';

/* ─── Helpers ────────────────────────────────────────────── */

function showError(message) {
  const el = document.getElementById('form-error');
  if (!el) return;
  el.textContent = message;
  el.classList.add('visible');
}

function hideError() {
  const el = document.getElementById('form-error');
  if (!el) return;
  el.classList.remove('visible');
  el.textContent = '';
}

function setLoading(btn, loading) {
  if (!btn) return;
  if (loading) {
    btn.classList.add('is-loading');
    btn.disabled = true;
  } else {
    btn.classList.remove('is-loading');
    btn.disabled = false;
  }
}

function getCsrf() {
  const el = document.querySelector('input[name="_csrf"]');
  return el ? el.value : '';
}

function getHidden(name) {
  const el = document.querySelector(`input[name="${name}"]`);
  return el ? el.value : '';
}

async function postJson(url, data) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': data._csrf || getCsrf()
    },
    body: JSON.stringify(data)
  });
  let json;
  try {
    json = await response.json();
  } catch {
    json = {};
  }
  return { ok: response.ok, status: response.status, data: json };
}

/* ─── Code Input Handling ────────────────────────────────── */

function initCodeInputs() {
  const container = document.getElementById('code-inputs');
  if (!container) return;

  const inputs = Array.from(container.querySelectorAll('input'));
  if (inputs.length !== 6) return;

  function getCode() {
    return inputs.map(i => i.value).join('');
  }

  function updateCodeHidden() {
    const hidden = document.getElementById('code-value');
    if (hidden) hidden.value = getCode();
  }

  function autoSubmit() {
    const code = getCode();
    if (code.length === 6 && /^\d{6}$/.test(code)) {
      updateCodeHidden();
      const form = document.getElementById('verify-form');
      if (form) {
        const btn = document.getElementById('verify-btn');
        setLoading(btn, true);
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    }
  }

  inputs.forEach((input, index) => {
    input.addEventListener('input', function () {
      // Clamp to single digit
      if (this.value.length > 1) {
        this.value = this.value.slice(-1);
      }
      // Only allow digits
      this.value = this.value.replace(/\D/g, '');

      if (this.value) {
        this.classList.add('filled');
        // Advance to next
        if (index < inputs.length - 1) {
          inputs[index + 1].focus();
        }
      } else {
        this.classList.remove('filled');
      }

      updateCodeHidden();
      autoSubmit();
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Backspace' && !this.value && index > 0) {
        inputs[index - 1].focus();
        inputs[index - 1].value = '';
        inputs[index - 1].classList.remove('filled');
        updateCodeHidden();
      }
    });

    input.addEventListener('focus', function () {
      this.select();
    });
  });

  // Paste handling on the container
  container.addEventListener('paste', function (e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text');
    const digits = text.replace(/\D/g, '').slice(0, 6);
    if (!digits) return;

    digits.split('').forEach((digit, i) => {
      if (inputs[i]) {
        inputs[i].value = digit;
        inputs[i].classList.add('filled');
      }
    });

    updateCodeHidden();

    // Focus on the next empty or last
    const nextEmpty = inputs.findIndex(inp => !inp.value);
    if (nextEmpty !== -1) {
      inputs[nextEmpty].focus();
    } else {
      inputs[inputs.length - 1].focus();
    }

    autoSubmit();
  });
}

/* ─── Login Form (email_password / 2FA step 1) ───────────── */

function initLoginForm() {
  const form = document.getElementById('login-form');
  if (!form) return;

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    hideError();

    const btn = document.getElementById('login-btn');
    setLoading(btn, true);

    const emailEl = form.querySelector('input[name="email"]');
    const passwordEl = form.querySelector('input[name="password"]');

    const payload = {
      _csrf: getCsrf(),
      route: getHidden('route'),
      redirect: getHidden('redirect'),
      email: emailEl ? emailEl.value : '',
      password: passwordEl ? passwordEl.value : ''
    };

    try {
      const { ok, data } = await postJson(form.action, payload);

      if (ok && data.twoFactorRequired) {
        // Server will show step 2 on reload
        window.location.reload();
        return;
      }

      if (ok && data.redirect) {
        window.location = data.redirect;
        return;
      }

      const msg = (data && data.error) ? data.error : 'An error occurred. Please try again.';
      showError(msg);
    } catch (err) {
      showError('An error occurred. Please try again.');
    }

    setLoading(btn, false);
  });
}

/* ─── Verify Code Form ───────────────────────────────────── */

function initVerifyForm() {
  const form = document.getElementById('verify-form');
  if (!form) return;

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    hideError();

    const btn = document.getElementById('verify-btn');
    setLoading(btn, true);

    // Collect the 6-digit code
    const codeHidden = document.getElementById('code-value');
    const container = document.getElementById('code-inputs');
    let code = '';
    if (container) {
      code = Array.from(container.querySelectorAll('input')).map(i => i.value).join('');
    } else if (codeHidden) {
      code = codeHidden.value;
    }

    const payload = {
      _csrf: getCsrf(),
      route: getHidden('route'),
      redirect: getHidden('redirect'),
      code
    };

    try {
      const { ok, data } = await postJson(form.action, payload);

      if (ok && data.redirect) {
        window.location = data.redirect;
        return;
      }

      const msg = (data && data.error) ? data.error : 'An error occurred. Please try again.';
      showError(msg);

      // Clear code inputs on error
      if (container) {
        container.querySelectorAll('input').forEach(inp => {
          inp.value = '';
          inp.classList.remove('filled');
        });
        const first = container.querySelector('input');
        if (first) first.focus();
      }
      if (codeHidden) codeHidden.value = '';
    } catch (err) {
      showError('An error occurred. Please try again.');
    }

    setLoading(btn, false);
  });
}

/* ─── Send Code Form ─────────────────────────────────────── */

function initSendCodeForm() {
  const form = document.getElementById('send-code-form');
  if (!form) return;

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    hideError();

    const btn = document.getElementById('send-code-btn');
    setLoading(btn, true);

    const emailEl = form.querySelector('input[name="email"]');
    const email = emailEl ? emailEl.value : '';

    const payload = {
      _csrf: getCsrf(),
      route: getHidden('route'),
      redirect: getHidden('redirect'),
      email
    };

    try {
      const { ok, data } = await postJson(form.action, payload);

      if (ok) {
        // Show masked email in info text using safe DOM manipulation
        const infoText = document.getElementById('code-info-text');
        if (infoText) {
          infoText.textContent = '';
          if (data.infoText || data.maskedEmail) {
            const prefix = document.createTextNode((data.infoText || '') + ' ');
            const strong = document.createElement('strong');
            strong.textContent = data.maskedEmail || '';
            infoText.appendChild(prefix);
            infoText.appendChild(strong);
          } else if (data.message) {
            infoText.textContent = data.message;
          }
        }

        // Switch visible sections
        const emailSection = document.getElementById('email-section');
        const codeSection = document.getElementById('code-section');
        if (emailSection) emailSection.style.display = 'none';
        if (codeSection) {
          codeSection.style.display = '';
          // Focus first code input
          const firstInput = codeSection.querySelector('#code-inputs input');
          if (firstInput) firstInput.focus();
        }

        setLoading(btn, false);
        return;
      }

      const msg = (data && data.error) ? data.error : 'An error occurred. Please try again.';
      showError(msg);
    } catch (err) {
      showError('An error occurred. Please try again.');
    }

    setLoading(btn, false);
  });
}

/* ─── Resend Code ────────────────────────────────────────── */

function initResendButton() {
  const btn = document.getElementById('resend-btn');
  if (!btn) return;

  btn.addEventListener('click', async function () {
    hideError();
    btn.disabled = true;

    // Get email from current context
    const emailEl = document.getElementById('email');
    const payload = {
      _csrf: getCsrf(),
      route: getHidden('route'),
      redirect: getHidden('redirect'),
      email: emailEl ? emailEl.value : ''
    };

    try {
      const { ok, data } = await postJson('/route-auth/send-code', payload);

      if (!ok) {
        const msg = (data && data.error) ? data.error : 'An error occurred. Please try again.';
        showError(msg);
      }
      // On success: code re-sent, no UI change needed
    } catch (err) {
      showError('An error occurred. Please try again.');
    }

    setTimeout(() => { btn.disabled = false; }, 3000);
  });
}

/* ─── Init ───────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', function () {
  initCodeInputs();
  initLoginForm();
  initVerifyForm();
  initSendCodeForm();
  initResendButton();
});
