# Island Link

A Dynamic Island–style pill for Windows and macOS, plus a WingDeck-style shared pointer: one mouse and keyboard control a Windows PC and a Mac over the local network, with a shared clipboard, file tray, screenshots, smooth scrolling and an optional "turn your head to switch computers" mode.

> Status: working prototype (v1.0.0, not yet released). See `docs/` for the full documentation.

## Features

| Area | What it does |
| --- | --- |
| Pill / island | Hover-to-open pill at the top of the screen (Windows: top-centre; Mac: wraps the notch). Tabs: Anathema (home: now playing, calendar, calibrate), Tray, Link, Settings (gear). Toasts drop out of the pill for connection and calibration events. |
| Shared pointer | Move the cursor off the edge of one computer and it appears on the other. Multi-monitor layout in millimetres (Arrange window), edge resistance, takeback when you touch the other computer's own mouse, game/freelook guard. |
| Keyboard | Typing is forwarded while controlling; Cmd on the Mac maps to Win on the PC and back. |
| Scrolling | Smooth wheel on both computers, with per-device tuning (step, speed, duration), scroll speed and reverse. Ctrl/Shift/Alt/Win + wheel pass through untouched (zoom, sideways scroll). |
| Clipboard | Text and screenshots follow you between computers (opt-out in Settings). |
| File tray | Drop files on the pill to keep them in the tray; drop on the blue Send tile (or drag a chip onto it) to send to the other computer. Clear tray button. |
| Screenshots | Win+Shift+S on the PC while controlling the Mac triggers a Mac region screenshot (and the reverse); the result lands in the shared clipboard. |
| Look to switch | Optional. The webcam tracks head yaw/pitch locally (MediaPipe, no video leaves the computer) and switches control when you turn to the other screen. Calibrated per computer. |
| Diagnostics | Built-in log of crossings, latency, landing error, bursts and takebacks. "Copy diagnostics" in Settings. |

## Requirements

- Windows 10/11 and macOS 12+ on the same LAN (TCP port 47800 must be reachable).
- macOS: grant **Accessibility** and **Input Monitoring** (and Camera if you use Look to switch).
- Node.js 20+ for development.

## Run (development)

```bash
cd E:\Projects\island-link
npm install
npm start
```

Do **not** run `npm start` from `E:\Projects`; `package.json` lives in `island-link`.

Pairing: the first time, type the other computer's IP and the 6-digit code shown in its Link tab. After that the computer appears under Recent devices and reconnects without a code.

Tests: `npm test`.

## Documentation

- `docs/ARSITEKTUR.md` – modules, protocol, state machine, per-platform details, hard-won lessons (Indonesian).
- `docs/PANDUAN-DEVELOPER.md` – how to run, deploy to the Mac, restart safely, debug, test (Indonesian).
- `docs/KOMERSIAL.md` – licences, security gaps, packaging and a proposed business model (Indonesian).
- `docs/INSTALASI.md` – install from GitHub Releases (Windows .exe, macOS .dmg), pairing, how to cut a release (Indonesian).
- `docs/CHANGELOG.md` – what was built, in order (Indonesian).
- `Referensi/` – reference projects (ideas only, no code copied): LittleBigMouse (GPL-3.0), Mos (CC BY-NC 4.0).
