/**
 * MTC-1 Controller — Node.js / Express
 * Controls the Fostex MTC-1 SMPTE sync interface via MIDI.
 * Surfaces: browser web UI (tablet-friendly) + Stream Deck MK2
 *
 * Usage:
 *   npm install
 *   node server.js
 *   Open http://localhost:3000
 */

'use strict';

const express    = require('express');
const midi       = require('midi');
const path       = require('path');

// canvas is optional — only needed for Stream Deck key images
let createCanvas = null;
try { createCanvas = require('canvas').createCanvas; } catch(_) {}

// ── Stream Deck (optional — graceful if not connected) ───────────────────────
let streamDeck = null;
let sdAvailable = false;
try {
  const { listStreamDecks, openStreamDeck } = require('@elgato-stream-deck/node');
  listStreamDecks().then(devices => {
    if (devices.length > 0) {
      openStreamDeck(devices[0].path).then(sd => {
        streamDeck = sd;
        sdAvailable = true;
        console.log(`Stream Deck connected: ${sd.MODEL} (${sd.KEY_COUNT} keys)`);
        initStreamDeck();
      }).catch(e => console.log('Stream Deck open failed:', e.message));
    } else {
      console.log('No Stream Deck connected — running without it');
    }
  }).catch(e => console.log('Stream Deck list failed:', e.message));
} catch (e) {
  console.log('Stream Deck library not available — running without it');
}

// ── MIDI state ────────────────────────────────────────────────────────────────
let midiOut = null;
let selectedOutPort = null;
let selectedInPort  = null;
let midiIn  = null;

// Controller state
const state = {
  outPort:       null,
  inPort:        null,
  chaseEnabled:  false,
  mtcOutEnabled: false,
  generating:    false,
  rxTC:          '--:--:--:--',
  rxRate:        '---',
  lastActivity:  null,
};

// SSE clients
const sseClients = [];

// ── MIDI helpers ──────────────────────────────────────────────────────────────
function getOutputPorts() {
  const out = new midi.Output();
  const ports = [];
  for (let i = 0; i < out.getPortCount(); i++) ports.push(out.getPortName(i));
  out.closePort();
  return ports;
}

function getInputPorts() {
  const inp = new midi.Input();
  const ports = [];
  for (let i = 0; i < inp.getPortCount(); i++) ports.push(inp.getPortName(i));
  inp.closePort();
  return ports;
}

function openOutputPort(name) {
  if (midiOut) { try { midiOut.closePort(); } catch(_) {} }
  midiOut = null;
  const ports = getOutputPorts();
  const idx = ports.indexOf(name);
  if (idx === -1) return `Port not found: ${name}`;
  midiOut = new midi.Output();
  midiOut.openPort(idx);
  selectedOutPort = name;
  state.outPort = name;
  return null;
}

function openInputPort(name) {
  if (midiIn) { try { midiIn.closePort(); } catch(_) {} }
  midiIn = null;
  const ports = getInputPorts();
  const idx = ports.indexOf(name);
  if (idx === -1) return `Port not found: ${name}`;
  midiIn = new midi.Input();
  midiIn.ignoreTypes(false, false, true); // receive sysex + timing (incl MTC QF), ignore active sensing
  midiIn.openPort(idx);
  selectedInPort = name;
  state.inPort = name;

  // MTC receiver
  const rx = new MTCReceiver();
  midiIn.on('message', (dt, msg) => {
    const result = rx.handle(msg);
    if (result) {
      state.rxTC   = result.tc;
      state.rxRate = result.rate;
      state.lastActivity = Date.now();
      broadcast({ type: 'mtc', tc: result.tc, rate: result.rate });
      updateSDReceiver(result.tc);
    }
  });
  return null;
}

// ── MTC-1 MIDI command engine ─────────────────────────────────────────────────
// SHIFT keys: 78=ON/enable, 79=OFF/disable, 82=time ref/monitor/locate
// Timing: SHIFT note-on → 20ms gap → NORMAL note-on → NORMAL note-off → SHIFT note-off

const GAP_MS = 20;

function sendShiftCommand(shiftNote, normalNote) {
  return new Promise((resolve, reject) => {
    if (!midiOut) return reject(new Error('No MIDI output port open'));
    try {
      midiOut.sendMessage([0x90, shiftNote, 127]); // SHIFT note-on (hold)
      setTimeout(() => {
        midiOut.sendMessage([0x90, normalNote, 127]); // NORMAL note-on
        midiOut.sendMessage([0x80, normalNote, 0]);   // NORMAL note-off
        midiOut.sendMessage([0x80, shiftNote, 0]);    // SHIFT note-off (last)
        resolve();
      }, GAP_MS);
    } catch (e) { reject(e); }
  });
}

