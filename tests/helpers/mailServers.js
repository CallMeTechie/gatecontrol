'use strict';

// Small IMAP and SMTP servers for tests/plugins_mail.test.js — just enough of
// both protocols for imapflow and nodemailer (no real providers in the CI).
// TLS from the start or by STARTTLS, with a certificate the tests make with
// openssl (testCert) for mail.test.example. Every command is logged in
// `commands`, so a test can tell what reached the server before TLS.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');

/** A self-signed certificate for `names` (SAN), valid two days → { key, cert } (PEM). */
function testCert(names = ['mail.test.example']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-mailcert-'));
  try {
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert,
      '-days', '2', '-subj', `/CN=${names[0]}`, '-addext', `subjectAltName=${names.map((n) => 'DNS:' + n).join(',')}`], { stdio: 'ignore' });
    return { key: fs.readFileSync(key, 'utf8'), cert: fs.readFileSync(cert, 'utf8') };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// ─── IMAP ───────────────────────────────────────

function q(s) {
  return s == null ? 'NIL' : `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function headerOf(raw, name) {
  const head = raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  const want = String(name).toLowerCase();
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0 && line.slice(0, i).trim().toLowerCase() === want) return line.slice(i + 1).trim();
  }
  return null;
}

function addrList(v) {
  if (!v) return 'NIL';
  const parts = v.split(',').map((x) => x.trim()).filter(Boolean).map((a) => {
    const m = /^(?:"?([^"<]*)"?\s*)?<([^@>]+)@([^>]+)>$/.exec(a) || [null, null, ...a.split('@')];
    return `(${m[1] ? q(m[1].trim()) : 'NIL'} NIL ${q(m[2])} ${q(m[3])})`;
  });
  return `(${parts.join('')})`;
}

function envelope(raw) {
  const from = addrList(headerOf(raw, 'From'));
  return `(${q(headerOf(raw, 'Date'))} ${q(headerOf(raw, 'Subject'))} ${from} ${from} ${from} ${addrList(headerOf(raw, 'To'))} `
    + `${addrList(headerOf(raw, 'Cc'))} NIL ${q(headerOf(raw, 'In-Reply-To'))} ${q(headerOf(raw, 'Message-ID'))})`;
}

function uidSet(set, msgs) {
  const max = msgs.length ? Math.max(...msgs.map((m) => m.uid)) : 0;
  const out = new Set();
  for (const part of String(set).split(',')) {
    const [a, b] = part.split(':').map((x) => (x === '*' ? max : Number(x)));
    const lo = Math.min(a, b === undefined ? a : b);
    const hi = Math.max(a, b === undefined ? a : b);
    for (const m of msgs) if (m.uid >= lo && m.uid <= hi) out.add(m.uid);
  }
  return out;
}

/**
 * opts: { secure (TLS from the start), starttls (offer STARTTLS on a plain
 * connection), cert, users: { name: pass }, messages: [{ uid, flags, raw }] }
 */
function imapServer(opts) {
  const state = {
    commands: [], sockets: new Set(), connections: 0, idling: new Set(), appended: [],
    mailboxes: { INBOX: { uidValidity: 1700, messages: (opts.messages || []).map((m) => ({ ...m, flags: [...(m.flags || [])] })) }, Sent: { uidValidity: 1800, messages: [] } },
  };
  const caps = (secure) => ['IMAP4rev1', 'IDLE', 'UIDPLUS', 'MOVE', ...(!secure && opts.starttls ? ['STARTTLS'] : [])].join(' ');

  function handle(sock, secureNow) {
    state.connections++;
    state.sockets.add(sock);
    let buf = '';
    let literal = null; // { need, line, tag }
    let lastLiteral = null; // the bytes of the last literal (APPEND)
    let selected = null;
    let idleTag = null;
    let current = sock;
    const send = (s) => { if (!current.destroyed) current.write(s + '\r\n'); };
    current.on('close', () => { state.sockets.delete(sock); state.idling.delete(api); });
    const api = { push: (s) => send(s) };
    const box = () => state.mailboxes[selected];
    const fetchLine = (m, seq, items) => {
      const out = [`UID ${m.uid}`];
      if (/\bFLAGS\b/i.test(items)) out.push(`FLAGS (${m.flags.join(' ')})`);
      if (/RFC822\.SIZE/i.test(items)) out.push(`RFC822.SIZE ${Buffer.byteLength(m.raw)}`);
      if (/INTERNALDATE/i.test(items)) out.push('INTERNALDATE "02-Jan-2026 10:00:00 +0000"');
      if (/ENVELOPE/i.test(items)) out.push(`ENVELOPE ${envelope(m.raw)}`);
      const hf = /BODY\.PEEK\[HEADER\.FIELDS \(([^)]*)\)\]/i.exec(items);
      if (hf) {
        const lines = hf[1].split(/\s+/).filter(Boolean).map((n) => { const v = headerOf(m.raw, n); return v == null ? null : `${n}: ${v}`; }).filter(Boolean);
        const data = lines.join('\r\n') + '\r\n\r\n';
        out.push(`BODY[HEADER.FIELDS (${hf[1].toUpperCase()})] {${Buffer.byteLength(data)}}\r\n${data}`);
      }
      const whole = /BODY\.PEEK\[\](?:<(\d+)\.(\d+)>)?/i.exec(items);
      if (whole) {
        const bytes = Buffer.from(m.raw);
        const start = whole[1] ? Number(whole[1]) : 0;
        const part = whole[2] ? bytes.subarray(start, start + Number(whole[2])) : bytes;
        out.push(`BODY[]${whole[1] ? `<${start}>` : ''} {${part.length}}\r\n${part.toString('latin1')}`);
      }
      return `* ${seq} FETCH (${out.join(' ')})`;
    };
    const search = (crit) => {
      const msgs = box().messages;
      let set = new Set(msgs.map((m) => m.uid));
      const uidm = /\bUID ([0-9:*,]+)/i.exec(crit);
      if (uidm) set = uidSet(uidm[1], msgs);
      const keep = (fn) => { for (const m of msgs) if (set.has(m.uid) && !fn(m)) set.delete(m.uid); };
      if (/\bUNSEEN\b/i.test(crit)) keep((m) => !m.flags.includes('\\Seen'));
      else if (/\bSEEN\b/i.test(crit)) keep((m) => m.flags.includes('\\Seen'));
      const subj = /\bSUBJECT "?([^"]+)"?/i.exec(crit);
      if (subj) keep((m) => String(headerOf(m.raw, 'Subject') || '').includes(subj[1]));
      return [...set].sort((a, b) => a - b);
    };
    const command = (tag, line) => {
      const rest = line.slice(tag.length + 1);
      const cmd = rest.split(' ')[0].toUpperCase();
      const args = rest.slice(cmd.length + 1);
      state.commands.push({ cmd, args: cmd === 'LOGIN' ? '***' : args, secure: secureNow });
      if (cmd === 'CAPABILITY') { send(`* CAPABILITY ${caps(secureNow)}`); send(`${tag} OK done`); return; }
      if (cmd === 'NOOP') { send(`${tag} OK done`); return; }
      if (cmd === 'LOGOUT') { send('* BYE bye'); send(`${tag} OK done`); current.end(); return; }
      if (cmd === 'STARTTLS' && !secureNow && opts.starttls) {
        send(`${tag} OK begin TLS`);
        current.removeAllListeners('data');
        const t = new tls.TLSSocket(current, { isServer: true, key: opts.cert.key, cert: opts.cert.cert });
        current = t;
        secureNow = true;
        buf = '';
        t.on('data', onData);
        t.on('error', () => {});
        return;
      }
      if (cmd === 'LOGIN') {
        const m = /^"?([^" ]+)"? "?([^"]*)"?$/.exec(args) || [];
        if (opts.users && opts.users[m[1]] === m[2]) { send(`${tag} OK [CAPABILITY ${caps(true)}] logged in`); return; }
        send(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials for ${m[1]} (password ${m[2]})`);
        return;
      }
      if (cmd === 'LIST' || cmd === 'LSUB') {
        if (/""\s*""$/.test(args)) { send(`* ${cmd} (\\Noselect) "/" ""`); send(`${tag} OK done`); return; }
        send(`* ${cmd} (\\HasNoChildren) "/" "INBOX"`);
        send(`* ${cmd} (\\HasNoChildren \\Sent) "/" "Sent"`);
        send(`${tag} OK done`);
        return;
      }
      if (cmd === 'SELECT' || cmd === 'EXAMINE') {
        const name = args.replace(/"/g, '').split(' ')[0];
        if (!state.mailboxes[name]) { send(`${tag} NO no such mailbox`); return; }
        selected = name;
        const b = box();
        const next = b.messages.length ? Math.max(...b.messages.map((m) => m.uid)) + 1 : 1;
        send(`* ${b.messages.length} EXISTS`); send('* 0 RECENT'); send('* FLAGS (\\Seen \\Flagged \\Deleted \\Answered \\Draft)');
        send('* OK [PERMANENTFLAGS (\\Seen \\Flagged \\Deleted \\Answered \\Draft \\*)] ok');
        send(`* OK [UIDVALIDITY ${b.uidValidity}] ok`); send(`* OK [UIDNEXT ${next}] ok`);
        send(`${tag} OK [${cmd === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] done`);
        return;
      }
      if (cmd === 'STATUS') {
        const name = args.replace(/"/g, '').split(' ')[0];
        const b = state.mailboxes[name];
        if (!b) { send(`${tag} NO no such mailbox`); return; }
        const next = b.messages.length ? Math.max(...b.messages.map((m) => m.uid)) + 1 : 1;
        const unseen = b.messages.filter((m) => !m.flags.includes('\\Seen')).length;
        send(`* STATUS "${name}" (MESSAGES ${b.messages.length} UNSEEN ${unseen} UIDNEXT ${next} UIDVALIDITY ${b.uidValidity})`);
        send(`${tag} OK done`);
        return;
      }
      if (cmd === 'IDLE') { idleTag = tag; state.idling.add(api); send('+ idling'); return; }
      if (cmd === 'APPEND') {
        const name = args.replace(/"/g, '').split(' ')[0];
        const b = state.mailboxes[name];
        const raw = lastLiteral;
        const uid = (b.messages.length ? Math.max(...b.messages.map((m) => m.uid)) : 0) + 1;
        b.messages.push({ uid, flags: /\\Seen/.test(args) ? ['\\Seen'] : [], raw });
        state.appended.push({ mailbox: name, raw });
        send(`${tag} OK [APPENDUID ${b.uidValidity} ${uid}] appended`);
        return;
      }
      if (cmd === 'UID') {
        const sub = args.split(' ')[0].toUpperCase();
        const subArgs = args.slice(sub.length + 1);
        if (!selected) { send(`${tag} BAD no mailbox`); return; }
        const msgs = box().messages;
        if (sub === 'SEARCH') { const r = search(subArgs); send(`* SEARCH${r.length ? ' ' + r.join(' ') : ''}`); send(`${tag} OK done`); return; }
        const set = uidSet(subArgs.split(' ')[0], msgs);
        const items = subArgs.slice(subArgs.split(' ')[0].length + 1);
        if (sub === 'FETCH') {
          msgs.forEach((m, i) => { if (set.has(m.uid)) send(fetchLine(m, i + 1, items)); });
          send(`${tag} OK done`);
          return;
        }
        if (sub === 'STORE') {
          const fl = (/\(([^)]*)\)/.exec(items) || [null, ''])[1].split(/\s+/).filter(Boolean);
          msgs.forEach((m, i) => {
            if (!set.has(m.uid)) return;
            if (/^\+FLAGS/i.test(items)) m.flags = [...new Set([...m.flags, ...fl])];
            else if (/^-FLAGS/i.test(items)) m.flags = m.flags.filter((f) => !fl.includes(f));
            if (!/SILENT/i.test(items)) send(`* ${i + 1} FETCH (UID ${m.uid} FLAGS (${m.flags.join(' ')}))`);
          });
          send(`${tag} OK done`);
          return;
        }
        if (sub === 'MOVE' || sub === 'COPY') {
          const dest = state.mailboxes[items.replace(/"/g, '').trim()];
          if (!dest) { send(`${tag} NO [TRYCREATE] no such mailbox`); return; }
          const src = []; const dst = [];
          for (const m of msgs.filter((x) => set.has(x.uid))) {
            const uid = (dest.messages.length ? Math.max(...dest.messages.map((x) => x.uid)) : 0) + 1;
            dest.messages.push({ ...m, uid, flags: [...m.flags] });
            src.push(m.uid); dst.push(uid);
          }
          send(`* OK [COPYUID ${dest.uidValidity} ${src.join(',')} ${dst.join(',')}] done`);
          if (sub === 'MOVE') {
            for (let i = msgs.length - 1; i >= 0; i--) if (set.has(msgs[i].uid)) { send(`* ${i + 1} EXPUNGE`); msgs.splice(i, 1); }
          }
          send(`${tag} OK done`);
          return;
        }
        if (sub === 'EXPUNGE') {
          for (let i = msgs.length - 1; i >= 0; i--) if (set.has(msgs[i].uid) && msgs[i].flags.includes('\\Deleted')) { send(`* ${i + 1} EXPUNGE`); msgs.splice(i, 1); }
          send(`${tag} OK done`);
          return;
        }
      }
      if (cmd === 'CLOSE' || cmd === 'UNSELECT') { selected = null; send(`${tag} OK done`); return; }
      send(`${tag} BAD unknown command`);
    };
    function onData(chunk) {
      buf += chunk.toString('latin1');
      for (;;) {
        if (literal) {
          if (Buffer.byteLength(buf, 'latin1') < literal.need) return;
          literal.data = buf.slice(0, literal.need);
          buf = buf.slice(literal.need);
          const i = buf.indexOf('\r\n');
          if (i < 0) { buf = ''; }
          else buf = buf.slice(i + 2);
          const l = literal;
          lastLiteral = l.data;
          literal = null;
          command(l.tag, l.line);
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (idleTag) {
          if (line.trim().toUpperCase() === 'DONE') { state.idling.delete(api); send(`${idleTag} OK IDLE terminated`); idleTag = null; }
          continue;
        }
        const tag = line.split(' ')[0];
        const lit = /\{(\d+)\}$/.exec(line);
        if (lit) {
          literal = { need: Number(lit[1]), line: line.slice(0, lit.index).trim(), tag };
          send('+ go ahead');
          continue;
        }
        command(tag, line);
      }
    }
    current.on('data', onData);
    current.on('error', () => {});
    send(`* OK [CAPABILITY ${caps(secureNow)}] test IMAP ready`);
  }

  const server = opts.secure
    ? tls.createServer({ key: opts.cert.key, cert: opts.cert.cert }, (s) => handle(s, true))
    : net.createServer((s) => handle(s, false));
  return {
    state,
    server,
    start: () => listen(server),
    /** a new message arrives (an IDLE session gets EXISTS) */
    deliver(raw) {
      const b = state.mailboxes.INBOX;
      const uid = (b.messages.length ? Math.max(...b.messages.map((m) => m.uid)) : 0) + 1;
      b.messages.push({ uid, flags: [], raw });
      for (const s of state.idling) s.push(`* ${b.messages.length} EXISTS`);
      return uid;
    },
    open: () => state.sockets.size,
    stop: () => { for (const s of state.sockets) s.destroy(); return new Promise((r) => server.close(() => r())); },
  };
}

// ─── SMTP ───────────────────────────────────────

/** opts: { secure, starttls, cert, users: { name: pass }, rejectRcpt: RegExp } */
function smtpServer(opts) {
  // open / maxOpen: connections at the same time (the host's SMTP limit); greetingDelayMs: a slow server
  const state = { commands: [], mails: [], sockets: new Set(), open: 0, maxOpen: 0 };
  function handle(sock, secureNow) {
    state.sockets.add(sock);
    state.open++;
    state.maxOpen = Math.max(state.maxOpen, state.open);
    sock.once('close', () => { state.open--; });
    let current = sock;
    let buf = '';
    let data = null;
    let mail = null;
    const send = (s) => { if (!current.destroyed) current.write(s + '\r\n'); };
    current.on('close', () => state.sockets.delete(sock));
    const onLine = (line) => {
      const cmd = line.split(' ')[0].toUpperCase();
      state.commands.push({ cmd, secure: secureNow, auth: cmd === 'AUTH' });
      if (cmd === 'EHLO') {
        send('250-smtp.test.example');
        if (!secureNow && opts.starttls) send('250-STARTTLS');
        send('250-AUTH PLAIN XOAUTH2');
        send('250 SIZE 52428800');
        return;
      }
      if (cmd === 'HELO') { send('250 smtp.test.example'); return; }
      if (cmd === 'STARTTLS' && !secureNow && opts.starttls) {
        send('220 go ahead');
        current.removeAllListeners('data');
        const t = new tls.TLSSocket(current, { isServer: true, key: opts.cert.key, cert: opts.cert.cert });
        current = t; secureNow = true; buf = '';
        t.on('data', onData); t.on('error', () => {});
        return;
      }
      if (cmd === 'STARTTLS') { send('502 5.5.1 not supported'); return; }
      if (cmd === 'AUTH') {
        const [, mech, b64] = line.split(' ');
        if (/^PLAIN$/i.test(mech)) {
          const [, user, pass] = Buffer.from(b64 || '', 'base64').toString('utf8').split('\0');
          if (opts.users && opts.users[user] === pass) send('235 2.7.0 ok');
          else send(`535 5.7.8 bad credentials for ${user} (${pass})`);
          return;
        }
        if (/^XOAUTH2$/i.test(mech)) {
          const s = Buffer.from(b64 || '', 'base64').toString('utf8');
          if (/auth=Bearer good-token/.test(s)) send('235 2.7.0 ok'); else send('535 5.7.8 bad token');
          return;
        }
        send('504 unknown mechanism');
        return;
      }
      if (cmd === 'MAIL') { mail = { from: (/<([^>]*)>/.exec(line) || [])[1], to: [], secure: secureNow }; send('250 ok'); return; }
      if (cmd === 'RCPT') {
        const to = (/<([^>]*)>/.exec(line) || [])[1];
        if (opts.rejectRcpt && opts.rejectRcpt.test(to)) { send(`550 5.1.1 <${to}> no such user`); return; }
        mail.to.push(to);
        send('250 ok');
        return;
      }
      if (cmd === 'DATA') { data = []; send('354 go ahead'); return; }
      if (cmd === 'RSET') { mail = null; send('250 ok'); return; }
      if (cmd === 'NOOP') { send('250 ok'); return; }
      if (cmd === 'QUIT') { send('221 bye'); current.end(); return; }
      send('500 unknown');
    };
    function onData(chunk) {
      buf += chunk.toString('latin1');
      for (;;) {
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data) {
          if (line === '.') { state.mails.push({ ...mail, raw: data.join('\r\n') }); data = null; send('250 2.0.0 queued as T1'); continue; }
          data.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }
        onLine(line);
      }
    }
    current.on('data', onData);
    current.on('error', () => {});
    if (opts.greetingDelayMs) setTimeout(() => send('220 smtp.test.example ESMTP test'), opts.greetingDelayMs);
    else send('220 smtp.test.example ESMTP test');
  }
  const server = opts.secure
    ? tls.createServer({ key: opts.cert.key, cert: opts.cert.cert }, (s) => handle(s, true))
    : net.createServer((s) => handle(s, false));
  return {
    state, server,
    start: () => listen(server),
    stop: () => { for (const s of state.sockets) s.destroy(); return new Promise((r) => server.close(() => r())); },
  };
}

module.exports = { testCert, imapServer, smtpServer };
