# GateControl – Handbuch

🇩🇪 **Deutsch** | 🇬🇧 [English](../guide/README.md)

Dieses Handbuch erklärt Schritt für Schritt, wie du den GateControl-Server
einrichtest und wie du Gateways in dein Heimnetz bringst. Es ist für Menschen
geschrieben, die keine Profis sind. Du brauchst nur etwas Geduld und die
Möglichkeit, Befehle in ein Terminal zu kopieren.

## Kapitel

1. [Überblick](01-ueberblick.md) – Was ist der Server, was ist ein Gateway, was brauchst du?
2. [Server einrichten](02-server-einrichten.md) – Installation, `.env`, erster Login, HTTPS, Updates.
3. [Gateway einrichten](03-gateway-einrichten.md) – der Assistent, dann Synology, Raspberry Pi, Linux/Docker und Proxmox.
4. [Edge-Plugins und Smart Home](04-edge-und-smart-home.md) – Edge-Dienst, MQTT, die Statusmeldungen und was hilft, Handbuch und Einrichtungshinweise der Plugins.
5. [Funktionen der Heim-Gateways](05-funktionen.md) – Netzwerk-Wächter, Internetqualität, Anwesenheit, USV, DNS-Filter, DNS-Schutz für VPN-Geräte, Zwischenspeicher.
6. [Bestehendes Gateway aktualisieren](06-gateway-aktualisieren.md) – alte Compose-Datei auf den aktuellen Stand bringen.
7. [FAQ und Fehlerbehebung](07-faq.md) – typische Meldungen und ihre Lösung.

Die Kapitel 3 bis 7 (alles rund um die Gateways) findest du auch direkt in
GateControl: im Gateway unter „Mehr“ → **„Handbuch“**, mit
Inhaltsverzeichnis. Daneben zeigt **„Versionen“**, was sich in jeder
Gateway-Version geändert hat ([3.8](03-gateway-einrichten.md#38-versionen-und-handbuch)).

## So liest du dieses Handbuch

- Die Schritte sind nummeriert. Mach sie der Reihe nach.
- Befehle stehen in grauen Kästen. Du kannst sie kopieren und einfügen.
- Nach jedem Abschnitt steht eine Zeile **Prüfen:**. Sie sagt dir, woran du
  erkennst, dass alles geklappt hat.
- Namen in „Anführungszeichen“ sind Texte aus der GateControl-Oberfläche
  (zum Beispiel „Gateway hinzufügen“). Pfeile → zeigen den Weg durch die Menüs.
- `gate.example.com` steht für deine eigene Domain. Ersetze sie überall durch deine.

## Wichtig: Geheimnisse

Einige Dateien enthalten Passwörter und Schlüssel:

- die `.env` des Servers,
- die `gateway.env` jedes Gateways,
- die Einrichtungsdateien `gatecontrol-setup.zip` und `gatecontrol-gateway-nas.zip`.

Gib diese Dateien nie weiter. Kopiere ihren Inhalt nie in Chats, Foren oder
Tickets. Wenn du Hilfe brauchst, schwärze Passwörter, Tokens und Schlüssel,
bevor du Protokolle teilst.

## Weitere Dokumente

- [INSTALL.de.md](../../INSTALL.de.md) – die ausführliche technische Installationsanleitung (Backup, Migration, Details).
- [Anleitungen im Gateway-Repository](https://github.com/CallMeTechie/gatecontrol-gateway/tree/main/docs/deployment) – technische Einzelheiten je Plattform.
