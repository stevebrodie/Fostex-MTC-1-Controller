# MTC-1 Controller

## A free tool for musicians using Fostex R8/MTC-1 hardware. Built in the open, stays in the open

## Background
For anyone, like me, who grew up in the 80s and 90s trying to make music the travails of midi syn, Midi Timcode, LTC and SMPTE may well be familiar.
As a young man I purchased a Fostex R8 8-track recorder which came with a free midi controller, the MTC-1. I couldn't ever make the MTC-1 do anything back then as I didn't have a computer; My sequencer was the Alesis HR-16 and MMT-8.

But now I do have a computer! :) The problem is that sending the necessary midi commands to the MTC-1 to make it Chase to SMPTE etc required a combination of midi notes being sent, with one being a 'SHIFT' key, and the timing apparently quite critical. Worse, the MTC-1 had but 2 LEDs to provide user feedback on its condition. I did get this working with Logic but has each time it power cycles it needs to receive the Chase to TC command anew, I needed a reliable way to send those commands. hence this solution. If it helps anyone it would be marvellous to know. :)

## Description

Node.js controller for the Fostex MTC-1 SMPTE sync interface.
Controls the MTC-1 via MIDI, with a browser web UI (tablet-friendly)
and optional Stream Deck MK2 hardware surface.

<img width="751" height="1137" alt="Untitled" src="https://github.com/user-attachments/assets/dbee6dc5-3b6a-4224-8bdb-3686642215ec" />


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
