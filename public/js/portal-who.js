// public/js/portal-who.js — "Wer bist du?" on a shared device.
// The page works without this script (plain form POST); it only names the
// picked person in the PIN label and the button, and focuses the PIN field.
// Text only (textContent), no markup.
'use strict';
(function () {
  var form = document.getElementById('pt-who-form');
  if (!form) return;
  var label = document.getElementById('pt-who-pin-label');
  var button = document.getElementById('pt-who-submit');
  var pin = document.getElementById('pt-who-pin-input');

  function named(el, name) {
    if (!el) return;
    var tpl = name ? el.getAttribute('data-named') : null;
    el.textContent = tpl ? tpl.split('__NAME__').join(name) : (el.getAttribute('data-generic') || el.textContent);
  }

  function update(focus) {
    var picked = form.querySelector('input[name="user"]:checked');
    var name = picked ? picked.getAttribute('data-name') : '';
    named(label, name);
    named(button, name);
    if (focus && picked && pin) pin.focus();
  }

  form.addEventListener('change', function (e) {
    if (e.target && e.target.name === 'user') update(true);
  });
  // Digits only — the PIN is 4 to 6 digits.
  if (pin) {
    pin.addEventListener('input', function () {
      var clean = pin.value.replace(/\D+/g, '').slice(0, 6);
      if (clean !== pin.value) pin.value = clean;
    });
  }
  update(false);
  if (form.querySelector('input[name="user"]:checked') && pin && !document.getElementById('pt-who-error')) pin.focus();
  else if (document.getElementById('pt-who-error') && pin) pin.focus();
})();
