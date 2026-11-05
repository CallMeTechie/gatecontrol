'use strict';

// What the DNS filter of a home gateway can block (phase 3b, contract §1):
//
//   LISTS       the lists an administrator picks per profile ("Immer
//               sperren"). Only well-known lists that may be used freely,
//               each with its source and licence (shown in the profile
//               dialog). The gateway downloads them itself (HTTPS, daily,
//               ETag) — the server never copies or changes them, it only
//               names the URL. `entries` is the rough size (November 2026)
//               for the memory estimate of the card "Funktionen".
//   CATEGORIES  small lists kept here for the times of a profile ("soziale
//               Netzwerke, Spiele, Videos gesperrt"): the main domains of the
//               big services; a pattern blocks the domain and its subdomains.
//   PROVIDERS   where the gateway forwards the questions (DNS over HTTPS).
//
// Formats (features.dns.lists[].format): 'adblock' = `||domain^` lines (the
// domain and every subdomain), 'hosts' = `0.0.0.0 name` lines (exactly that
// name), 'domains' = one name per line (exactly that name).

const LISTS = Object.freeze([
  {
    id: 'ads',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/light.txt',
    format: 'adblock',
    entries: 78000,
    source: "HaGeZi's Multi LIGHT",
    home: 'https://github.com/hagezi/dns-blocklists',
    license: 'GPL-3.0',
    defaultOn: true,
  },
  {
    id: 'malware',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/tif.mini.txt',
    format: 'adblock',
    entries: 195000,
    source: "HaGeZi's Threat Intelligence Feeds (mini)",
    home: 'https://github.com/hagezi/dns-blocklists',
    license: 'GPL-3.0',
    defaultOn: true,
  },
  {
    id: 'adult',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/nsfw.txt',
    format: 'adblock',
    entries: 92000,
    source: "HaGeZi's NSFW",
    home: 'https://github.com/hagezi/dns-blocklists',
    license: 'GPL-3.0',
    defaultOn: false,
  },
  {
    id: 'gambling',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/gambling.mini.txt',
    format: 'adblock',
    entries: 110000,
    source: "HaGeZi's Gambling (mini)",
    home: 'https://github.com/hagezi/dns-blocklists',
    license: 'GPL-3.0',
    defaultOn: false,
  },
  {
    id: 'ads_stevenblack',
    url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts',
    format: 'hosts',
    entries: 80000,
    source: 'StevenBlack Unified hosts',
    home: 'https://github.com/StevenBlack/hosts',
    license: 'MIT',
    defaultOn: false,
  },
].map((l) => Object.freeze(l)));

const LIST_IDS = Object.freeze(LISTS.map((l) => l.id));

// Small, hand-kept: the domains the apps and players of the big services
// use. Messengers (WhatsApp, Signal, Threema), school portals and
// GateControl are deliberately not in here.
const CATEGORIES = Object.freeze({
  social: Object.freeze([
    'bereal.com', 'bsky.app', 'cdninstagram.com', 'facebook.com', 'facebook.net', 'fbcdn.net', 'fbsbx.com',
    'instagram.com', 'pinimg.com', 'pinterest.com', 'redd.it', 'reddit.com', 'redditmedia.com', 'redditstatic.com',
    'sc-cdn.net', 'snapchat.com', 'snapkit.com', 'threads.net', 'tiktok.com', 'tiktokcdn.com', 'tiktokv.com',
    'tumblr.com', 'twimg.com', 'twitter.com', 'x.com',
  ]),
  games: Object.freeze([
    'battle.net', 'blizzard.com', 'brawlstarsgame.com', 'ea.com', 'epicgames.com', 'fortnite.com', 'leagueoflegends.com',
    'minecraft.net', 'minecraftservices.com', 'mojang.com', 'nintendo.com', 'nintendo.net', 'playstation.com',
    'playstation.net', 'rbxcdn.com', 'riotgames.com', 'roblox.com', 'steamcommunity.com', 'steamcontent.com',
    'steampowered.com', 'steamstatic.com', 'supercell.com', 'xbox.com', 'xboxlive.com',
  ]),
  video: Object.freeze([
    'aiv-cdn.net', 'bamgrid.com', 'dailymotion.com', 'disney-plus.net', 'disneyplus.com', 'dssott.com', 'googlevideo.com',
    'jtvnw.net', 'joyn.de', 'netflix.com', 'nflximg.net', 'nflxso.net', 'nflxvideo.net', 'primevideo.com', 'ttvnw.net',
    'twitch.tv', 'vimeo.com', 'vimeocdn.com', 'youtu.be', 'youtube-nocookie.com', 'youtube.com', 'ytimg.com',
  ]),
});

const CATEGORY_IDS = Object.freeze(Object.keys(CATEGORIES));

// dns0.eu ended its service in 2025: accepted in old data, never offered or sent.
const PROVIDERS = Object.freeze([
  Object.freeze({ id: 'quad9', label: 'Quad9', url: 'https://dns.quad9.net/dns-query', home: 'https://quad9.net' }),
  Object.freeze({ id: 'cloudflare', label: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query', home: 'https://1.1.1.1' }),
  Object.freeze({ id: 'custom', label: null, url: null, home: null }),
]);
const PROVIDER_IDS = Object.freeze(PROVIDERS.map((p) => p.id));

function list(id) { return LISTS.find((l) => l.id === id) || null; }

module.exports = { LISTS, LIST_IDS, CATEGORIES, CATEGORY_IDS, PROVIDERS, PROVIDER_IDS, list };
