'use strict';

// docs/plugins.md "Media": the <iframe> of a plugin whose `media.types` take videos gets
// allow="fullscreen *" — a <video> of its own media URLs plays in full screen (Drive's viewer of pictures and
// videos). Before only permissions.cameras had it; a plugin with pictures or documents only still has none.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const frame = require('../src/services/plugins/frame');

describe('plugin frames: full screen for videos', () => {
  it('fullscreenOf: cameras, video types and every type; not pictures or documents only', () => {
    assert.equal(frame.fullscreenOf({ permissions: { cameras: true } }), true);
    assert.equal(frame.fullscreenOf({ media: { types: ['*/*'] } }), true);
    assert.equal(frame.fullscreenOf({ media: { types: ['image/jpeg', 'video/*'] } }), true);
    assert.equal(frame.fullscreenOf({ media: { types: ['video/mp4'] } }), true);
    assert.equal(frame.fullscreenOf({ media: { types: ['image/*', 'audio/ogg', 'application/pdf'] } }), false);
    assert.equal(frame.fullscreenOf({ media: {} }), false);
    assert.equal(frame.fullscreenOf({}), false);
    assert.equal(frame.fullscreenOf(null), false);
  });

  it('allowAttr: fullscreen after microphone', () => {
    const m = { media: { types: ['*/*'] } };
    assert.equal(frame.allowAttr({ media: true, fullscreen: frame.fullscreenOf(m) }), 'microphone *; fullscreen *');
    assert.equal(frame.allowAttr({ media: true, fullscreen: frame.fullscreenOf({ media: { types: ['image/png'] } }) }), 'microphone *');
  });
});
