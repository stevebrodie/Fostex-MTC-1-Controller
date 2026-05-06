# Fostex MTC-1 Controller — Electron Era Roadmap

*Features deferred from the current Node.js/browser implementation, to be built once the app is packaged as an Electron application. Electron provides the necessary OS-level access (filesystem, native audio API) that makes these features practical.*

---

## 1. Scenes / State Saving

### What it is
Named, saveable snapshots of the complete app state, allowing different studio configurations to be stored and recalled instantly.

### What gets saved per scene
- MIDI port selections (in and out)
- Project zero offset (current `project-zero.json` value)
- Locate points (current `locate-points.json` contents)
- Track arm states
- Time Reference mode (MTC / LTC+TACH / LTC / TACH+DIR)
- LTC audio input selection (if applicable — see Feature 2)

### Implementation notes
- Scenes stored as named JSON files via Electron's `fs` module — no database needed
- Scene management UI: Save, Load, Delete, Rename
- Scene files live in a known app data directory, accessible via the OS file manager if needed
- Default scene loaded on startup; last-used scene remembered between sessions
- Slots neatly into the planned Preferences window restructure

---

## 2. LTC Audio Input & Adaptive Timecode Display

### Background
The current timecode display reads MTC arriving via MIDI from the MTC-1. MTC has an inherent quarter-frame assembly limitation — at 25fps a confirmed address is only available every ~80ms — which causes visible stepping in the frames digit. The frames digit is therefore currently suppressed in MTC mode, displaying `HH:MM:SS` only.

When the DAW is using direct LTC audio sync (Reaper / Ardour workflow), the MTC-1 is not in the timecode chain — it handles transport commands only. No MTC flows to the app, so the timecode display would go dark without an alternative source.

LTC decoded from audio delivers a confirmed address every frame (~40ms at 25fps), giving a smooth, flicker-free display including the frames digit (`HH:MM:SS:FF`).

### Trigger for switching
The display mode switches are linked to the **Time Reference button** in the app, which cycles the MTC-1 through its four time reference modes by sending MIDI commands:

| Button state | MIDI sent | Display mode |
|---|---|---|
| MTC | SHIFT 82 + NORMAL 49 | MTC mode — reads MIDI input |
| LTC+TACH | SHIFT 82 + NORMAL 50 | MTC mode — MTC-1 still outputs MTC |
| LTC | SHIFT 82 + NORMAL 51 | **LTC audio mode — see below** |
| TACH+DIR | SHIFT 82 + NORMAL 52 | MTC mode |

When the user selects **LTC** (82+51), this is an explicit intent signal — the user is telling the MTC-1 to use LTC as its time reference, and the DAW will be reading LTC directly from audio. The app responds accordingly.

### Behaviour on selecting LTC mode
1. App sends SHIFT 82 + NORMAL 51 to MTC-1 as normal
2. If a saved LTC audio input exists for the current scene → switch display to LTC mode immediately, no prompt
3. If no saved input → show a modal dialog: audio input selector dropdown populated from available interface inputs at runtime (never hardcoded), with OK/Apply button
4. User selects input and clicks OK/Apply → dialog closes, display switches to LTC mode, selection saved to current scene
5. Cycling away from LTC to any other Time Reference mode → display reverts to MTC source, no dialog

### Display behaviour in LTC mode
- Timecode decoded from the selected audio input via Web Audio API (Electron renderer process)
- Display format: `HH:MM:SS:FF` with fps badge
- Smooth per-frame updates with no visible stepping
- If audio input signal is lost → display shows dashes and logs a warning

### MTC-1 mode note (to confirm with hardware)
When the DAW reads LTC directly from audio and the MTC-1 is transport-only, the correct MTC-1 time reference setting is believed to be **LTC** (82+51). This needs verification against the MTC-1 manual and confirmed with a live test once the R8 is operational.

---

## Implementation order

1. **Electron packaging** — prerequisite for both features above; MIDI port selection moves to Preferences, Activity Log to View menu
2. **Scenes / state saving** — implement first as it is self-contained and immediately useful
3. **LTC audio input** — implement second; depends on Electron's Web Audio API access and benefits from scenes being in place (audio input saved per scene)

---

*Document created May 2026 following design discussion. To be updated as implementation proceeds.*
