# 1. Überblick

[← Inhaltsverzeichnis](README.md) · [Weiter: Server einrichten →](02-server-einrichten.md)

## Was ist der GateControl-Server?

Der Server ist das Herz von GateControl. Er läuft als Docker-Container auf
einem Rechner mit öffentlicher Adresse im Internet, zum Beispiel einem
gemieteten vServer. Der Server bringt mit:

- eine **Weboberfläche** zum Verwalten (im Browser unter deiner Domain),
- ein **VPN** (WireGuard) für deine Geräte und Gateways,
- einen **Reverse Proxy** (Caddy), der deine Dienste unter eigenen Domains mit
  HTTPS erreichbar macht. Die Zertifikate holt er automatisch.

## Was ist ein Gateway?

Ein Gateway ist ein kleines Programm in deinem Heimnetz. Es läuft auf einem
Raspberry Pi, einer Synology NAS, unter Proxmox oder auf einem anderen
Linux-Rechner mit Docker.

Das Gateway baut selbst einen verschlüsselten Tunnel zum Server auf. Deshalb
brauchst du **keine Portfreigabe im Router**. Über diesen Tunnel erreicht der
Server die Geräte in deinem Heimnetz – zum Beispiel NAS, Kamera oder Phoscon.

Das Gateway muss im **selben Netz** stehen wie die Geräte, die es erreichen soll.

Zusätzlich kann ein Gateway Aufgaben im Heimnetz übernehmen: Geräte finden,
die Internetqualität messen, Werbung filtern (DNS-Filter), Dateien
zwischenspeichern und Teile von Plugins ausführen (Edge-Plugins). Das erklären
[Kapitel 4](04-edge-und-smart-home.md) und [Kapitel 5](05-funktionen.md).

## Wie hängt alles zusammen?

Ein Bild in Worten:

```
  Handy unterwegs                        Internet
        │
        │  https://nas.example.com
        ▼
  ┌───────────────────────────┐
  │ GateControl-Server        │   öffentliche Adresse, z. B. gate.example.com
  │ Weboberfläche · VPN ·     │   Ports 80, 443 (TCP) und 51820 (UDP)
  │ Reverse Proxy             │
  └─────────────▲─────────────┘
                │  verschlüsselter WireGuard-Tunnel
                │  (vom Gateway aufgebaut – keine Portfreigabe zu Hause)
  ┌─────────────┴─────────────┐
  │ Gateway (Pi, NAS, Linux)  │   in deinem Heimnetz
  └──┬──────────┬──────────┬──┘
     ▼          ▼          ▼
    NAS      Kamera    Smart-Home-Geräte
```

1. Du rufst unterwegs `https://nas.example.com` auf.
2. Der Server nimmt die Anfrage an und schickt sie durch den Tunnel zum Gateway.
3. Das Gateway reicht sie an die NAS in deinem Heimnetz weiter.
4. Die Antwort nimmt denselben Weg zurück.

## Was brauchst du?

### Für den Server

| Was | Wofür |
|---|---|
| Ein Linux-Server mit Root-Zugang (z. B. Debian 12/13 oder Ubuntu 22.04+) | Darauf läuft GateControl. Mindestens 1 CPU und 1 GB RAM, besser 2 CPU und 2 GB RAM, 20 GB Platte. |
| Eine **öffentliche IPv4-Adresse** | Damit Gateways und Geräte den Server erreichen. |
| Eine **Domain** mit einem DNS-Eintrag (A-Record) auf diese Adresse | Für die Weboberfläche und das HTTPS-Zertifikat, z. B. `gate.example.com`. |
| Offene Ports in der Firewall des Anbieters | 80/TCP und 443/TCP (Web und Zertifikate), 51820/UDP (VPN). 443/UDP ist optional (HTTP/3). |
| Docker mit Docker Compose | Das Installationsskript richtet Docker selbst ein, wenn es fehlt. |

### Für jedes Gateway

| Was | Wofür |
|---|---|
| Ein Gerät im Heimnetz: Raspberry Pi (3 B+, 4, 5, Zero 2 W), Synology NAS mit DSM 7.2+, Proxmox VE 8+ oder ein Linux-Rechner mit Docker | Darauf läuft das Gateway. |
| Internetzugang ins Internet hinaus | Das Gateway verbindet sich selbst mit dem Server. Eingehend ist nichts nötig. |
| Es steht im selben Netz wie deine Geräte | Sonst erreicht es sie nicht. |

## Wichtige Begriffe

| Begriff | Bedeutung |
|---|---|
| Peer | Ein Gerät im VPN (Laptop, Handy, Gateway). |
| Route | Eine Domain, die der Server an ein Ziel weiterleitet (z. B. `nas.example.com` → NAS hinter einem Gateway). |
| `.env` | Die Einstellungsdatei des Servers. Enthält Passwörter und Schlüssel. |
| `gateway.env` | Die Zugangsdatei eines Gateways. Enthält seinen Schlüssel für den Tunnel. |
| Compose-Datei | `docker-compose.yml`: beschreibt, welche Container laufen. |
| Edge | Ein abgeschotteter Zusatz-Container auf dem Gateway für Plugin-Teile im Heimnetz. |

**Prüfen:** Du hast einen Server mit öffentlicher IP, eine Domain und ein Gerät
für das Gateway im Heimnetz. Dann geht es weiter mit [Kapitel 2](02-server-einrichten.md).
