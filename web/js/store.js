// store.js — the one place where state lives: saved settings, the live readings, host-side totals, inspection log
// and the events list. Other scripts read N.S and call the functions here; they never keep their own copies.
'use strict';

N.DEFAULTS = {
  limits: {
    ma: { amber: 700, red: 1000, stopped: 40 },   // belt motor current, mA (stopped = belt should run but draws less)
    vib: { amber: 0.08, red: 0.15 },             // motor shaking, g RMS
    temp: { amber: 45, red: 60 },                // motor can, °C
    lux: { amber: 300, red: 120 },               // tunnel light: alarm BELOW these
  },
  timing: { stop_ms: 150, dwell_ms: 1200, wait_ms: 5000, gate_ms: 800, gate_open_ms: 600, stops: 1 },
  ai: {
    on: true,
    visionUrl: 'http://127.0.0.1:8765',
    agentUrl: 'http://127.0.0.1:8766',
    settleMs: 300,
    hold: null,          // threshold overrides; null = use the model's own
    reject: null,
    demoUsesAI: false,   // Demo data, but photos go to the real vision service (test the AI without the line)
    startVision: '~/Downloads/NAZAR/11-Onsite-Build/nazar-vision/Start Vision.command',
    startAgent: '~/Downloads/NAZAR/11-Onsite-Build/nazar-agent/Start Agent.command',
  },
  port: '',
  baud: 115200,
  camera: '',
  camOff: false,
  camCtl: {},            // per camera label: {exposure: {auto: false, value: 15}, gain: {value: 0}, powerline: {value: 1}}
  fix: { at: null, note: '' },
};

N.S = {
  settings: null,
  source: 'none',        // 'none' | 'live' | 'demo' — never mixed: switching clears the data
  link: { state: 'idle', port: '', openedAt: 0, lastLineAt: 0, lines: 0, rate: 0, fw: '', sensors: null, cfg: null, linkOk: false },
  tel: null,             // latest telemetry object
  telAt: 0,
  hist: [],              // every telemetry line since the source started: {t, v, ma, vib, vpk, lux, temp, ir, gate, belt, mode}
  lastSeen: {},          // key -> time it was last present in a tel line
  totals: { parts: 0, rej: 0, espParts: null, espRej: null, partTimes: [], lastPartAt: 0 },
  inspections: [],       // contract §6 rows: {at, n, verdict, score, ms, v, ma, vib, vpk, lux, temp}
  lastInsp: null,        // last inspection incl. crop / heatmap for the panel
  held: null,            // part held under the camera: {n, crop, heatmap, score}
  stopRequested: false,  // operator pressed Stop line (re-sent if the board reboots)
  ai: { state: 'unknown', model: '', hold: null, reject: null, ms: null, checkedAt: 0 },
  events: [],
};

N.HIST_MAX = 100000;     // ~2.8 h at 10 lines/s

N.store = (() => {
  function deepMerge(base, over) {
    if (over == null || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const [k, v] of Object.entries(over)) {
      out[k] = (base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])) ? deepMerge(base[k], v) : v;
    }
    return out;
  }

  function loadSettings() {
    let saved = window.__NAZAR_SAVED || null;
    if (!saved) { try { saved = JSON.parse(localStorage.getItem('nazar-console') || 'null'); } catch (e) { saved = null; } }
    N.S.settings = deepMerge(JSON.parse(JSON.stringify(N.DEFAULTS)), saved || {});
  }

  let saveTimer = 0;
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => N.bridge.saveSettings(N.S.settings), 300);
  }

  /** New source (live port or demo): forget every reading, count and inspection from the old one. */
  function resetData() {
    const S = N.S;
    S.tel = null; S.telAt = 0; S.hist = []; S.lastSeen = {};
    S.totals = { parts: 0, rej: 0, espParts: null, espRej: null, partTimes: [], lastPartAt: 0 };
    S.inspections = []; S.lastInsp = null; S.held = null; S.stopRequested = false;
    S.link.fw = ''; S.link.sensors = null; S.link.cfg = null; S.link.linkOk = false; S.link.lines = 0; S.link.rate = 0;
    N.emit('reset');
  }

  /** Host-side totals from the board's counters: survive board reboots (its counters restart at 0). */
  function countFrom(tel, now) {
    const T = N.S.totals;
    if (typeof tel.parts === 'number') {
      if (T.espParts == null) T.espParts = tel.parts;        // first line: count only parts we see from now on
      else if (tel.parts < T.espParts) T.espParts = 0;        // the board rebooted: its counter restarted at 0
      const d = tel.parts - T.espParts;
      if (d > 0 && d < 50) {
        T.parts += d;
        for (let i = 0; i < d; i++) T.partTimes.push(now);
        T.lastPartAt = now;
      }
      T.espParts = tel.parts;
    }
    if (typeof tel.rej === 'number') {
      if (T.espRej == null) T.espRej = tel.rej;
      else if (tel.rej < T.espRej) T.espRej = 0;
      const d = tel.rej - T.espRej;
      if (d > 0 && d < 50) T.rej += d;
      T.espRej = tel.rej;
    }
    const cut = now - 60000;
    while (T.partTimes.length && T.partTimes[0] < cut) T.partTimes.shift();
  }

  function addTel(tel, now) {
    const S = N.S;
    S.tel = tel; S.telAt = now;
    for (const k of Object.keys(tel)) S.lastSeen[k] = now;
    S.hist.push({ t: now, v: tel.v, ma: tel.ma, vib: tel.vib, vpk: tel.vpk, lux: tel.lux, temp: tel.temp,
      ir: tel.ir, gate: tel.gate, belt: tel.belt, mode: tel.mode });
    if (S.hist.length > N.HIST_MAX) S.hist.splice(0, S.hist.length - N.HIST_MAX);
    countFrom(tel, now);
  }

  /** Index of the first history entry at or after time t (binary search; history is in time order). */
  function histFrom(t) {
    const h = N.S.hist;
    let lo = 0, hi = h.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (h[m].t < t) lo = m + 1; else hi = m; }
    return lo;
  }

  function resetCounts() {
    const T = N.S.totals;
    T.parts = 0; T.rej = 0; T.partTimes = []; T.lastPartAt = 0;
    N.S.inspections = []; N.S.lastInsp = null;
    N.emit('counts-reset');
  }

  /** levels: red, amber, ok, info */
  function event(level, text) {
    N.S.events.unshift({ t: Date.now(), level, text });
    if (N.S.events.length > 400) N.S.events.length = 400;
    N.emit('event');
    if (N.bridge && N.bridge.native) N.bridge.log(`event ${level}: ${text}`);
  }

  return { loadSettings, saveSettings, resetData, addTel, histFrom, resetCounts, event, deepMerge };
})();

N.event = N.store.event;