// Command definitions — from MTC-1 manual + confirmed session log
const COMMANDS = {
  systemReset:     () => { midiOut.sendMessage([0xFF]); },
  mtcOutputOn:     () => sendShiftCommand(78, 61),                      // SHIFT=78, NORMAL=61
  mtcOutputOff:    () => sendShiftCommand(79, 61),                      // SHIFT=79, NORMAL=61
  chaseEnable:     () => sendShiftCommand(78, 55),
  chaseDisable:    () => sendShiftCommand(79, 55),
  generateSmpte:   () => sendShiftCommand(78, 56),                      // SHIFT=78, NORMAL=56 confirmed
  stopSmpte:       () => sendShiftCommand(79, 56),                      // SHIFT=79, NORMAL=56
  // Transport — Fostex channel voice messages (MTC-1 manual Section 3-1)
  mmcPlay:         () => { midiOut.sendMessage([0x90, 48, 127]); midiOut.sendMessage([0x80, 48, 0]); },
  mmcStop:         () => { midiOut.sendMessage([0x90, 60, 127]); midiOut.sendMessage([0x80, 60, 0]); },
  mmcRecord:       () => { midiOut.sendMessage([0x90, 49, 127]); midiOut.sendMessage([0x80, 49, 0]); },
  rewind:          () => { midiOut.sendMessage([0x90, 53, 127]); midiOut.sendMessage([0x80, 53, 0]); },
  fastForward:     () => { midiOut.sendMessage([0x90, 57, 127]); midiOut.sendMessage([0x80, 57, 0]); },
  // Locate — Fostex proprietary SysEx captured from Logic via MIDI Monitor
  // Format: F0 51 7F 12 18 42 [hr] [mn] [sc] [fr] F7
  // hr = 0x20 (25fps rate bits + 0 hours)
  locateTC:        (mn, sc, fr) => {
    midiOut.sendMessage([0xF0, 0x51, 0x7F, 0x12, 0x18, 0x42, 0x20, mn, sc, fr, 0xF7]);
  },
  // Track arm: SHIFT=83, NORMAL=37+n (track 1=37 .. track 8=44)
  armTrack:        (n) => sendShiftCommand(83, 36 + n),
  disarmTrack:     (n) => sendShiftCommand(84, 36 + n),
};

// Session startup sequence
async function sessionStartup() {
  if (!midiOut) throw new Error('No MIDI output port open');
  log('Session startup sequence…');
  COMMANDS.systemReset();
  await sleep(100);
  await COMMANDS.mtcOutputOn();
  state.mtcOutEnabled = true;
  await sleep(50);
  await COMMANDS.chaseEnable();
  state.chaseEnabled = true;
  log('Startup sequence complete');
  broadcastState();
  updateSDButtons();
}

// ── MTC receiver ──────────────────────────────────────────────────────────────
class MTCReceiver {
  constructor() {
    this.pieces = new Array(8).fill(null);
    this.count  = 0;
    this.lastS  = -1;
  }

  handle(msg) {
    if (!msg || !msg.length) return null;
    const status = msg[0];

    if (status === 0xF1 && msg.length >= 2) {
      const data     = msg[1];
      const pieceNum = (data >> 4) & 0x07;
      this.pieces[pieceNum] = data & 0x0F;
      this.count++;
      if (this.count >= 8) return this._assemble();
    }
    // Ignore MTC Full Frame (0xF0 7F 7F 01 01...) — these come from locate commands
    // and cause display jitter. Quarter frames are the reliable source.
    return null;
  }

  _assemble() {
    const p = this.pieces;
    if (p.some(x => x === null)) return null;
    const f      = p[0] | (p[1] << 4);
    const s      = p[2] | (p[3] << 4);
    const m      = p[4] | (p[5] << 4);
    const h      = p[6] | ((p[7] & 0x01) << 4);
    const rateId = (p[7] >> 1) & 0x03;
    // Reset fully for next cycle
    this.pieces = new Array(8).fill(null);
    this.count  = 0;
    // Throttle — only emit when seconds value changes
    if (s === this.lastS) return null;
    this.lastS = s;
    return { tc: fmtTC(h, m, s, f, rateId === 3), rate: rateName(rateId) };
  }
}

