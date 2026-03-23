# GateControl Interactive Demo — Design Spec

**Date:** 2026-03-23
**Scope:** Single HTML file, no dependencies, pixel-accurate GateControl UI mockup with animated walkthrough scenes

## Overview

A self-contained interactive HTML presentation (`demo/index.html`) that replicates GateControl's UI and demonstrates key features through animated walkthroughs. Users click sidebar menu items to trigger automated sequences showing how features work — with simulated cursor movement, typing, clicks, and UI state changes.

## Architecture

Single HTML file (~2000-3000 lines) with embedded CSS + JS. No React, no build step, no external dependencies except Google Fonts. Opens directly in any browser.

## UI Structure

Pixel-accurate recreation of GateControl's layout:

- **Topbar**: Logo "GateControl", pulse-dot "WireGuard Active", host info `demo.example.com`, avatar
- **Sidebar**: Navigation items that serve as demo scene triggers
- **Main Content**: Animated content area where scenes play

### Design Tokens (from actual GateControl CSS)

```
--bg-base:    #f2f0eb
--bg-panel:   #ffffff
--bg-card:    #fdfcf9
--bg-hover:   #f5f3ee
--border:     #e4e0d6
--text-1:     #1c1917
--text-2:     #6b6460
--text-3:     #a8a099
--accent:     #0a6e4f
--green:      #16a34a
--amber:      #b45309
--red:        #dc2626
--blue:       #1d4ed8
--font-ui:    'Outfit', sans-serif
--font-display:'DM Serif Display', serif
--font-mono:  'JetBrains Mono', monospace
```

## Sidebar Menu Items (Scene Triggers)

| Item | Icon | Scene | Badge |
|------|------|-------|-------|
| Peers / Clients | network nodes | Create a peer | Shows peer count after completion |
| Domains / Routes | globe | Create a route | Shows route count after completion |
| Monitoring | heartbeat | Monitoring + Circuit Breaker | — |
| Security | shield/lock | Route Auth + 2FA/TOTP | — |
| Mirroring | split arrows | Request Mirroring | — |

Items start with a subtle pulsing dot indicating "not yet viewed". After completing a scene, the dot disappears and a checkmark appears. Currently-playing scene is highlighted with accent color. Items for scenes that haven't played yet are clickable; completed scenes can be replayed.

## Animation System

### Cursor

SVG cursor element (`position: fixed`) that moves smoothly between targets using CSS `transition` (duration ~400ms, ease-in-out). On click: scale bounce (0.9 → 1.0) + circular ripple at click point (200ms).

### Typing

Characters appear one at a time in input fields at ~60ms intervals with a blinking text cursor. After typing completes, cursor blink stops.

### Timeline Engine

Each scene is defined as an array of step objects:

```javascript
{ action: 'move', target: '#element-id', duration: 400 }
{ action: 'click', target: '#element-id' }
{ action: 'type', target: '#input-id', text: 'nas.example.com', speed: 60 }
{ action: 'wait', duration: 500 }
{ action: 'addClass', target: '#el', class: 'active' }
{ action: 'show', target: '#modal' }
{ action: 'hide', target: '#modal' }
{ action: 'setText', target: '#el', text: 'Online' }
{ action: 'flash', type: 'success', text: 'Peer created successfully' }
```

The engine processes steps sequentially, awaiting each step's completion before starting the next. During playback, sidebar clicks are disabled.

### Transitions

- Modal open: fade-in + scale from 0.95 to 1.0 (200ms)
- Modal close: fade-out + scale to 0.95 (150ms)
- Toggle switch: slide animation (150ms)
- Badge appear: fade-in + slight translateY (200ms)
- Flash message: slide down from top (300ms), auto-dismiss after 2s
- List item appear: fadeUp animation (300ms)

## Scene Definitions

### Scene 1: Peers / Clients

Main content shows the Peers page mockup with an empty peer list and "Add Peer" button.

Steps:
1. Move cursor to "Add Peer" button → click
2. Peer form slides in (name, DNS, keepalive, group fields)
3. Move to Name field → click → type "NAS Zuhause"
4. Move to DNS field → click → type "1.1.1.1, 8.8.8.8"
5. Move to Keepalive field → click → type "25"
6. Move to "Save" button → click
7. Form closes, success flash "Peer created successfully"
8. Peer appears in list: "NAS Zuhause" with IP 10.8.0.2, green "Online" badge
9. QR code icon pulses briefly
10. Wait 1s → scene complete

