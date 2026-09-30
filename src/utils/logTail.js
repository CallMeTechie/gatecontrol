'use strict';

/**
 * Inkrementelles, asynchrones Lesen einer wachsenden Logdatei (Caddy
 * access.log). Merkt sich Offset und Inode und liest pro Aufruf nur die seit
 * dem letzten Aufruf angehängten Bytes — ohne den Event-Loop zu blockieren.
 *
 *   - Rotation (andere Inode) oder Kürzung (Größe < Offset) → von vorn.
 *   - Eine unvollständige letzte Zeile wird bis zum nächsten Aufruf
 *     zurückgehalten und dann mit dem Rest zusammengesetzt.
 */

const fsp = require('node:fs/promises');

const CHUNK_BYTES = 1024 * 1024;
const MAX_PARTIAL_BYTES = 1024 * 1024;

function createLogTail(file, { chunkBytes = CHUNK_BYTES, maxPartialBytes = MAX_PARTIAL_BYTES } = {}) {
  const state = { ino: null, offset: 0, partial: Buffer.alloc(0) };

  function reset() {
    state.ino = null; state.offset = 0; state.partial = Buffer.alloc(0);
  }

  /**
   * Liest die neuen, vollständigen Zeilen (ohne Leerzeilen).
   * Fehlt die Datei, kommt [] zurück und der Zustand wird zurückgesetzt.
   */
  async function readNewLines() {
    let fh;
    try { fh = await fsp.open(file, 'r'); } catch (err) {
      if (err.code === 'ENOENT') { reset(); return []; }
      throw err;
    }
    try {
      const st = await fh.stat();
      if (state.ino !== null && (st.ino !== state.ino || st.size < state.offset)) {
        state.offset = 0; state.partial = Buffer.alloc(0);
      }
      state.ino = st.ino;
      if (st.size <= state.offset) return [];

      const bufs = [];
      const buf = Buffer.allocUnsafe(Math.min(chunkBytes, st.size - state.offset));
      while (state.offset < st.size) {
        const len = Math.min(buf.length, st.size - state.offset);
        const { bytesRead } = await fh.read(buf, 0, len, state.offset);
        if (bytesRead === 0) break;
        bufs.push(Buffer.from(buf.subarray(0, bytesRead)));
        state.offset += bytesRead;
      }
      // Auf Byte-Ebene an der letzten Zeilengrenze trennen, damit kein
      // UTF-8-Zeichen zerbricht; der Rest der letzten Zeile wartet.
      const data = Buffer.concat([state.partial, ...bufs]);
      const nl = data.lastIndexOf(0x0a);
      state.partial = Buffer.from(nl === -1 ? data : data.subarray(nl + 1));
      // Eine einzelne Zeile ist nie so lang — verlorene Synchronität darf
      // nicht unbegrenzt wachsen.
      if (state.partial.length > maxPartialBytes) state.partial = Buffer.alloc(0);
      if (nl === -1) return [];
      const lines = data.subarray(0, nl).toString('utf8').split('\n');
      return lines.filter(Boolean);
    } finally {
      await fh.close();
    }
  }

  return { readNewLines, reset, state };
}

module.exports = { createLogTail };
