'use strict';

/**
 * Input-validation helpers for the routes service. Each helper THROWS on
 * a constraint violation so the caller — create() / update() — can let
 * the exception propagate to the API layer untouched.
 *
 * Some helpers also normalise nested JSON (currently bot_blocker_config)
 * by mutating the caller's `data` object. That mutation is intentional
 * and matches the pre-refactor behaviour: the subsequent INSERT/UPDATE
 * statement reads `data.bot_blocker_config` and expects a string. A
 * future PR can flip this to a return-value pattern; this PR keeps the
 * semantics byte-stable.
 */

const VALID_BOT_MODES = ['block', 'tarpit', 'drop', 'garbage', 'redirect', 'custom'];

const BRANDING_TITLE_MAX = 255;
const BRANDING_TEXT_MAX = 2000;
const BOT_CUSTOM_MESSAGE_MAX = 500;

/**
 * PATCH-semantics helper for the update() path: run `validatorFn(value)`
 * only when the field is actually present on the patch payload (i.e.
 * `data[field] !== undefined`). The validator is expected to return an
 * error STRING on failure, or any falsy value on success — that matches
 * the contract used throughout src/utils/validate.js.
 *
 * Throws an Error with the validator's message on failure, otherwise
 * returns silently.
 *
 * Empty strings and zero ARE considered "provided" (only `undefined`
 * skips). That matches the existing inline pattern in update() — an
 * admin sending `target_port: 0` should hit the validator and get a
 * "must be 1-65535" error rather than being silently allowed because
 * 0 is falsy.
 */
function validateIfProvided(data, field, validatorFn) {
  if (data[field] === undefined) return;
  const err = validatorFn(data[field]);
  if (err) throw new Error(err);
}

function validateBrandingFields(data) {
  if (data.branding_title && data.branding_title.length > BRANDING_TITLE_MAX) {
    throw new Error(`Branding title must be ${BRANDING_TITLE_MAX} characters or less`);
  }
  if (data.branding_text && data.branding_text.length > BRANDING_TEXT_MAX) {
    throw new Error(`Branding text must be ${BRANDING_TEXT_MAX} characters or less`);
  }
}

/**
 * Validate bot-blocker mode + nested JSON config. Mutates `data.bot_blocker_config`
 * to a normalised JSON string when the original value was an object — the SQL
 * write below expects a string and the pre-refactor inline code did the same.
 */
function validateBotBlockerConfig(data) {
  if (data.bot_blocker_mode && !VALID_BOT_MODES.includes(data.bot_blocker_mode)) {
    throw new Error('Invalid bot blocker mode');
  }
  if (!data.bot_blocker_config) return;

  const bbCfg = (typeof data.bot_blocker_config === 'string'
    ? JSON.parse(data.bot_blocker_config)
    : data.bot_blocker_config) || {};

  if (data.bot_blocker_mode === 'redirect' && (!bbCfg.url || !/^https?:\/\//.test(bbCfg.url))) {
    throw new Error('Redirect mode requires a valid URL');
  }
  if (data.bot_blocker_mode === 'custom') {
    if (bbCfg.status_code && (bbCfg.status_code < 100 || bbCfg.status_code > 599)) {
      throw new Error('Invalid status code');
    }
    if (bbCfg.message && bbCfg.message.length > BOT_CUSTOM_MESSAGE_MAX) {
      throw new Error('Message too long');
    }
  }

  data.bot_blocker_config = typeof data.bot_blocker_config === 'string'
    ? data.bot_blocker_config
    : JSON.stringify(data.bot_blocker_config);
}

module.exports = {
  validateIfProvided,
  validateBrandingFields,
  validateBotBlockerConfig,
  VALID_BOT_MODES,
};
