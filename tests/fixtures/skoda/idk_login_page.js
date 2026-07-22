'use strict';
// Synthetic VW identity login page (structure per myskoda reference).
// Replace with a redacted live capture after the Task-3 spike if it deviates.
const emailPage = `<!DOCTYPE html><html><head><title>Login</title></head><body>
<script>
window._IDK = {
  baseUrl: 'https://identity.vwgroup.io',
  csrf_token: 'csrf-123',
  templateModel: {"clientLegalEntityModel":{"clientId":"7f045eee-7003-4379-9968-9355ed2adb06@apps_vw-dilab_com"},"template":"loginAuthenticate","hmac":"hmac-abc","relayState":"relay-xyz","postAction":"login/identifier","identifierUrl":"login/identifier","error":null},
  userSession: {}
};
</script>
</body></html>`;

const passwordPage = emailPage
  .replace('hmac-abc', 'hmac-def')
  .replace('"postAction":"login/identifier"', '"postAction":"login/authenticate"');

module.exports = { emailPage, passwordPage };
