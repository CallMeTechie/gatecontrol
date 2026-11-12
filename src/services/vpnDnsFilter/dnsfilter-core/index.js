'use strict';

// DNS-Filter-Engine: Listen, Matching, Profile, Zeiten/Pausen, sichere Suche,
// Wire-Format, Weiterleitung, Zähler. In sich geschlossen (nur node:-Module),
// siehe VENDORED.md – der GateControl-Server führt eine Kopie dieses
// Verzeichnisses.

const wire = require('./wire');
const { cleanDomain, hash53, suffixes, PatternSet, HashBuilder, CompactList } = require('./domainSet');
const { parseListText, parseListStream, countLines, ListTooLarge } = require('./listParser');
const { ListManager, fetchList, FetchError } = require('./lists');
const { Policy, scheduleActive, CANARY, LOCAL_SUFFIXES } = require('./policy');
const { safeSearchTarget } = require('./safeSearch');
const { Resolver, MAX_LOG, isLoopback } = require('./resolver');
const { ResponseCache } = require('./responseCache');
const { DohClient, Upstream, UpstreamError, udpQuery, tcpQuery, routerQuery, PROVIDERS } = require('./upstream');
const { DnsListener } = require('./listener');
const { DnsStats } = require('./stats');

module.exports = {
  wire,
  cleanDomain, hash53, suffixes, PatternSet, HashBuilder, CompactList,
  parseListText, parseListStream, countLines, ListTooLarge,
  ListManager, fetchList, FetchError,
  Policy, scheduleActive, CANARY, LOCAL_SUFFIXES, safeSearchTarget,
  Resolver, MAX_LOG, isLoopback, ResponseCache,
  DohClient, Upstream, UpstreamError, udpQuery, tcpQuery, routerQuery, PROVIDERS,
  DnsListener, DnsStats,
};
