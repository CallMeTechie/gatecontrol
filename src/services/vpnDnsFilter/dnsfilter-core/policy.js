'use strict';

// Entscheidung je Anfrage (Vertrag Phase 3b §1.1/§1.2): Profil per MAC,
// Pausen, Ausnahmen, Zeiten, Listen, sichere Suche.
//
// „MAC“ ist hier nur ein Schlüssel für den Client: Das Gateway nimmt die
// MAC-Adresse, andere Nutzer der Engine beliebige Texte (z. B. eine
// Peer-Kennung). Neben `macs` wird deshalb gleichbedeutend `clients` gelesen.
//
// Reihenfolge:
//   1. lokale Namen (fritz.box, *.local, Rückwärtszonen privater Netze …) → Router, nie gefiltert
//   2. alwaysAllow (Server-Host u. ä.)                                     → erlaubt
//   3. Profil-allow                                                        → erlaubt (auch in Pause/Zeit)
//   4. Pause der MAC                                                       → gesperrt
//   5. Profil-deny                                                         → gesperrt
//   6. aktive Zeiten (außer Verlängerung der MAC; allowAlways der Zeit)    → gesperrt
//   7. Listen des Profils (Adblock-Ausnahmen einer Liste heben deren Sperre auf)
//   8. sonst erlaubt (ggf. mit sicherer Suche)
// Ortszeit = Prozess-Zeitzone (TZ bzw. features.timezone).

const { PatternSet, suffixes, hash53 } = require('./domainSet');
const { safeSearchTarget } = require('./safeSearch');

const CANARY = 'use-application-dns.net'; // Firefox: kein eigenes DoH, wenn hier NXDOMAIN kommt
const LOCAL_SUFFIXES = ['local', 'lan', 'home', 'home.arpa', 'internal', 'localdomain', 'localhost', 'fritz.box', 'speedport.ip', 'box.lan'];
const PRIVATE_REVERSE = [
  '10.in-addr.arpa', '168.192.in-addr.arpa', '254.169.in-addr.arpa',
  ...Array.from({ length: 16 }, (_, i) => `${16 + i}.172.in-addr.arpa`),
  'd.f.ip6.arpa', 'c.f.ip6.arpa', '8.e.f.ip6.arpa', '9.e.f.ip6.arpa', 'a.e.f.ip6.arpa', 'b.e.f.ip6.arpa',
];

/** Ist die Zeit-Regel `s` zum Zeitpunkt `date` (Ortszeit) aktiv? Über Mitternacht: Start-Tag zählt. */
function scheduleActive(s, date) {
  const wd = date.getDay();
  const iso = wd === 0 ? 7 : wd;
  const prev = iso === 1 ? 7 : iso - 1;
  const m = date.getHours() * 60 + date.getMinutes();
  const days = s.daySet || new Set(s.days);
  if (s.from === s.to) return days.has(iso);
  if (s.from < s.to) return days.has(iso) && m >= s.from && m < s.to;
  return (days.has(iso) && m >= s.from) || (days.has(prev) && m < s.to);
}

/** Client-Schlüssel eines Profils bzw. einer Pause/Verlängerung: `macs` und/oder `clients`. */
function clientKeys(e) {
  return e.clients ? [...(e.macs || []), ...e.clients] : e.macs;
}

function untilMap(entries) {
  const m = new Map();
  for (const e of entries) for (const mac of clientKeys(e)) m.set(mac, Math.max(m.get(mac) || 0, e.until));
  return m;
}

