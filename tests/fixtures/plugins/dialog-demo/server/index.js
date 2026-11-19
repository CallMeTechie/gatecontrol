'use strict';

// Fixture of tests/e2e/scenarios/34-plugin-dialog-dim.js: a short page with two
// dialogs the way plugins build them — a fixed backdrop over the frame with a
// card in it. "Long" is taller than any window (the frame grows, the page
// scrolls); "Fit" keeps to GC.viewport (--gc-viewport-height) and scrolls inside.

const HTML = `<style>
  body{margin:0;padding:16px;font:14px/1.4 system-ui,sans-serif;background:var(--bg);color:var(--text)}
  .ov{position:fixed;inset:0;background:rgba(5,8,12,.55);overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:32px 12px}
  .ov[hidden]{display:none}
  .card{width:min(520px,100%);background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px;box-sizing:border-box}
  #long .card{height:1600px}
  #fit .card{display:flex;flex-direction:column;max-height:calc(var(--gc-viewport-height,100vh) - 64px)}
  #fit .body{flex:1 1 auto;min-height:0;overflow:auto}
  #fit .body p{height:120px;margin:0 0 8px;background:var(--surface-2)}
</style>
<main>
  <h1 id="title">Dialog</h1>
  <button id="open-long" type="button">Long</button>
  <button id="open-fit" type="button">Fit</button>
</main>
<div class="ov" id="long" hidden><div class="card"><h2>Long</h2><button class="close" type="button">Close</button></div></div>
<div class="ov" id="fit" hidden><div class="card"><h2>Fit</h2><div class="body">${'<p></p>'.repeat(20)}</div><button class="close" type="button">Close</button></div></div>
<script>
  document.getElementById('open-long').onclick = function () { document.getElementById('long').hidden = false; };
  document.getElementById('open-fit').onclick = function () { document.getElementById('fit').hidden = false; };
  document.querySelectorAll('.close').forEach(function (b) { b.onclick = function () { b.closest('.ov').hidden = true; }; });
</script>`;

module.exports = {
  async render() { return { html: HTML }; },
  async request() { return { status: 404, json: { error: 'not found' } }; },
};
