'use strict';
// Aus Task-0-Live-Spike gegen das echte Gateway ermittelt (Phoscon 2.24.2 / apiversion 1.16.0).
// Beleg + rohe HTTP-Traces: docs/superpowers/specs/2026-06-30-smarthome-tp3-spike.md.

// deCONZ-buttonevent-Kodierung (live über RWL021 + lumi.sensor_switch verifiziert):
//   buttonevent = button * 1000 + actionOffset
const buttonActionOffset = { press: 0, hold: 1, short: 2, long: 3, double: 4 };

// Beobachtete Modelle. `hasDouble` gated die UI (RWL021 = Hue-Dimmer ohne Doppelklick).
const buttonModels = {
  RWL021: { buttons: [1, 2, 3, 4], hasDouble: false }, // Hue 4-Tasten-Dimmer
  'lumi.sensor_switch': { buttons: [1], hasDouble: true }, // Aqara Einzeltaste (1002/1003/1004)
};

module.exports = {
  buttonActionOffset,
  buttonModels,
  // Liefert den buttonevent-Code für (modelid, button, action) oder null bei unbekannter Aktion.
  // modelid dient nur der UI-Gating-Info; der Code folgt der einheitlichen Formel (Spike Step 2).
  buttonCode(modelid, button, action) {
    const off = buttonActionOffset[action];
    if (off == null) return null;
    const b = Number(button);
    return (Number.isInteger(b) && b > 0 ? b : 1) * 1000 + off;
  },

  // Daylight-Trigger auf dem booleschen `daylight`-Feld des Daylight-Sensors (Spike Step 3):
  // sunrise → daylight wird true, sunset → daylight wird false. Kantengetriggert über lastupdated dx
  // (fügt die Übersetzung hinzu). Binär-invertierbar → cancel-tauglich.
  daylight: {
    sunrise: { field: 'daylight', op: 'eq', value: 'true' },
    sunset: { field: 'daylight', op: 'eq', value: 'false' },
  },

  // Spike Step 5: eine Regel kann ein Schedule via Action an-/abschalten und ein CLIP-Flag setzen →
  // sauberes Storno bestätigt. CLIP-Sensoren sind per DELETE /sensors/:id löschbar.
  cancelSupported: true,
  clipDeletable: true,

  // Spike Step 4: Schedule-command.address MUSS mit /api/<apiKey> prefixiert sein (Rule-Actions NICHT).
  // Der Service injiziert das Präfix beim Materialisieren des Schedule-Objekts.
  scheduleCommandNeedsApiPrefix: true,

  // Spike Step 6: Limit nicht provoziert (28 Regeln, weit darunter; /config meldet keine Kapazität).
  // errorCodes deckt beide Meldeformen ab — HTTP-Status UND 200-Body-Error-Array (DECONZ_ERR_<type>).
  ruleLimit: { warnAtGcRules: 38 /* =150/4 */, errorCodes: ['DECONZ_HTTP_503', 'DECONZ_HTTP_507', 'DECONZ_ERR_601'] },
};
