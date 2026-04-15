# MTC-1 Controller

Node.js controller for the Fostex MTC-1 SMPTE sync interface.
Controls the MTC-1 via MIDI, with a browser web UI (tablet-friendly)
and optional Stream Deck MK2 hardware surface.

## Requirements

- Node.js v18 or later — https://nodejs.org
- npm (comes with Node)
- Emagic MT4 (or any USB MIDI interface) connected
- Fostex MTC-1 connected to MT4 MIDI OUT 3 / MIDI IN 1

## Install

```bash
cd mtc1-controller
npm install
```

## Run

```bash
node server.js
```

Then open **http://localhost:3000** in any browser.
Also accessible from a tablet on the same Wi-Fi network at the IP printed in the terminal.

## Stream Deck

Connect the Stream Deck MK2 before running `node server.js`.
The server detects it automatically — no extra config needed.

Button layout (Stream Deck MK2, 5×3):

```
[ Sys Reset ] [ MTC Out ON ] [ MTC Out OFF ] [ Chase ON ] [ Chase OFF ]
[    Play   ] [    Stop    ] [    Record   ] [ Startup  ] [  RX TC   ]
[   TRK 1  ] [   TRK 2   ] [    TRK 3   ] [  TRK 4  ] [  TRK 5-8 ]
```

## Session Startup Sequence

Each power cycle of the MTC-1 requires this sequence:
1. System Reset (0xFF) — returns MTC-1 to defaults
2. MTC Output ON — enables MTC on MIDI OUT (off by default!)
3. Chase SMPTE ON — enables tape chase mode

The **Full Session Startup** button does all three automatically.

## MIDI Port Setup

| MT4 Port       | Connected to       | Role                        |
|----------------|--------------------|-----------------------------|
| MT4 MIDI OUT 3 | MTC-1 MIDI IN      | Commands from controller    |
| MT4 MIDI IN 1  | MTC-1 MIDI OUT     | MTC timecode back to DAW    |

In the web UI:
- **MTC-1 OUT** = select MT4 MIDI OUT 3 (sends commands to MTC-1)
- **MTC-1 IN**  = select MT4 MIDI IN 1  (receives MTC from MTC-1)

## Command Reference (Corrected — from session log + manual)

| Command         | SHIFT note | NORMAL note |
|-----------------|------------|-------------|
| MTC Output ON   | 78         | 61          |
| MTC Output OFF  | 79         | 61          |
| Chase Enable    | 78         | 55 (TBC)   |
| Chase Disable   | 79         | 55 (TBC)   |
| Generate SMPTE  | 78         | 47          |
| Stop SMPTE      | 79         | 47          |
| Arm Track n     | 83         | 36+n        |
| Disarm Track n  | 84         | 36+n        |

Gap between SHIFT note-on and NORMAL note-on: 20ms (adjustable in server.js `GAP_MS`)

## Notes

- Track arm note numbers from MTC-1 manual shift table (Track 1 = note 37, Track 8 = note 44)
- Chase SMPTE normal note (55) is marked TBC — confirm from manual or test
- System Reset (0xFF) — MTC-1 MIDI IN LED does not flash for this message, this is normal
- MMC uses old Fostex format, device ID 127
