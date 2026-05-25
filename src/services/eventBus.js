'use strict';

const EventEmitter = require('node:events');
const logger = require('../utils/logger');

const CHANNEL = 'event';
const emitter = new EventEmitter();
emitter.setMaxListeners(100);

const wrappers = new Map(); // public listener -> internal wrapper

function publish(type, payload) {
  if (emitter.listenerCount(CHANNEL) === 0) return;
  emitter.emit(CHANNEL, { type, payload, ts: Date.now() });
}

function subscribe(listener, filter) {
  if (wrappers.has(listener)) return; // ignore duplicate subscribe — prevents an orphaned wrapper leak
  const wrapper = (evt) => {
    try {
      if (filter && !filter(evt.type, evt.payload)) return;
      listener(evt);
    } catch (err) {
      logger.warn({ err: err.message, type: evt.type }, 'event bus subscriber threw');
    }
  };
  wrappers.set(listener, wrapper);
  emitter.on(CHANNEL, wrapper);
}

function unsubscribe(listener) {
  const wrapper = wrappers.get(listener);
  if (wrapper) { emitter.off(CHANNEL, wrapper); wrappers.delete(listener); }
}

function subscriberCount() { return emitter.listenerCount(CHANNEL); }

module.exports = { publish, subscribe, unsubscribe, subscriberCount };