function fmtTC(h, m, s, f, drop) {
  const sep = drop ? ';' : ':';
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(f)}`;
}
function pad(n) { return String(n).padStart(2, '0'); }
function rateName(id) { return ['24', '25', '29.97ND', '29.97DF'][id] ?? '?'; }

// ── SSE broadcast ─────────────────────────────────────────────────────────────
function broadcast(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  sseClients.forEach(res => { try { res.write(data); } catch(_) {} });
}

function broadcastState() {
  broadcast({ type: 'state', ...state });
}

// ── Stream Deck ───────────────────────────────────────────────────────────────
const SD_BUTTONS = [
  { key: 0,  label: 'SYS\nRESET',  color: [80,20,20],  action: 'systemReset'   },
  { key: 1,  label: 'MTC\nOUT ON', color: [20,60,20],  action: 'mtcOutputOn'   },
  { key: 2,  label: 'MTC\nOUT OFF',color: [60,30,20],  action: 'mtcOutputOff'  },
  { key: 3,  label: 'CHASE\nON',   color: [20,80,40],  action: 'chaseEnable'   },
  { key: 4,  label: 'CHASE\nOFF',  color: [60,40,20],  action: 'chaseDisable'  },
  { key: 5,  label: '▶ PLAY',      color: [20,80,20],  action: 'mmcPlay'       },
  { key: 6,  label: '■ STOP',      color: [80,20,20],  action: 'mmcStop'       },
  { key: 7,  label: '● REC',       color: [80,20,20],  action: 'mmcRecord'     },
  { key: 8,  label: 'START\nSEQ',  color: [20,40,80],  action: 'sessionStartup'},
  { key: 9,  label: 'RX TC',       color: [20,20,60],  action: null            },
  { key: 10, label: 'TRK 1',       color: [40,20,60],  action: 'armTrack1'     },
  { key: 11, label: 'TRK 2',       color: [40,20,60],  action: 'armTrack2'     },
  { key: 12, label: 'TRK 3',       color: [40,20,60],  action: 'armTrack3'     },
  { key: 13, label: 'TRK 4',       color: [40,20,60],  action: 'armTrack4'     },
  { key: 14, label: 'TRK 5-8',     color: [40,20,60],  action: 'armTracks58'   },
];

function makeKeyImage(label, bgColor, active = false) {
  if (!createCanvas) return null;
  const size = streamDeck ? streamDeck.ICON_SIZE : 72;
  const canvas = createCanvas(size, size);
  const ctx    = canvas.getContext('2d');
  const [r, g, b] = bgColor;
  const boost = active ? 1.8 : 1;
  ctx.fillStyle = `rgb(${Math.min(255,r*boost)},${Math.min(255,g*boost)},${Math.min(255,b*boost)})`;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = label.split('\n');
  const fontSize = lines.length > 1 ? Math.floor(size / 5.5) : Math.floor(size / 4);
  ctx.font = `bold ${fontSize}px sans-serif`;
  const lineH = fontSize * 1.3;
  const startY = size / 2 - ((lines.length - 1) * lineH) / 2;
  lines.forEach((line, i) => ctx.fillText(line, size / 2, startY + i * lineH));
  return canvas.toBuffer('raw');
}

async function initStreamDeck() {
  if (!streamDeck) return;
  streamDeck.clearPanel();
  for (const btn of SD_BUTTONS) {
    try {
      const img = makeKeyImage(btn.label, btn.color);
      if (img) await streamDeck.fillKeyBuffer(btn.key, img, { format: 'rgba' });
    } catch(_) {}
  }
  streamDeck.on('down', async keyIndex => {
    const btn = SD_BUTTONS.find(b => b.key === keyIndex);
    if (!btn || !btn.action) return;
    try { await handleAction(btn.action); }
    catch (e) { log(`SD action error: ${e.message}`); }
  });
  streamDeck.on('error', e => console.error('Stream Deck error:', e));
}

async function updateSDButtons() {
  if (!streamDeck) return;
  const chaseBtn = SD_BUTTONS.find(b => b.action === 'chaseEnable');
  if (chaseBtn) {
    try {
      const img = makeKeyImage(chaseBtn.label, chaseBtn.color, state.chaseEnabled);
      if (img) await streamDeck.fillKeyBuffer(chaseBtn.key, img, { format: 'rgba' });
    } catch(_) {}
  }
}

async function updateSDReceiver(tc) {
  if (!streamDeck) return;
  try {
    const img = makeKeyImage(tc, [10, 10, 50], true);
    if (img) await streamDeck.fillKeyBuffer(9, img, { format: 'rgba' });
  } catch(_) {}
}

// ── Action handler ────────────────────────────────────────────────────────────
async function handleAction(action, param) {
  if (!midiOut && action !== 'openPorts') {
    throw new Error('No MIDI output port open');
  }
  switch (action) {
    case 'systemReset':
      COMMANDS.systemReset();
      state.chaseEnabled  = false;
      state.mtcOutEnabled = false;
      state.generating    = false;
      log('System Reset sent');
      break;
    case 'mtcOutputOn':
      await COMMANDS.mtcOutputOn();
      state.mtcOutEnabled = true;
      log('MTC Output ON');
      break;
    case 'mtcOutputOff':
      await COMMANDS.mtcOutputOff();
      state.mtcOutEnabled = false;
      log('MTC Output OFF');
      break;
    case 'chaseEnable':
      await COMMANDS.chaseEnable();
      state.chaseEnabled = true;
      log('Chase SMPTE enabled');
      break;
    case 'chaseDisable':
      await COMMANDS.chaseDisable();
      state.chaseEnabled = false;
      log('Chase SMPTE disabled');
      break;
    case 'generateSmpte':
      await COMMANDS.generateSmpte();
      state.generating = true;
      log('Generate SMPTE');
      break;
    case 'stopSmpte':
      await COMMANDS.stopSmpte();
      state.generating = false;
      log('Stop SMPTE');
      break;
    case 'mmcPlay':     COMMANDS.mmcPlay();     log('Play');         break;
    case 'mmcStop':     COMMANDS.mmcStop();     log('Stop');         break;
    case 'mmcRecord':   COMMANDS.mmcRecord();   log('Record');       break;
    case 'rewind':      COMMANDS.rewind();      log('Rewind');       break;
    case 'fastForward': COMMANDS.fastForward(); log('Fast Forward'); break;
    case 'locateTC': {
      // param.tc = 'HH:MM:SS:FF'
      let mn = 0, sc = 0, fr = 0;
      if (param && param.tc) {
        const parts = param.tc.replace(';', ':').split(':').map(Number);
        mn = parts[1] || 0; sc = parts[2] || 0; fr = parts[3] || 0;
      }
      COMMANDS.locateTC(mn, sc, fr);
      log(`Locate → ${pad(0)}:${pad(mn)}:${pad(sc)}:${pad(fr)}`);
      break;
    }
    case 'sessionStartup': await sessionStartup(); break;
    case 'armTrack1':    await COMMANDS.armTrack(1);    log('Arm Track 1');    break;
    case 'armTrack2':    await COMMANDS.armTrack(2);    log('Arm Track 2');    break;
    case 'armTrack3':    await COMMANDS.armTrack(3);    log('Arm Track 3');    break;
    case 'armTrack4':    await COMMANDS.armTrack(4);    log('Arm Track 4');    break;
    case 'armTrack5':    await COMMANDS.armTrack(5);    log('Arm Track 5');    break;
    case 'armTrack6':    await COMMANDS.armTrack(6);    log('Arm Track 6');    break;
    case 'armTrack7':    await COMMANDS.armTrack(7);    log('Arm Track 7');    break;
    case 'armTrack8':    await COMMANDS.armTrack(8);    log('Arm Track 8');    break;
    case 'disarmTrack1': await COMMANDS.disarmTrack(1); log('Disarm Track 1'); break;
    case 'disarmTrack2': await COMMANDS.disarmTrack(2); log('Disarm Track 2'); break;
    case 'disarmTrack3': await COMMANDS.disarmTrack(3); log('Disarm Track 3'); break;
    case 'disarmTrack4': await COMMANDS.disarmTrack(4); log('Disarm Track 4'); break;
    case 'disarmTrack5': await COMMANDS.disarmTrack(5); log('Disarm Track 5'); break;
    case 'disarmTrack6': await COMMANDS.disarmTrack(6); log('Disarm Track 6'); break;
    case 'disarmTrack7': await COMMANDS.disarmTrack(7); log('Disarm Track 7'); break;
    case 'disarmTrack8': await COMMANDS.disarmTrack(8); log('Disarm Track 8'); break;
    default:
      throw new Error(`Unknown action: ${action}`);
  }
  broadcastState();
  updateSDButtons();
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const logLines = [];
function log(msg) {
  const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(entry);
  logLines.push(entry);
  if (logLines.length > 100) logLines.shift();
  broadcast({ type: 'log', msg: entry });
}

// ── Locate points persistence ─────────────────────────────────────────────────
const LOCATE_FILE = path.join(__dirname, 'locate-points.json');
let locatePoints = [
  { label: 'Top of Song', tc: '00:00:00:00' },
  { label: 'Verse',       tc: '00:00:00:00' },
  { label: 'Chorus',      tc: '00:00:00:00' },
  { label: 'Bridge',      tc: '00:00:00:00' },
];
try {
  const fs = require('fs');
  if (fs.existsSync(LOCATE_FILE)) {
    locatePoints = JSON.parse(fs.readFileSync(LOCATE_FILE, 'utf8'));
  }
} catch(_) {}

function saveLocatePoints() {
  try { require('fs').writeFileSync(LOCATE_FILE, JSON.stringify(locatePoints, null, 2)); } catch(_) {}
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send(HTML));

app.get('/api/ports', (req, res) => {
  res.json({ out: getOutputPorts(), in: getInputPorts() });
});

app.post('/api/ports/open', (req, res) => {
  const { outPort, inPort } = req.body;
  let err = null;
  if (outPort) err = openOutputPort(outPort);
  if (!err && inPort) err = openInputPort(inPort);
  if (err) return res.json({ ok: false, error: err });
  log(`Ports opened — OUT: ${outPort || 'unchanged'}, IN: ${inPort || 'unchanged'}`);
  broadcastState();
  res.json({ ok: true, state });
});

app.post('/api/action', async (req, res) => {
  const { action, param } = req.body;
  try {
    await handleAction(action, param);
    res.json({ ok: true, state });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/state', (req, res) => res.json({ ok: true, state }));
app.get('/api/log',   (req, res) => res.json({ lines: logLines }));

app.get('/api/locate-points', (req, res) => res.json({ ok: true, points: locatePoints }));

app.post('/api/locate-points', (req, res) => {
  const { index, label, tc } = req.body;
  if (index < 0 || index >= locatePoints.length) return res.json({ ok: false, error: 'Invalid index' });
  if (label !== undefined) locatePoints[index].label = String(label).slice(0, 20);
  if (tc    !== undefined) locatePoints[index].tc    = String(tc);
  saveLocatePoints();
  res.json({ ok: true, points: locatePoints });
});

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  sseClients.push(res);
  res.write(`data: ${JSON.stringify({ type: 'state', ...state })}\n\n`);
  req.on('close', () => {
    const i = sseClients.indexOf(res);
    if (i !== -1) sseClients.splice(i, 1);
  });
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  let localIP = 'localhost';
  for (const iface of Object.values(nets)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) { localIP = addr.address; break; }
    }
  }
  console.log('\n  ● MTC-1 Controller');
  console.log(`  Local:    http://localhost:${PORT}`);
  console.log(`  Network:  http://${localIP}:${PORT}`);
  console.log('\n  Press Ctrl+C to quit\n');
});

