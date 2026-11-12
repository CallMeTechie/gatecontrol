# GateControl – User guide

🇬🇧 **English** | 🇩🇪 [Deutsch](../handbuch/README.md)

This guide explains step by step how to set up the GateControl server and how
to bring gateways into your home network. It is written for people who are not
professionals. All you need is a little patience and the ability to paste
commands into a terminal.

## Chapters

1. [Overview](01-overview.md) – What is the server, what is a gateway, what do you need?
2. [Setting up the server](02-server-setup.md) – installation, `.env`, first login, HTTPS, updates.
3. [Setting up a gateway](03-gateway-setup.md) – the assistant, then Synology, Raspberry Pi, Linux/Docker and Proxmox.
4. [Edge plugins and Smart Home](04-edge-and-smart-home.md) – edge service, MQTT, the status messages and what helps, plugin manuals and setup notices.
5. [Home gateway features](05-features.md) – network watch, internet quality, presence, UPS, DNS filter, DNS protection for VPN devices, home cache.
6. [Updating an existing gateway](06-updating-a-gateway.md) – bring an old compose file up to date.
7. [FAQ and troubleshooting](07-faq.md) – typical messages and how to fix them.

Chapters 3 to 7 (everything about gateways) are also inside GateControl: on
the gateway under “More” → **“Manual”**, with a table of contents. Next to it,
**“Versions”** shows what changed in each gateway version
([3.8](03-gateway-setup.md#38-versions-and-manual)).

## How to read this guide

- Steps are numbered. Do them in order.
- Commands are in grey boxes. You can copy and paste them.
- Every section ends with a **Check:** line. It tells you how to see that everything worked.
- Names in “quotes” are texts from the GateControl interface (for example
  “Add gateway”). Arrows → show the way through the menus. The interface
  language is set per user; this guide quotes the English texts.
- `gate.example.com` stands for your own domain. Replace it everywhere with yours.

## Important: secrets

Some files contain passwords and keys:

- the server's `.env`,
- the `gateway.env` of every gateway,
- the set-up files `gatecontrol-setup.zip` and `gatecontrol-gateway-nas.zip`.

Never pass these files on. Never paste their content into chats, forums or
tickets. If you need help, black out passwords, tokens and keys before you
share logs.

## Further documents

- [INSTALL.md](../../INSTALL.md) – the detailed technical installation guide (backup, migration, details).
- [Guides in the gateway repository](https://github.com/CallMeTechie/gatecontrol-gateway/tree/main/docs/deployment) – technical details per platform.
