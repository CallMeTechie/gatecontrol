'use strict';

// The task for the DSM Task Scheduler that provides /dev/net/tun and starts the
// gateway after boot-up (assistant "Gateway hinzufügen › Synology NAS", handbook
// FAQ „/dev/net/tun“ fehlt). Its wording is deploy/synology-tun.sh of
// gatecontrol-gateway, checked in as
// tests/fixtures/gateway-compose/synology-tun.sh (the gateway tests it with
// stand-ins for docker, modprobe …). When the gateway changes the script, copy
// it again — this test then shows where the server has to follow.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SCRIPT = read('tests/fixtures/gateway-compose/synology-tun.sh').replace(/\n$/, '');

describe('Synology: task for /dev/net/tun', () => {
  it('the assistant shows the script of the gateway, copyable, kept away from the template engine', () => {
    const njk = read('templates/aurora/pages/gateways.njk');
    const m = /<pre [^>]*id="gwz-cw-tun-script"[^>]*>\{% raw %\}([\s\S]*?)\{% endraw %\}<\/pre>/.exec(njk);
    assert.ok(m, 'script block in the assistant');
    assert.equal(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), SCRIPT);
    assert.doesNotMatch(m[1], /[<>]/, 'escaped for HTML');
    assert.match(njk, /data-gwz-copy="gwz-cw-tun-script"/);
  });

  it('the handbook (German and English) prints the same script in the FAQ', () => {
    const block = '   ```sh\n' + SCRIPT.split('\n').map((l) => '   ' + l).join('\n') + '\n   ```\n';
    for (const f of ['docs/handbuch/07-faq.md', 'docs/guide/07-faq.md']) assert.ok(read(f).includes(block), f);
  });

  it('nobody recommends the bare insmod line any more', () => {
    const files = ['templates/aurora/pages/gateways.njk', 'src/i18n/de.json', 'src/i18n/en.json']
      .concat(['docs/handbuch', 'docs/guide'].flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.md')).map((f) => d + '/' + f)));
    for (const f of files) assert.doesNotMatch(read(f), /insmod \/lib\/modules\/tun\.ko/, f);
  });

  it('the texts around it exist in both languages', () => {
    for (const lang of ['de', 'en']) {
      const t = JSON.parse(read(`src/i18n/${lang}.json`));
      for (const k of ['tun_title', 'tun_text', 'tun_1', 'tun_2', 'tun_3', 'tun_4', 'tun_script_label', 'tun_what']) {
        assert.ok(t['gwiz.cw.' + k], `${lang}: gwiz.cw.${k}`);
      }
    }
  });
});
