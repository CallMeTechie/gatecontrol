# Compression

Komprimiert HTTP-Antworten mit Gzip und Zstd — reduziert die übertragene Datenmenge um 60-80% bei Textinhalten wie HTML, CSS, JavaScript und JSON.

---

## Was macht es?

Compression aktiviert Caddys `encode` Handler, der Antworten vom Backend komprimiert bevor sie an den Client gesendet werden. Der Client signalisiert über den `Accept-Encoding` Header welche Algorithmen er unterstützt.

**Ohne Compression:**
```
Client  ←  500 KB HTML  ←  Caddy  ←  500 KB HTML  ←  Backend
```

**Mit Compression:**
```
Client  ←  120 KB gzip  ←  Caddy (komprimiert)  ←  500 KB HTML  ←  Backend
           76% gespart
```

## Wie funktioniert es technisch?

GateControl fügt den `encode` Handler in die Caddy Handler-Kette ein — **vor** dem Reverse Proxy, damit die Antwort auf dem Rückweg komprimiert wird.

**Caddy JSON-Konfiguration:**
```json
{
  "handler": "encode",
  "encodings": {
    "zstd": {},
    "gzip": {}
  }
}
```

**Algorithmen:**

| Algorithmus | Browser-Support | Kompression | Geschwindigkeit |
|---|---|---|---|
| **Zstd** | Chrome 123+, Firefox 112+ | Besser | Schneller |
| **Gzip** | Alle Browser | Gut | Standard |

**Bevorzugung:** Caddy wählt Zstd wenn der Client es unterstützt (`Accept-Encoding: zstd, gzip`), andernfalls Gzip.

**Handler-Reihenfolge in Caddy:**
1. ACL / Forward Auth (falls aktiv)
2. Custom Request Headers
3. Rate Limiting
4. Request Mirroring (bekommt unkomprimierte Daten)
5. **Compression** ← hier
6. Reverse Proxy

**Ablauf:**
1. Client sendet Anfrage mit `Accept-Encoding: gzip, deflate, br, zstd`
2. Caddy leitet Anfrage an Backend weiter
3. Backend antwortet mit unkomprimiertem Body
4. Encode-Handler komprimiert die Antwort mit dem besten unterstützten Algorithmus
5. Client dekomprimiert automatisch

**Typische Einsparungen:**

| Content-Type | Unkomprimiert | Gzip | Zstd | Einsparung |
|---|---|---|---|---|
| HTML | 100 KB | 25 KB | 20 KB | 75-80% |
| CSS | 200 KB | 35 KB | 28 KB | 82-86% |
| JavaScript | 500 KB | 120 KB | 95 KB | 76-81% |
| JSON | 1 MB | 150 KB | 110 KB | 85-89% |
| PNG (Bild) | 300 KB | 295 KB | 295 KB | ~2% |

## Use Cases

### Web-Applikation beschleunigen

Route `app.example.com` → React/Vue/Angular SPA. Die initialen JavaScript-Bundles sind oft 500 KB-2 MB. Mit Compression werden daraus 100-400 KB — die Seite lädt merklich schneller, besonders auf mobilen Verbindungen.

### API mit großen JSON-Antworten

Route `api.example.com` → REST API die Listen mit 1000+ Einträgen zurückgibt. Ein 2 MB JSON-Response wird auf ~300 KB komprimiert. Spart Bandbreite und beschleunigt die Verarbeitung auf Client-Seite.

### Statische Dateien servieren

Route `docs.example.com` → Dokumentations-Server mit HTML, CSS, JS. Kompression ist hier am effektivsten, da die Dateien bei jedem Aufruf gleich sind und der Kompressionsalgorithmus gut greift.

## Kombination mit anderen Features

| Kombination | Wirkung |
|---|---|
| **Compression + Force HTTPS** | Empfohlen: TLS + Compression für beste Performance und Sicherheit |
| **Compression + Request Mirroring** | Mirror-Targets bekommen unkomprimierte Daten (Mirror kommt vor Encode) |
| **Compression + Rate Limiting** | Kein Konflikt — Rate Limit zählt Anfragen, Compression betrifft Antworten |
| **Compression + Backend HTTPS** | Kein Konflikt — Backend HTTPS betrifft die Upstream-Verbindung, Compression die Downstream-Antwort |

## Einrichtung

### Über die UI

1. Route erstellen oder bearbeiten
2. **Compression** Toggle aktivieren
3. Speichern

Es gibt keine weiteren Optionen — Gzip und Zstd sind automatisch aktiv.

### Über die API

```bash
# Compression aktivieren
curl -X PUT https://gatecontrol.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -H "Content-Type: application/json" \
  -d '{
    "compress_enabled": true
  }'
```

## Wichtige Hinweise

- **Nicht empfohlen für bereits komprimierte Inhalte.** Bilder (JPEG, PNG, WebP), Videos (MP4, WebM), Archive (ZIP, tar.gz) und Schriftarten (WOFF2) sind bereits komprimiert. Compression verschwendet CPU-Zeit und vergrößert sie manchmal sogar minimal.
- Caddy komprimiert nur wenn der Client `Accept-Encoding` sendet. Alte oder spezialisierte HTTP-Clients ohne diesen Header bekommen unkomprimierte Antworten.
- Compression erhöht die CPU-Auslastung auf dem GateControl-Server minimal. Bei sehr hohem Traffic und großen Antworten kann das relevant werden.
- Streaming-Responses (z.B. Server-Sent Events, chunked Transfer) werden ebenfalls komprimiert, können aber höhere Latenz haben da der Encoder auf genügend Daten zum Komprimieren wartet.
- Compression ist nur für HTTP-Routen verfügbar, nicht für L4 (TCP/UDP).
- Wenn das Backend selbst bereits komprimierte Antworten liefert (`Content-Encoding: gzip`), komprimiert Caddy **nicht** doppelt.
