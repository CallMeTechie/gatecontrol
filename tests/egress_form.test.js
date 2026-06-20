'use strict';

// Regression guard for the egress "+ Add scan target" form.
//
// Root cause of "the form never opens / + Add scan target does nothing":
// egressFieldLabel() stored `wrap._hint = h` but never appended `h` to
// `wrap`. buildForm() then called `wrap.insertBefore(input, wrap._hint)`,
// and insertBefore throws NotFoundError when the reference node is not a
// child — aborting buildForm() before `formEl.hidden = false`, so the form
// stayed hidden. No browser test harness here, so assert the source
// invariant: any element used as an insertBefore reference must be appended.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'gateways.js'), 'utf8');

describe('egress add-target form', () => {
  it('egressFieldLabel appends the hint element it later uses as an insertBefore reference', () => {
    const m = js.match(/function egressFieldLabel\([^)]*\)\s*\{([\s\S]*?)\n {2}\}/);
    assert.ok(m, 'egressFieldLabel function found');
    const body = m[1];
    // buildForm uses wrap._hint as an insertBefore reference, so the hint
    // element MUST be a child of wrap or insertBefore throws and the form
    // never opens.
    if (/_hint\s*=/.test(body)) {
      assert.match(
        body,
        /wrap\.appendChild\(h\)/,
        'hint element stored in wrap._hint must be appended to wrap (else insertBefore throws, form never opens)'
      );
    }
  });
});