// ── Embedded HTML ─────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>MTC-1 Controller</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Rajdhani:wght@400;600;700&display=swap');

  :root {
    --bg:      #0c0c0c;
    --panel:   #141414;
    --border:  #252525;
    --green:   #00e87a;
    --green-d: #002a16;
    --amber:   #ffaa00;
    --amber-d: #251800;
    --blue:    #4db8ff;
    --blue-d:  #001428;
    --red:     #ff3344;
    --red-d:   #1a0008;
    --purple:  #bb88ff;
    --purple-d:#1a0033;
    --dim:     #3a3a3a;
    --text:    #cccccc;
    --label:   #555;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: 'Rajdhani', sans-serif; font-size: 15px;
    min-height: 100vh; padding-bottom: 44px;
  }

  header {
    background: #080808; border-bottom: 1px solid var(--border);
    padding: 12px 20px; display: flex; align-items: center; gap: 14px;
    position: sticky; top: 0; z-index: 100;
  }
  .pulse {
    width: 9px; height: 9px; border-radius: 50%;
    background: var(--green); box-shadow: 0 0 8px var(--green);
    animation: pulse 2s infinite;
  }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
  header h1 { font-family:'Share Tech Mono',monospace; font-size:14px; color:var(--green); letter-spacing:.15em; }
  header .sub { font-family:'Share Tech Mono',monospace; font-size:11px; color:var(--label); }
  .sd-badge { margin-left:auto; font-family:'Share Tech Mono',monospace; font-size:10px;
              padding:3px 8px; border:1px solid var(--dim); border-radius:2px; color:var(--dim); }
  .sd-badge.active { color:var(--blue); border-color:var(--blue); }

  .container { max-width:760px; margin:0 auto; padding:16px 12px; display:flex; flex-direction:column; gap:14px; }

  .card { background:var(--panel); border:1px solid var(--border); border-radius:3px; overflow:hidden; }
  .card-hdr {
    background:#0a0a0a; border-bottom:1px solid var(--border);
    padding:7px 14px; font-family:'Share Tech Mono',monospace;
    font-size:10px; letter-spacing:.2em; color:var(--label); text-transform:uppercase;
  }
  .card-body { padding:14px; }

  .field-row { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
  .field-row label { min-width:100px; font-size:12px; color:var(--label); font-family:'Share Tech Mono',monospace; }
  select { background:#090909; border:1px solid var(--border); color:var(--amber);
           font-family:'Share Tech Mono',monospace; font-size:12px; padding:6px 8px;
           border-radius:2px; flex:1; outline:none; }
  select:focus { border-color:var(--amber); }
  select option { background:#111; }

  .tc-big {
    font-family:'Share Tech Mono',monospace; font-size:44px; letter-spacing:.06em;
    padding:12px 14px; border-radius:2px; text-align:center; margin:8px 0;
    background:var(--blue-d); color:var(--blue);
  }
  .tc-big .rate { font-size:14px; margin-left:10px; color:var(--amber); vertical-align:middle; }
  .tc-idle { color:var(--dim); background:#0a0a0a; }

  .btn-grid { display:grid; gap:8px; }
  .btn-grid-2 { grid-template-columns:1fr 1fr; }
  .btn-grid-3 { grid-template-columns:1fr 1fr 1fr; }
  .btn-grid-4 { grid-template-columns:1fr 1fr 1fr 1fr; }
  .btn-grid-5 { grid-template-columns:repeat(5,1fr); }

  button {
    font-family:'Rajdhani',sans-serif; font-weight:700; font-size:13px;
    letter-spacing:.1em; text-transform:uppercase;
    padding:11px 8px; border:1px solid var(--border); border-radius:2px;
    background:#0c0c0c; color:var(--text); cursor:pointer; transition:all .12s;
    line-height:1.3;
  }
  button:hover:not(:disabled) { background:var(--panel); border-color:#444; }
  button:active:not(:disabled) { transform:scale(.96); }
  button:disabled { opacity:.25; cursor:not-allowed; }

  .btn-green  { color:var(--green);  border-color:var(--green); }
  .btn-green:hover:not(:disabled)   { background:var(--green-d); }
  .btn-red    { color:var(--red);    border-color:var(--red); }
  .btn-red:hover:not(:disabled)     { background:var(--red-d); }
  .btn-amber  { color:var(--amber);  border-color:var(--amber); }
  .btn-amber:hover:not(:disabled)   { background:var(--amber-d); }
  .btn-blue   { color:var(--blue);   border-color:var(--blue); }
  .btn-blue:hover:not(:disabled)    { background:var(--blue-d); }
  .btn-purple { color:var(--purple); border-color:var(--purple); }
  .btn-purple:hover:not(:disabled)  { background:var(--purple-d); }

  /* Toggle buttons — green=ON, amber=OFF */
  .btn-toggle { color:var(--dim); border-color:var(--dim); transition:all .15s; }
  .btn-toggle.is-on  { color:var(--green); border-color:var(--green); background:var(--green-d); box-shadow:0 0 8px var(--green); }
  .btn-toggle.is-off { color:var(--amber); border-color:var(--amber); background:var(--amber-d); }

  .track-btn { font-size:12px; padding:9px 4px; }
  .track-armed { color:var(--red); border-color:var(--red); background:var(--red-d); box-shadow:0 0 8px var(--red); }

  /* Locate points */
  .locate-row { display:grid; grid-template-columns:1fr auto auto; gap:8px; align-items:center; margin-bottom:8px; }
  .locate-row:last-child { margin-bottom:0; }
  .locate-name {
    background:#090909; border:1px solid var(--border); color:var(--amber);
    font-family:'Share Tech Mono',monospace; font-size:12px; padding:7px 10px;
    border-radius:2px; outline:none; width:100%;
  }
  .locate-name:focus { border-color:var(--amber); }

  .log-box {
    background:#080808; border:1px solid var(--border); border-radius:2px;
    font-family:'Share Tech Mono',monospace; font-size:11px; color:#555;
    height:100px; overflow-y:auto; padding:8px 10px;
  }
  .log-box p { margin:1px 0; }
  .log-box p:last-child { color:var(--green); }

  .statusbar {
    position:fixed; bottom:0; left:0; right:0;
    background:#080808; border-top:1px solid var(--border);
    padding:6px 16px; display:flex; align-items:center; gap:8px;
    font-family:'Share Tech Mono',monospace; font-size:10px; color:var(--label);
  }

  @media (max-width:480px) {
    .tc-big { font-size:30px; }
    .btn-grid-5 { grid-template-columns:repeat(3,1fr); }
    .btn-grid-4 { grid-template-columns:repeat(2,1fr); }
    .locate-row { grid-template-columns:1fr auto auto; }
  }
</style>
</head>
<body>

<header>
  <div class="pulse"></div>
  <h1>MTC-1 CONTROLLER</h1>
  <span class="sub">/ FOSTEX R8 SYNC</span>
  <span class="sd-badge" id="sd-badge">NO STREAM DECK</span>
</header>

<div class="container">

  <!-- Ports -->
  <div class="card">
    <div class="card-hdr">MIDI Ports</div>
    <div class="card-body">
      <div class="field-row">
        <label>MTC-1 IN&nbsp;&nbsp;&nbsp;</label>
        <select id="in-port"></select>
      </div>
      <div class="field-row">
        <label>MTC-1 OUT&nbsp;&nbsp;</label>
        <select id="out-port"></select>
      </div>
      <div class="btn-grid btn-grid-2" style="margin-top:4px">
        <button class="btn-blue"  onclick="refreshPorts()">⟳ Refresh</button>
        <button class="btn-green" onclick="openPorts()">Connect Ports</button>
      </div>
    </div>
  </div>

  <!-- Startup -->
  <div class="card">
    <div class="card-hdr">Session Startup</div>
    <div class="card-body">
      <div class="btn-grid btn-grid-4" style="margin-bottom:8px">
        <button class="btn-blue" onclick="action('sessionStartup')" style="grid-column:span 4">
          ▶▶ Full Session Startup (Reset → MTC Out ON → Chase ON)
        </button>
      </div>
      <div class="btn-grid btn-grid-4">
        <button class="btn-red"  onclick="action('systemReset')">Sys Reset</button>
        <button id="btn-mtcout" class="btn-toggle" onclick="toggleMtcOut()">MTC Out</button>
        <button id="btn-chase"  class="btn-toggle" onclick="toggleChase()">Chase</button>
        <button id="btn-gen"    class="btn-toggle" onclick="toggleGen()">Gen SMPTE</button>
      </div>
    </div>
  </div>

  <!-- Transport -->
  <div class="card">
    <div class="card-hdr">Transport</div>
    <div class="card-body">
      <div class="btn-grid btn-grid-5">
        <button class="btn-amber" onclick="action('rewind')">⏮ REW</button>
        <button class="btn-green" onclick="action('mmcPlay')">▶ PLAY</button>
        <button class="btn-red"   onclick="action('mmcStop')">■ STOP</button>
        <button class="btn-red"   onclick="action('mmcRecord')">● REC</button>
        <button class="btn-amber" onclick="action('fastForward')">FF ⏭</button>
      </div>
    </div>
  </div>

  <!-- Locate Points -->
  <div class="card">
    <div class="card-hdr">Locate Points</div>
    <div class="card-body">
      <div id="locate-points"></div>
    </div>
  </div>

  <!-- Track Arms -->
  <div class="card">
    <div class="card-hdr">Track Arm (R8)</div>
    <div class="card-body">
      <div class="btn-grid btn-grid-4">
        <button class="btn-purple track-btn" id="trk1" onclick="armTrack(1)">TRK 1</button>
        <button class="btn-purple track-btn" id="trk2" onclick="armTrack(2)">TRK 2</button>
        <button class="btn-purple track-btn" id="trk3" onclick="armTrack(3)">TRK 3</button>
        <button class="btn-purple track-btn" id="trk4" onclick="armTrack(4)">TRK 4</button>
        <button class="btn-purple track-btn" id="trk5" onclick="armTrack(5)">TRK 5</button>
        <button class="btn-purple track-btn" id="trk6" onclick="armTrack(6)">TRK 6</button>
        <button class="btn-purple track-btn" id="trk7" onclick="armTrack(7)">TRK 7</button>
        <button class="btn-purple track-btn" id="trk8" onclick="armTrack(8)">TRK 8</button>
      </div>
    </div>
  </div>

  <!-- MTC Receiver -->
  <div class="card">
    <div class="card-hdr">Incoming MTC (from MTC-1)</div>
    <div class="card-body">
      <div class="tc-big tc-idle" id="tc-display">
        --:--:--:--<span class="rate" id="tc-rate"></span>
      </div>
    </div>
  </div>

  <!-- Log -->
  <div class="card">
    <div class="card-hdr">Activity Log</div>
    <div class="card-body" style="padding:0">
      <div class="log-box" id="log-box"></div>
    </div>
  </div>

</div>

<div class="statusbar">
  <span id="status-dot" style="color:#3a3a3a">●</span>
  <span id="status-msg">Not connected</span>
</div>

<script>
  const armedTracks = new Set();
  let es = null;

  // ── SSE ────────────────────────────────────────────────────────────────────
  function connectSSE() {
    es = new EventSource('/api/events');
    es.onmessage = e => {
      const d = JSON.parse(e.data);
      if (d.type === 'state') applyState(d);
      if (d.type === 'mtc')   updateTC(d.tc, d.rate);
      if (d.type === 'log')   appendLog(d.msg);
    };
    es.onerror = () => setStatus('Connection lost — retrying…', '#ff3344');
    es.onopen  = () => setStatus('Connected', '#00e87a');
  }

  function applyState(s) {
    setToggle('btn-mtcout', s.mtcOutEnabled);
    setToggle('btn-chase',  s.chaseEnabled);
    setToggle('btn-gen',    s.generating);
    if (s.outPort) setStatus('OUT: ' + s.outPort, '#00e87a');
  }

  function setToggle(id, on) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.classList.toggle('is-on',  !!on);
    btn.classList.toggle('is-off', !on);
  }

  function toggleMtcOut() {
    const on = document.getElementById('btn-mtcout').classList.contains('is-on');
    action(on ? 'mtcOutputOff' : 'mtcOutputOn');
  }
  function toggleChase() {
    const on = document.getElementById('btn-chase').classList.contains('is-on');
    action(on ? 'chaseDisable' : 'chaseEnable');
  }
  function toggleGen() {
    const on = document.getElementById('btn-gen').classList.contains('is-on');
    action(on ? 'stopSmpte' : 'generateSmpte');
  }

  // ── Ports ──────────────────────────────────────────────────────────────────
  async function refreshPorts() {
    const r = await api('/api/ports');
    fill('out-port', r.out);
    fill('in-port',  r.in);
    setStatus('Ports refreshed — ' + r.out.length + ' out, ' + r.in.length + ' in', '#4db8ff');
  }

  function fill(id, items) {
    const sel = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = '';
    (items.length ? items : ['(none)']).forEach(p => {
      const o = document.createElement('option');
      o.value = o.textContent = p;
      sel.appendChild(o);
    });
    if (items.includes(prev)) sel.value = prev;
  }

  async function openPorts() {
    const outPort = document.getElementById('out-port').value;
    const inPort  = document.getElementById('in-port').value;
    const r = await api('/api/ports/open', { outPort, inPort });
    if (!r.ok) { setStatus('Error: ' + r.error, '#ff3344'); return; }
    setStatus('Connected — OUT: ' + outPort, '#00e87a');
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  async function action(act, param) {
    const r = await api('/api/action', { action: act, param });
    if (!r.ok) setStatus('Error: ' + r.error, '#ff3344');
  }

  function armTrack(n) {
    const btn = document.getElementById('trk' + n);
    if (armedTracks.has(n)) {
      armedTracks.delete(n);
      btn.classList.remove('track-armed');
      action('disarmTrack' + n);
    } else {
      armedTracks.add(n);
      btn.classList.add('track-armed');
      action('armTrack' + n);
    }
  }

  // ── Locate Points ──────────────────────────────────────────────────────────
  let locatePoints = [];

  async function loadLocatePoints() {
    const r = await api('/api/locate-points');
    locatePoints = r.points;
    renderLocatePoints();
  }

  function renderLocatePoints() {
    const container = document.getElementById('locate-points');
    container.innerHTML = '';
    locatePoints.forEach((pt, i) => {
      const row = document.createElement('div');
      row.className = 'locate-row';

      // Editable name
      const nameInp = document.createElement('input');
      nameInp.className = 'locate-name';
      nameInp.type = 'text';
      nameInp.value = pt.label;
      nameInp.placeholder = 'Name…';
      nameInp.addEventListener('change', async () => {
        await api('/api/locate-points', { index: i, label: nameInp.value });
      });

      // Capture current TC
      const captureBtn = document.createElement('button');
      captureBtn.className = 'btn-amber';
      captureBtn.style.cssText = 'padding:7px 12px;white-space:nowrap;font-size:12px';
      captureBtn.textContent = '⏺ SET';
      captureBtn.title = 'Capture current TC to this slot';
      captureBtn.onclick = async () => {
        const tcEl = document.getElementById('tc-display');
        // Strip the fps badge text — grab only the timecode portion
        const tc = tcEl.firstChild && tcEl.firstChild.nodeType === 3
          ? tcEl.firstChild.textContent.trim()
          : tcEl.textContent.trim().split(' ')[0];
        if (tc && tc !== '--:--:--:--') {
          locatePoints[i].tc = tc;
          await api('/api/locate-points', { index: i, tc });
          renderLocatePoints();
        }
      };

      // Go button — shows stored TC
      const goBtn = document.createElement('button');
      goBtn.className = 'btn-blue';
      goBtn.style.cssText = 'padding:7px 12px;white-space:nowrap;font-size:12px';
      const hasTC = pt.tc && pt.tc !== '00:00:00:00';
      goBtn.textContent = hasTC ? '▶ ' + pt.tc : '▶ GO';
      goBtn.title = 'Locate to ' + pt.tc;
      goBtn.disabled = !hasTC;
      goBtn.onclick = () => action('locateTC', { tc: pt.tc });

      row.appendChild(nameInp);
      row.appendChild(captureBtn);
      row.appendChild(goBtn);
      container.appendChild(row);
    });
  }

  // ── TC display ─────────────────────────────────────────────────────────────
  function updateTC(tc, rate) {
    const disp  = document.getElementById('tc-display');
    const badge = document.getElementById('tc-rate');
    badge.textContent = rate ? ' ' + rate + ' fps' : '';
    disp.className = 'tc-big';
    // HH:MM:SS large, :FF smaller and dimmed
    const parts = tc.replace(';', ':').split(':');
    disp.textContent = parts.slice(0, 3).join(':');
    const frames = document.createElement('span');
    frames.style.cssText = 'font-size:22px;opacity:0.5;margin-left:4px';
    frames.textContent = ':' + (parts[3] || '00');
    disp.appendChild(frames);
    disp.appendChild(badge);
  }

  // ── Log ────────────────────────────────────────────────────────────────────
  function appendLog(msg) {
    const box = document.getElementById('log-box');
    const p   = document.createElement('p');
    p.textContent = msg;
    box.appendChild(p);
    box.scrollTop = box.scrollHeight;
    if (box.children.length > 80) box.removeChild(box.firstChild);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  async function api(url, body) {
    const opts = body
      ? { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) }
      : {};
    const r = await fetch(url, opts);
    return r.json();
  }

  function setStatus(msg, color) {
    document.getElementById('status-msg').textContent = msg;
    document.getElementById('status-dot').style.color = color || '#3a3a3a';
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  connectSSE();
  refreshPorts();
  loadLocatePoints();
  api('/api/log').then(r => r.lines.forEach(appendLog));
</script>
</body>
</html>`;
