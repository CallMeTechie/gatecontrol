<!-- version: 1.6.0 -->
# Handbuch-Demo

## Was das Plugin kann

Zeigt Bilder deiner **Kameras** im Portal. Mehr dazu unter [Kameras einrichten](#kameras-einrichten)
und auf der [Website](https://callmetechie.de/docs).

## Voraussetzungen

- GateControl 1.241.0 oder neuer
- ein Gateway ab 1.28.0

## Kameras einrichten

1. In GateControl: Gateways › Funktionen › Kameras einschalten.
2. `docker-compose.yml` herunterladen und das Projekt neu erstellen:

```bash
sudo docker compose up -d
```

> **Hinweis:** Ohne den Dienst `kameras` gibt es kein Live-Bild.

### Kamera-Einstellungen

| Einstellung | Wert |
|-------------|:----:|
| ONVIF       | an   |
| Benutzer    | gatecontrol |

<script>alert('xss')</script>

## Häufige Fragen

[Nicht erlaubt](javascript:alert(1)) bleibt Text.

## Neu in 1.6.0

- Kameras im Heimnetz
