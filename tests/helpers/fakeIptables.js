'use strict';

// A stand-in for iptables / iptables-restore that keeps the rule set like the
// real ones do (-S, -I at a position, -D, -F, -X, restore with --noflush) —
// for the tests of "Fremden DNS und DoT sperren" (src/services/vpnDnsFirewall.js).
// It starts with the rules entrypoint.sh and wg-quick's PostUp set.

const assert = require('node:assert/strict');

/** A small iptables: tables → chains → rules (as the text after `-A <chain> `). */
function fakeIptables({ failOn = null } = {}) {
  const tables = {
    nat: { PREROUTING: [], POSTROUTING: ['-s 10.8.0.0/24 -o eth0 -j MASQUERADE'] },
    filter: { INPUT: [], FORWARD: ['-i wg0 -j ACCEPT', '-i eth0 -o wg0 -m state --state RELATED,ESTABLISHED -j ACCEPT'] },
  };
  const calls = [];
  const builtin = new Set(['PREROUTING', 'POSTROUTING', 'INPUT', 'FORWARD']);
  const exec = async (cmd, args, stdin) => {
    calls.push([cmd, ...args].join(' '));
    if (failOn && failOn(cmd, args)) return { code: 4, stdout: '', stderr: 'iptables: Permission denied (you must be root).' };
    if (cmd === 'iptables-restore') {
      assert.deepEqual(args, ['-w', '5', '--noflush']);
      let t = null;
      for (const line of stdin.split('\n')) {
        if (line.startsWith('*')) t = tables[line.slice(1)];
        else if (line.startsWith(':')) t[line.slice(1).split(' ')[0]] = []; // naming a chain empties it
        else if (line.startsWith('-A ')) { const [, chain, ...rest] = line.split(' '); t[chain].push(rest.join(' ')); }
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    assert.equal(cmd, 'iptables');
    assert.deepEqual(args.slice(0, 3), ['-w', '5', '-t']);
    const t = tables[args[3]];
    const [op, chain, ...rest] = args.slice(4);
    const list = t[chain];
    if (!list) return { code: 1, stdout: '', stderr: 'No chain/target/match by that name.' };
    if (op === '-S') return { code: 0, stdout: [builtin.has(chain) ? `-P ${chain} ACCEPT` : `-N ${chain}`, ...list.map((r) => `-A ${chain} ${r}`)].join('\n') + '\n', stderr: '' };
    if (op === '-I') { list.splice(Number(rest[0]) - 1, 0, rest.slice(1).join(' ')); return { code: 0, stdout: '', stderr: '' }; }
    if (op === '-D') {
      const i = list.indexOf(rest.join(' '));
      if (i < 0) return { code: 1, stdout: '', stderr: 'Bad rule (does a matching rule exist in that chain?).' };
      list.splice(i, 1);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (op === '-F') { list.length = 0; return { code: 0, stdout: '', stderr: '' }; }
    if (op === '-X') { delete t[chain]; return { code: 0, stdout: '', stderr: '' }; }
    return { code: 2, stdout: '', stderr: 'unknown' };
  };
  return { tables, calls, exec };
}

module.exports = { fakeIptables };