class Policy {
  /**
   * @param cfg normalisierte features.dns
   * @param lists Map(listId → CompactList) (geladene Listen)
   * @param extraAllow zusätzliche immer erlaubte Muster (Server-Host)
   * @param localSuffixes zusätzliche lokale Suffixe (Suchdomänen aus resolv.conf)
   */
  constructor(cfg, { lists = new Map(), extraAllow = [], localSuffixes = [] } = {}) {
    this.cfg = cfg;
    this.lists = lists;
    this.alwaysAllow = new PatternSet([...cfg.alwaysAllow, ...extraAllow]);
    this.local = new PatternSet([...LOCAL_SUFFIXES, ...PRIVATE_REVERSE, ...localSuffixes].filter(Boolean).map((s) => s.replace(/^\./, '')));
    // cleanDomain verlangt einen Punkt – einzelne Labels (local, lan …) direkt eintragen
    for (const s of [...LOCAL_SUFFIXES, ...localSuffixes]) if (s && !s.includes('.')) this.local.incl.add(s.toLowerCase());
    this.categories = new Map(Object.entries(cfg.categories).map(([k, v]) => [k, new PatternSet(v)]));
    this.profiles = new Map();
    this.byMac = new Map();
    for (const p of cfg.profiles) {
      const prof = {
        ...p,
        allowSet: new PatternSet(p.allow),
        denySet: new PatternSet(p.deny),
        schedules: p.schedules.map((s) => ({ ...s, daySet: new Set(s.days), allowSet: new PatternSet(s.allowAlways) })),
      };
      this.profiles.set(p.id, prof);
      for (const mac of clientKeys(p)) if (!this.byMac.has(mac)) this.byMac.set(mac, prof);
    }
    this.defaultProfile = cfg.defaultProfile ? this.profiles.get(cfg.defaultProfile) || null : null;
    this.pauses = untilMap(cfg.pauses);
    this.extensions = untilMap(cfg.extensions);
  }

  profileFor(mac) {
    return (mac && this.byMac.get(mac)) || this.defaultProfile;
  }

  isLocal(name) {
    return name === '' || !name.includes('.') || this.local.matches(name);
  }

  pausedUntil(mac, now) {
    const u = mac ? this.pauses.get(mac) : undefined;
    return u && u > now ? u : null;
  }

  extendedUntil(mac, now) {
    const u = mac ? this.extensions.get(mac) : undefined;
    return u && u > now ? u : null;
  }

  /**
   * → { profileId, action: 'allow'|'block', reason, list?, category?, safeSearch?, local?, nxdomain? }
   */
  decide(name, mac, now = Date.now()) {
    const profile = this.profileFor(mac);
    const profileId = profile ? profile.id : null;
    const res = (action, reason, extra) => ({ profileId, action, reason, ...extra });
    if (name === CANARY) return res('block', 'canary', { nxdomain: true });
    if (this.isLocal(name)) return res('allow', 'local', { local: true });
    if (this.alwaysAllow.matches(name)) return res('allow', 'always_allow');
    const safe = profile && profile.safeSearch ? safeSearchTarget(name) : null;
    const allow = (reason) => res('allow', reason, safe ? { safeSearch: safe } : undefined);
    if (profile && profile.allowSet.matches(name)) return allow('profile_allow');
    if (this.pausedUntil(mac, now)) return res('block', 'paused');
    if (!profile) return res('allow', 'no_profile');
    if (profile.denySet.matches(name)) return res('block', 'profile_deny');
    if (profile.schedules.length && !this.extendedUntil(mac, now)) {
      const date = new Date(now);
      for (const s of profile.schedules) {
        if (!scheduleActive(s, date) || s.allowSet.matches(name)) continue;
        if (s.block === 'all') return res('block', 'schedule');
        for (const c of s.categories) {
          const set = this.categories.get(c);
          if (set && set.matches(name)) return res('block', 'schedule_category', { category: c });
        }
      }
    }
    if (profile.lists.length) {
      let h = null;
      for (const id of profile.lists) {
        const l = this.lists.get(id);
        if (!l) continue;
        if (!h) h = suffixes(name).map(hash53);
        if (l.matchHashes(h)) return res('block', 'list', { list: id });
      }
    }
    return allow('default');
  }

  /** Nächste aktive/anstehende Zeit-Regel eines Profils (für Diagnose). */
  activeSchedules(profileId, now = Date.now()) {
    const p = this.profiles.get(profileId);
    if (!p) return [];
    const d = new Date(now);
    return p.schedules.filter((s) => scheduleActive(s, d)).map(({ days, from, to, block, categories }) => ({ days, from, to, block, categories }));
  }
}

module.exports = { Policy, scheduleActive, CANARY, LOCAL_SUFFIXES };
