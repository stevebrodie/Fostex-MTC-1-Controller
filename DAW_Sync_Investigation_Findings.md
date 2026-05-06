# DAW Sync Investigation — Findings Summary

## Context

Investigation into whether Reaper or Mixbus/Ardour could be used as an alternative to
Logic Pro for hybrid tape/DAW sessions with the Fostex R8 and MTC-1. Specifically
exploring direct LTC audio sync as a potentially tighter alternative to MTC.

---

## Core Finding

**Logic Pro is the only viable DAW for seamless transport control with the R8/MTC-1.**

Logic's "MMC Uses Old Fostex Format" setting causes it to send transport commands to
the R8 *before* waiting for MTC lock — it initiates first, then chases. No other DAW
tested implements this behaviour. It is a unique Legacy feature in Logic that exists
because Logic was designed in an era when tape/DAW hybrid sessions were the norm.

---

## The Chicken-and-Egg Problem

All DAWs except Logic hit the same fundamental wall when slaved to external timecode
(whether MTC or LTC):

1. DAW waits for timecode before entering play state
2. Therefore DAW cannot send transport command to roll the R8
3. Therefore R8 never rolls
4. Therefore timecode never arrives
5. Deadlock

This is not an R8 limitation. It would occur with any tape machine on any DAW without
specific "initiate then chase" support. It is an architectural difference between
Logic's legacy tape machine support and the modern external sync model used by
Reaper, Mixbus, and Ardour.

---

## Direct LTC Sync Investigation (Reaper)

Tested direct LTC audio input to Reaper as a potentially tighter sync alternative to
MTC via the MTC-1.

### What Works
- Reaper can decode LTC from a hardware audio input and display timecode position
- Reaper will chase LTC and enter play state when "Start playback on valid timecode
  when stopped" is ticked
- Sync is stable once established

### What Doesn't Work
- Reaper cannot initiate transport — chicken-and-egg applies equally to LTC
- Play must be initiated from the R8 front panel; Reaper then chases
- Stop commands from Reaper do not reliably stop the R8 without additional scripting

### Critical Gotchas Discovered
- **Time selection blocks auto-start** — if a time selection exists on the Reaper
  timeline, Reaper will show "Chasing" but will not enter play state. Clear all time
  selections before attempting LTC sync.
- **EVO4 input routing** — the EVO4 does not expose discrete hardware inputs as
  individual channels to Core Audio on Mac. LTC only visible to Reaper via "Mix 2"
  (a monitor mix bus), not as a direct hardware input. Reaper can read TC position
  from this but behaviour is unreliable for auto-start. The Metric Halo 2882 exposes
  discrete inputs correctly.
- **Project position mismatch** — if the incoming timecode address (e.g. 01:00:00:00)
  maps to a bar position far outside the visible project (e.g. bar 222), Reaper may
  refuse to auto-start. Ensure project start time matches the tape stripe address.
- **Frame rate** — must match exactly. 25fps stripe requires 25fps set in Reaper's
  External Timecode Synchronization dialog.

### Why Direct LTC Breaks the Existing Workflow
Bypassing the MTC-1 for sync (feeding LTC directly to the audio interface) removes
the MTC-1 from the signal chain. Consequences:
- MTC-1 no longer generates MTC output
- Tape Time display in the Node.js web UI stops working
- Transport control via the web UI is broken
- The R8's own tape counter and DAW display become independent — confusing in session
- The entire integrated system built around the MTC-1 is undermined

The theoretical sync improvement from direct LTC is not worth these workflow regressions.

---

## JSFX Transport Control (Reaper)

A JSFX script was written to send Fostex transport notes (Note 48 = PLAY, Note 60 =
STOP) from Reaper's transport state via the `@transport` block.

### What Works
- Stop command (Note 60) works reliably with debounce logic
- Debounce of ~25 audio blocks (~275ms at 512 buffer/44.1kHz) prevents false
  retriggering during Reaper's post-stop repositioning

### What Doesn't Work
- Play command (Note 48) cannot be debounced — by the time the delay has elapsed,
  Reaper is already waiting for LTC/MTC and the R8 hasn't rolled yet
- Play initiation from Reaper is not viable when slaved to external timecode

### Files
- `fostex_transport.jsfx` — basic version (play + stop, no debounce)
- `fostex_transport_debounced.jsfx` — debounced version (stop only reliable)

---

## Linux / Ardour / Mixbus

The same chicken-and-egg problem applies. No Linux DAW implements Logic-style
"initiate then chase" behaviour. A seamless tape/DAW workflow on Linux equivalent to
the Logic setup is not achievable with this hardware combination without writing
substantial custom bridging software.

---

