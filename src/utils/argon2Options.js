'use strict';

const argon2 = require('argon2');

module.exports = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
};
