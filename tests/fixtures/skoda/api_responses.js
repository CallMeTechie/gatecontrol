'use strict';
// Shapes per the python-myskoda reference models. Replace with redacted live
// captures after the Task-3 spike where they deviate.
module.exports = {
  garage: {
    vehicles: [{
      vin: 'TMBTESTVIN000001', name: 'Elroq', title: 'Škoda Elroq',
      specification: { model: 'Elroq', modelYear: '2025' },
      compositeRenders: [{ layers: [{ url: 'https://ip-modcwp.azureedge.net/render1.png', viewPoint: 'EXTERIOR_FRONT' }] }],
    }],
  },
  status: {
    carCapturedTimestamp: '2026-07-22T08:00:00Z',
    overall: { locked: 'YES', doors: 'CLOSED', windows: 'CLOSED', lights: 'OFF' },
    detail: { bonnet: 'CLOSED', trunk: 'CLOSED', sunroof: 'UNSUPPORTED' },
  },
  drivingRange: {
    carType: 'ELECTRIC',
    totalRangeInKm: 310,
    primaryEngineRange: { engineType: 'ELECTRIC', currentSoCInPercent: 74, remainingRangeInKm: 310 },
  },
  charging: {
    status: {
      state: 'CHARGING',
      chargePowerInKw: 10.5,
      remainingTimeToFullyChargedInMinutes: 95,
      battery: { stateOfChargeInPercent: 74, remainingCruisingRangeInMeters: 310000 },
    },
    settings: { targetStateOfChargeInPercent: 80, chargingCareMode: 'ACTIVATED' },
    isVehicleInSavedLocation: false, plug: { connectionState: 'CONNECTED' },
  },
  airConditioning: {
    state: 'OFF',
    targetTemperature: { temperatureValue: 22, unitInCar: 'CELSIUS' },
    estimatedDateTimeToReachTargetTemperature: null,
    windowHeatingState: { front: 'OFF', rear: 'OFF' },
  },
  positions: {
    positions: [{ type: 'VEHICLE', gpsCoordinates: { latitude: 51.0, longitude: 7.0 } }],
    errors: [],
  },
  health: { capturedAt: '2026-07-22T08:00:00Z', mileageInKm: 5210, warningLights: [] },
  maintenance: {
    maintenanceReport: { inspectionDueInDays: 210, inspectionDueInKm: 24790 },
    preferredServicePartner: { name: 'Autohaus Test GmbH' },
  },
};
