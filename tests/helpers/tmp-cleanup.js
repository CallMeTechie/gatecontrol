'use strict';

// Wird über --require aus dem test-Skript in JEDEN Testprozess vorgeladen.
//
// Hintergrund: 59 von 70 Testdateien legen mit fs.mkdtempSync ein Verzeichnis
// unter os.tmpdir() an und entfernen es nie. Jeder Suite-Lauf hinterlässt so
// hunderte Verzeichnisse; nach genügend Läufen ist /tmp voll — und das äußert
// sich in Symptomen, die nichts mit Tests zu tun haben (ENOSPC in beliebigen
// anderen Kommandos, bis hin zu Prozessen, die ihre Ausgabe nicht mehr
// schreiben können).
//
// Statt 59 Dateien einzeln nachzurüsten — und die nächste neue Datei wieder zu
// vergessen — wird mkdtempSync hier einmal umhüllt und beim Prozessende
// geräumt. Neue Tests sind damit automatisch abgedeckt, ohne dass jemand daran
// denken muss.
//
// Bewusst NUR im Testlauf aktiv: das Modul wird ausschließlich über das
// test-Skript vorgeladen, der Produktivcode ruft mkdtempSync nirgends auf.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const created = new Set();
const realMkdtempSync = fs.mkdtempSync;

// Einmal auflösen: unter macOS ist /tmp ein Symlink auf /private/tmp, ein
// naiver Präfixvergleich würde dort nie greifen.
let tmpRoot;
try {
  tmpRoot = fs.realpathSync(os.tmpdir());
} catch {
  tmpRoot = os.tmpdir();
}

fs.mkdtempSync = function mkdtempSync(prefix, ...rest) {
  const dir = realMkdtempSync.call(this, prefix, ...rest);
  try {
    // Nur aufräumen, was wirklich unterhalb des Temp-Wurzelverzeichnisses
    // liegt. Ein Test, der bewusst woandershin schreibt, bleibt unangetastet.
    const resolved = fs.realpathSync(dir);
    if (resolved.startsWith(tmpRoot + path.sep)) created.add(resolved);
  } catch {
    // Verzeichnis schon weg oder nicht auflösbar — dann gibt es nichts zu tun.
  }
  return dir;
};

process.on('exit', () => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Aufräumen darf einen Testlauf niemals scheitern lassen.
    }
  }
});

module.exports = { _created: created };
