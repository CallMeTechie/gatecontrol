'use strict';

const logger = require('./logger');

/**
 * Wraps an async task with retry logic and exponential backoff.
 * Designed for background tasks that run on intervals.
 *
 * @param {string} name - Task name for logging
 * @param {Function} fn - Async function to execute
 * @param {object} [options]
 * @param {number} [options.maxRetries=3] - Max retry attempts per invocation
 * @param {number} [options.baseDelayMs=2000] - Initial backoff delay
 * @param {number} [options.maxDelayMs=30000] - Maximum backoff delay
 * @returns {Function} Wrapped async function
 */
function withRetry(name, fn, options = {}) {
  const { maxRetries = 3, baseDelayMs = 2000, maxDelayMs = 30_000 } = options;
  let consecutiveFailures = 0;

  return async function retryWrapper(...args) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn(...args);
        if (consecutiveFailures > 0) {
          logger.info({ task: name, previousFailures: consecutiveFailures }, 'Task recovered');
        }
        consecutiveFailures = 0;
        return result;
      } catch (err) {
        consecutiveFailures++;
        const isLastAttempt = attempt === maxRetries;

        if (isLastAttempt) {
          logger.error(
            { task: name, attempt: attempt + 1, totalFailures: consecutiveFailures, error: err.message },
            'Task failed after all retries'
          );
          return; // Don't throw — let interval continue
        }

        const delay = Math.min(baseDelayMs * Math.pow(1.5, attempt), maxDelayMs);
        logger.warn(
          { task: name, attempt: attempt + 1, retryInMs: delay, error: err.message },
          'Task failed, retrying'
        );
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  };
}

module.exports = { withRetry };