## IAC Bus MMC Translation Layer Testing (May 2026)

The Node.js app includes an MMC listener on an IAC Driver Bus virtual MIDI port,
designed to receive standard MMC SysEx from any DAW and translate it to Fostex Note
On transport commands. This allows any DAW to control the R8 without native Fostex
support, in theory.

### Testing Results

**Architecture confirmed sound:** The server's MMC listener connects correctly to the
IAC bus and correctly receives and logs SysEx when it arrives. MIDI Monitor confirmed
Fostex locate SysEx (F0 51 7F...) flowing on the bus from Logic.

**Logic Pro:** Sends Fostex Note Ons and proprietary SysEx directly — not standard MMC.
The IAC translation layer is therefore irrelevant for Logic; it bypasses it entirely.
Logic is also the only DAW that cannot sync directly to LTC audio.

**Mixbus/Ardour:** Sends MTC quarter frames and MTC Full Frame position messages on the
IAC bus, plus MMC locate commands, but does **not** send MMC Play or Stop commands from
its transport buttons. Confirmed via MIDI Monitor — no F0 7F 7F 06 02 (Play) or
F0 7F 7F 06 01 (Stop) SysEx observed at all. Mixbus operates as MTC master — the MTC
stream itself is the play signal, and slaves are expected to lock to it. MMC transport
commands are simply not implemented in Mixbus/Ardour's outbound MMC.

**Reaper:** No native MMC send capability at all. Confirmed via research — Reaper
supports receiving MMC but not transmitting it from its own transport.

### The Catch-22

- Logic is the only DAW that sends proper transport commands to the R8
- Logic is also the only DAW that cannot sync directly to LTC audio
- All other DAWs can sync to LTC directly but cannot command the R8's transport

The IAC translation layer therefore currently has no viable DAW source of standard
MMC Play/Stop to translate. It remains architecturally correct and future-proof.

---

## Ardour/Mixbus Lua DSP Scripts — Potential Path Forward

Research confirmed that Ardour supports Lua DSP scripts running in the realtime audio
thread with access to MIDI output buffers and the Session object (transport state).
This is the same mechanism used by Ardour's built-in arpeggiator plugins.

A Lua DSP script placed on a MIDI track in Mixbus/Ardour could in principle:
- Monitor transport state (playing/stopped) via the Session object
- Write Fostex Note On messages (Note 48 = Play, Note 60 = Stop) directly to the
  track's MIDI output buffer in realtime
- Route that MIDI output to the MT4 and R8

This would be directly analogous to the working Reaper JSFX approach, and would
solve the transport initiation problem for Mixbus without any changes to the app.

### Status
A follow-up email was sent to Todd at Harrison Consoles (May 2026) asking specifically
whether a Lua DSP script can read transport state and write arbitrary MIDI Note Ons to
its output buffer. His original response (April 2026) indicated this might become
possible and invited checking back — it was not a flat refusal.

**Awaiting response.** If confirmed viable, a Lua DSP script for Mixbus/Ardour would
be written analogously to `fostex_transport.jsfx`.

---

## Conclusions

### For the Node.js Web UI
- **LTC sync option: not worth implementing** as a server-side feature. It breaks the
  MTC-1-centred workflow, removes the Tape Time display, and doesn't solve the
  transport initiation problem. LTC audio input is deferred to the Electron era as an
  adaptive display feature (see Electron Roadmap document).
- The existing MTC-based workflow with Logic is the correct and complete solution.
- The web UI play/stop transport commands work correctly as-is for the Logic workflow.

### For DAW Choice
- **Logic Pro** — fully supported, seamless, use for all R8 sessions
- **Reaper** — LTC chase works if initiated from R8; stop via JSFX viable; JSFX
  approach sending standard MMC to IAC bus rather than direct Note Ons is a future
  option to investigate
- **Mixbus/Ardour** — Lua DSP script approach potentially viable pending Harrison
  response; same LTC sync capability as Reaper
- **Linux** — no viable seamless tape/DAW workflow with R8/MTC-1

### Dead Ends to Avoid
- Direct LTC into DAW audio input with MTC-1 in the rig (breaks integrated workflow)
- Attempting to slave Reaper/Mixbus/Ardour and initiate transport from the DAW
- Expecting any DAW other than Logic to send native Fostex transport commands
- EVO4 as LTC sync source in Reaper (Mix 2 is not a reliable discrete input)
- Expecting Mixbus to send MMC Play/Stop from its transport buttons (it doesn't)
- Expecting Reaper to send MMC at all natively (it doesn't)

---

*Document generated following live session testing, April 2026.*
*Updated May 2026 following IAC bus MMC translation layer testing and Lua DSP script research.*
