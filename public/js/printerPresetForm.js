'use strict';

// Pure assembler: turns the wizard's flat formState into the request body that
// POST /api/v1/printer-presets expects. Kept dependency-free so both the browser
// (loaded as a <script>, exposes window.buildPresetBody) and node (the unit test,
// via the module.exports footer) can use the exact same logic.
//
// formState shape:
//   near_peer_id   (int)  gateway peer on the printer LAN
//   printer_ip     (str)  printer IPv4
//   name           (str)
//   ports          (obj)  { 9100: true, 631: false }  → print_ports = keys whose value is truthy
//   ewsOn          (bool) + ewsDomain (str)
//   scanOn         (bool) + vip (str), vipPrefix (int, default 24)
//   scanTargetMode 'new' | 'existing'
//     mode 'new'      → nasIp (str), nasPeerId (int)
//     mode 'existing' → routeId (int)
function buildPresetBody(formState) {
  var s = formState || {};
  var ports = s.ports || {};
  // Preserve the wizard's offered order (9100 before 631); JS auto-sorts numeric
  // object keys ascending, which would otherwise flip [9100, 631] → [631, 9100].
  var PRINT_PORT_ORDER = [9100, 631];
  var ordered = PRINT_PORT_ORDER.slice();
  Object.keys(ports).forEach(function (p) {
    var n = parseInt(p, 10);
    if (Number.isFinite(n) && ordered.indexOf(n) === -1) ordered.push(n);
  });
  var print_ports = ordered.filter(function (p) { return ports[p]; });

  var ews = null;
  if (s.ewsOn) {
    ews = { enabled: true, domain: s.ewsDomain || '' };
  }

  var scan = null;
  if (s.scanOn) {
    var target;
    if (s.scanTargetMode === 'existing') {
      target = { mode: 'existing', route_id: s.routeId };
    } else {
      target = { mode: 'new', nas_ip: s.nasIp, nas_peer_id: s.nasPeerId };
    }
    scan = {
      enabled: true,
      vip_ip: s.vip,
      vip_prefix: s.vipPrefix || 24,
      target: target,
    };
  }

  return {
    near_peer_id: s.near_peer_id,
    printer_ip: s.printer_ip,
    name: s.name,
    print_ports: print_ports,
    ews: ews,
    scan: scan,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildPresetBody };
} else if (typeof window !== 'undefined') {
  window.buildPresetBody = buildPresetBody;
}
