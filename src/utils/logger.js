'use strict';

const pino = require('pino');
const config = require('../../config/default');

const logger = pino({
  level: config.app.logLevel,
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

module.exports = logger;