### Scene 2: Domains / Routes

Main content shows the Routes page mockup with the peer from Scene 1 available.

Steps:
1. Move to "Add Route" button → click
2. Route form appears
3. Move to Domain field → click → type "nas.example.com"
4. DNS check animation: spinner → green checkmark with "DNS OK"
5. Move to Peer dropdown → click → select "NAS Zuhause (10.8.0.2)"
6. Move to Port field → click → type "5001"
7. Move to "HTTPS" toggle → click (turns on)
8. Move to "Backend HTTPS" toggle → click (turns on)
9. Move to "Compression" toggle → click (turns on)
10. Move to "Save & Reload" button → click
11. Form closes, success flash "Route created"
12. Route appears in list: "nas.example.com" → NAS Zuhause (10.8.0.2:5001) with badges: Active, HTTPS, Backend HTTPS, Compress
13. Wait 1s → scene complete

### Scene 3: Monitoring & Circuit Breaker

Main content shows the route card from Scene 2 with an edit button.

Steps:
1. Move to Edit button on route card → click
2. Edit modal opens (simplified version)
3. Move to "Uptime Monitoring" toggle → click (turns on)
4. Move to "Circuit Breaker" toggle → click (turns on)
5. CB Threshold field appears → type "5"
6. CB Timeout field appears → type "30"
7. Move to "Save" button → click
8. Modal closes, badges update: + "Monitoring", status "UP" (green)
9. Wait 2s → simulate outage: "UP" badge changes to "DOWN" (red) with animation
10. Circuit Breaker badge appears: "CB: Open" (red)
11. Wait 2s → recovery: "DOWN" → "UP" (green), "CB: Open" → "CB: Closed" (green)
12. Wait 1s → scene complete

### Scene 4: Security (Route Auth + 2FA)

Main content shows the route card with edit button.

Steps:
1. Move to Edit button → click
2. Edit modal opens
3. Auth type toggle group visible: None / Basic / Route Auth
4. Move to "Route Auth" button → click (selected)
5. Route Auth fields appear: method toggle, email, password
6. Move to "Email & Password" (already selected)
7. Move to Email field → type "admin@example.com"
8. Move to Password field → type "••••••••" (dots)
9. Move to "Two-Factor Authentication" toggle → click (turns on)
10. 2FA options appear, TOTP selected
11. Move to "Save" → click
12. Modal closes, badges update: + "Email & Password", + "2FA: TOTP"
13. Brief flash of a simulated route-auth login page (custom branded)
14. Wait 1s → scene complete

### Scene 5: Request Mirroring

Main content shows the route card with edit button.

Steps:
1. Move to Edit button → click
2. Edit modal opens
3. Scroll to "Request Mirroring" section
4. Move to "Request Mirroring" toggle → click (turns on)
5. Mirror target editor appears (empty)
6. Move to "Add Target" button → click
7. Target row appears with IP + Port fields
8. Move to IP field → type "203.0.113.10"
9. Move to Port field → type "8080"
10. Move to "Add Target" → click (second target)
11. Move to IP field → type "203.0.113.11"
12. Move to Port field → type "9090"
13. Move to "Save" → click
14. Modal closes, new badge: "Mirror: 2 targets" (blue)
15. Wait 1s → scene complete

## Progress Indicator

Bottom of the viewport: thin progress bar (accent color) showing current scene progress (0-100%). Between scenes, bar resets.

Below sidebar: "Click a menu item to start" hint text, changes to "Scene playing..." during animation, and "Click next item to continue" after completion.

## Welcome State

On initial load, main content shows a welcome message:

```
Welcome to GateControl

Click a menu item on the left to start the interactive demo.

Each section demonstrates a key feature with animated walkthroughs.
```

Centered, using DM Serif Display for heading, Outfit for body text.

## Completion State

After all 5 scenes are completed, show a summary:

```
Demo Complete

You've explored all key features of GateControl:
✓ Peer Management
✓ Domain Routing with HTTPS
✓ Uptime Monitoring & Circuit Breaker
✓ Route Authentication & 2FA
✓ Request Mirroring

Ready to get started?
[GitHub] [Documentation]
```

## File Location

`demo/index.html` in the GateControl repository root.

## Not in Scope

- Responsive/mobile layout (desktop-only presentation)
- Dark mode
- Actual functional forms (all UI is decorative/animated)
- Sound effects
- Keyboard navigation
