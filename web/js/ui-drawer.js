// ui-drawer.js — the drawer that slides over the lower screen: Serial monitor, Limits, AI & timing, Camera settings.
'use strict';

N.uiDrawer = (() => {
  const { $, el, fmt, hms } = N.util;
  const S = N.S;
  let tab = 'serial';

  // ================= drawer frame =================
  function open(name) {
    if (!$('drawer').hidden && tab === name) { close(); return; }
    tab = name;
    $('drawer').hidden = false;
    for (const b of $('drawerTabs').children) b.classList.toggle('on', b.dataset.tab === name);
    for (const p of document.querySelectorAll('.pane')) p.classList.toggle('on', p.dataset.pane === name);
    for (const b of document.querySelectorAll('[data-drawer]')) b.classList.toggle('on', b.dataset.drawer === name);
    if (name === 'limits') renderLimits();
    if (name === 'ai') renderAI();
    if (name === 'camera') requestCamera();
    if (name === 'serial') { renderSerial(true); setTimeout(() => $('serialIn').focus(), 50); }
  }
  function close() {
    $('drawer').hidden = true;
    for (const b of document.querySelectorAll('[data-drawer]')) b.classList.remove('on');
  }

  // ================= serial monitor =================
  const lines = [];
  let dirty = false;
  function push(cls, text) {
    lines.push({ cls, text: `${hms(Date.now())}  ${text}` });
    if (lines.length > 800) lines.splice(0, lines.length - 800);
    dirty = true;
  }
  N.on('line', (line, m) => {
    if (m && m.t === 'tel' && !$('serialTel').checked) return;
    push(!m ? 'note' : m.t === 'err' ? 'bad' : '', line);
  });
  N.on('tx', (line, quiet) => push('tx', `> ${line}${quiet ? '   (auto)' : ''}`));
  N.on('reset', () => { lines.length = 0; dirty = true; });

  function renderSerial(force) {
    if ((!dirty && !force) || $('drawer').hidden || tab !== 'serial') return;
    dirty = false;
    const out = $('serialOut');
    out.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const l of lines.slice(-400)) frag.append(el('span', { class: l.cls, text: l.text + '\n' }));
    out.append(frag);
    if ($('serialFollow').checked) out.scrollTop = out.scrollHeight;
  }

  function sendBox() {
    const v = $('serialIn').value.trim();
    if (!v) return;
    if (!N.link.send(v)) N.util.toast('Not connected: connect to the ESP32 or start Demo data first.');
    if (/^STOP$/i.test(v)) S.stopRequested = true;
    if (/^START$/i.test(v)) S.stopRequested = false;
    $('serialIn').value = '';
  }

  // ================= limits =================
  function numberRow(label, unit, value, onchange, step) {
    const inp = el('input', { type: 'number', step: step || 'any', value: value ?? '' });
    inp.addEventListener('change', () => onchange(inp.value === '' ? null : Number(inp.value), inp));
    return el('div', { class: 'frow' }, el('span', {}, label, unit ? el('span', { class: 'unit', text: `  ${unit}` }) : null), inp);
  }

  function setLimit(s, which, val) {
    const L = S.settings.limits[s.lim];
    if (val == null || !isFinite(val)) return renderLimits();
    const old = L[which];
    L[which] = val;
    N.store.saveSettings();
    N.event('info', `Limit changed: ${s.title} ${which} ${fmt(old, s.d)} → ${fmt(val, s.d)} ${s.unit}`);
  }

  function renderLimits() {
    const pane = $('limitsPane'); pane.innerHTML = '';
    const grid = el('div', { class: 'formgrid' });
    for (const s of N.SENSORS.filter(x => !x.binary)) {
      const L = S.settings.limits[s.lim];
      const box = el('div', { class: 'fbox' }, el('h4', {}, s.title, el('small', { text: s.dir === 'low' ? 'alarm when BELOW' : 'alarm when ABOVE' })));
      box.append(numberRow('Amber (check soon)', s.unit, L.amber, v => setLimit(s, 'amber', v)));
      box.append(numberRow('Red (stop & check)', s.unit, L.red, v => setLimit(s, 'red', v)));
      if (s.key === 'ma') box.append(numberRow('Stopped below', s.unit, L.stopped, v => setLimit(s, 'stopped', v)));
      grid.append(box);
    }
    pane.append(grid);
    pane.append(el('p', { class: 'fnote', text: 'Each sensor is judged on the median of its last second, and a new state must last 1 s before it shows. A sensor missing for 3 s shows No signal.' }));
    pane.append(el('div', { class: 'fkeys' },
      el('button', { class: 'key', text: 'Learn normal from last 10 s', onclick: () => {
        const r = N.alarms.learnNormal();
        N.util.toast(r ? `Learned: ${r}` : 'Not enough readings yet. Run the belt normally for 10 s first.');
        renderLimits();
      } }),
      el('button', { class: 'key', text: 'Restore defaults', onclick: () => {
        S.settings.limits = JSON.parse(JSON.stringify(N.DEFAULTS.limits));
        N.store.saveSettings(); N.event('info', 'Limits restored to the defaults.'); renderLimits();
      } })));
  }

  // ================= AI & timing =================
  const TIMING = [
    ['stop_ms', 'Stop delay', 'ms', 'Belt runs this long after the IR sensor, so the washer stops centred under the camera.'],
    ['dwell_ms', 'Stop time', 'ms', 'Shortest time a washer stays stopped under the camera.'],
    ['wait_ms', 'Verdict wait', 'ms', 'No verdict by then: the washer passes. The line never waits forever.'],
    ['gate_ms', 'Gate delay', 'ms', 'Belt running time from restart until the gate fires for a reject.'],
    ['gate_open_ms', 'Gate open time', 'ms', 'How long the gate stays open.'],
  ];

  function setTiming(key, val) {
    if (val == null || !isFinite(val)) return renderAI();
    S.settings.timing[key] = Math.round(val);
    N.store.saveSettings();
    N.event('info', `Timing changed: ${key} = ${Math.round(val)}`);
    N.link.send(`SET ${key} ${Math.round(val)}`);
    setTimeout(renderAI, 400);
  }

  function renderAI() {
    const pane = $('aiPane'); pane.innerHTML = '';
    const A = S.settings.ai, T = S.settings.timing, cfg = S.link.cfg || {};
    const grid = el('div', { class: 'formgrid' });

    const ai = el('div', { class: 'fbox' }, el('h4', {}, 'AI inspection', el('small', { text: S.ai.state === 'ready' ? `ready · ${S.ai.model || ''}` : 'offline' })));
    const on = el('input', { type: 'checkbox' }); on.checked = !!A.on;
    on.addEventListener('change', () => { A.on = on.checked; N.store.saveSettings(); N.event('info', `AI inspection switched ${on.checked ? 'on' : 'off'}.`); N.emit('ai'); });
    ai.append(el('label', { class: 'check' }, on, 'Check every part with the AI (off: every part passes)'));
    const dr = el('input', { type: 'checkbox' }); dr.checked = !!A.demoUsesAI;
    dr.addEventListener('change', () => { A.demoUsesAI = dr.checked; N.store.saveSettings(); N.inspect.health(); N.emit('ai'); });
    ai.append(el('label', { class: 'check' }, dr, 'In Demo data, send photos to the real AI service'));
    ai.append(numberRow('Settle before the photo', 'ms', A.settleMs, v => { A.settleMs = v ?? 300; N.store.saveSettings(); }));
    ai.append(numberRow('Hold above (empty = model)', '', A.hold, v => { A.hold = v; N.store.saveSettings(); }, '0.01'));
    ai.append(numberRow('Reject above (empty = model)', '', A.reject, v => { A.reject = v; N.store.saveSettings(); }, '0.01'));
    ai.append(el('p', { class: 'fnote', text: `Model thresholds now: hold ${fmt(S.ai.hold, 2)}, reject ${fmt(S.ai.reject, 2)}.` }));
    grid.append(ai);

    const svc = el('div', { class: 'fbox' }, el('h4', {}, 'Services on this Mac'));
    const txt = (label, key) => {
      const inp = el('input', { type: 'text', value: A[key], spellcheck: 'false' });
      inp.addEventListener('change', () => { A[key] = inp.value.trim(); N.store.saveSettings(); N.inspect.health(); });
      return el('div', { class: 'frow wide' }, el('span', { text: label }), inp);
    };
    svc.append(txt('Vision address', 'visionUrl'), txt('Agent address', 'agentUrl'), txt('Start Vision file', 'startVision'), txt('Start Agent file', 'startAgent'));
    svc.append(el('div', { class: 'fkeys' }, el('button', { class: 'key', text: 'Start AI', onclick: () => N.inspect.startAI() }),
      el('button', { class: 'key', text: 'Check now', onclick: () => N.inspect.health().then(renderAI) })));
    grid.append(svc);

    const tm = el('div', { class: 'fbox' }, el('h4', {}, 'Line timing', el('small', { text: 'sent to the ESP32 with SET after every connect' })));
    for (const [k, label, unit, note] of TIMING) {
      const r = numberRow(label, unit, T[k], v => setTiming(k, v), '10');
      r.title = note;
      if (k in cfg && cfg[k] !== T[k]) r.append(el('span', { class: 'unit', text: `board has ${cfg[k]}` }));
      tm.append(r);
    }
    const stops = el('select', {}, new Option('Stop under the camera (1)', '1'), new Option('Belt never stops (0)', '0'));
    stops.value = String(T.stops);
    stops.addEventListener('change', () => setTiming('stops', Number(stops.value)));
    tm.append(el('div', { class: 'frow wide' }, el('span', { text: 'Inspection mode' }), stops));
    grid.append(tm);
    pane.append(grid);
  }

  // ================= camera picture settings (CoreMediaIO, Mac app only) =================
  const CC = {
    exposure: { label: 'Exposure', note: 'Shorter is darker and sharper. Logitech C270 under the tunnel lamp: about 1.5 ms with gain 0.' },
    gain: { label: 'Gain', note: 'Fixed together with a manual exposure. 0 gives the least noise.' },
    brightness: { label: 'Brightness' }, contrast: { label: 'Contrast' }, saturation: { label: 'Colour' },
    sharpness: { label: 'Sharpness' }, whitebalance: { label: 'White balance' },
    backlight: { label: 'Backlight comp.', check: true, note: 'Best off.' },
    powerline: { label: 'Mains frequency', note: 'India is 50 Hz. The wrong one makes the lamp flicker in the picture.' },
  };
  let camInfo = null;

  function requestCamera() {
    const cam = N.camera.label;
    const pane = $('camPane'); pane.innerHTML = '';
    if (!N.bridge.native) { pane.append(el('p', { class: 'fnote', text: 'Camera picture settings need the NAZAR Console Mac app.' })); return; }
    if (!cam || cam === 'Demo camera (drawn)') { pane.append(el('p', { class: 'fnote', text: 'Start a real camera first (picker in the Camera panel).' })); return; }
    pane.append(el('p', { class: 'fnote', text: `Reading the settings of ${cam}…` }));
    N.bridge.camDescribe(cam);
  }

  function saveCam(cam, key, v) {
    S.settings.camCtl[cam] = S.settings.camCtl[cam] || {};
    S.settings.camCtl[cam][key] = v;
    N.store.saveSettings();
  }

  const expMs = v => `${fmt(v / 10, v < 100 ? 1 : 0)} ms`;           // UVC exposure is in 100 µs steps
  const toLog = (c, v) => Math.round(Math.log(Math.max(v, c.min || 1) / Math.max(c.min, 1)) / Math.log(c.max / Math.max(c.min, 1)) * 1000);
  const fromLog = (c, x) => Math.round(Math.max(c.min, 1) * Math.pow(c.max / Math.max(c.min, 1), x / 1000));

  N.on('native:camInfo', (cam, list, ok) => {
    if (cam !== N.camera.label) return;
    camInfo = list;
    if (ok === false) N.util.toast('The camera refused that setting.');
    if (!$('drawer').hidden && tab === 'camera') renderCamera(cam);
  });

  function renderCamera(cam) {
    const pane = $('camPane'); pane.innerHTML = '';
    if (!camInfo || !camInfo.length) {
      pane.append(el('p', { class: 'fnote', text: `${cam} has no picture settings the app can change.${/iriun/i.test(cam) ? ' Set exposure in the Iriun app on the phone.' : ''}` }));
      return;
    }
    const expo = camInfo.find(c => c.key === 'exposure');
    const expoAuto = expo && expo.auto === true;
    pane.append(el('h4', { class: 'fnote', text: `${cam} — settings are saved for this camera and put back every time it starts.` }));
    for (const c of camInfo) {
      const info = CC[c.key] || { label: c.key };
      const row = el('div', { class: 'camctl' }, el('b', { text: info.label }));
      if (c.key === 'powerline') {
        const sel = el('select', {}, new Option('50 Hz (India)', '1'), new Option('60 Hz', '2'), new Option('Off', '0'));
        sel.value = String(Math.round(c.value)); sel.disabled = !c.settable;
        sel.addEventListener('change', () => { const v = +sel.value; N.bridge.camSet(cam, [{ key: c.key, value: v }]); saveCam(cam, c.key, { value: v }); N.event('info', `Camera mains frequency: ${sel.selectedOptions[0].textContent}`); });
        row.append(sel, el('span'), el('span'));
      } else if (info.check) {
        const cb = el('input', { type: 'checkbox' }); cb.checked = c.value > 0; cb.disabled = !c.settable;
        cb.addEventListener('change', () => { const v = cb.checked ? 1 : 0; N.bridge.camSet(cam, [{ key: c.key, value: v }]); saveCam(cam, c.key, { value: v }); });
        row.append(el('label', { class: 'check' }, cb, 'On'), el('span'), el('span'));
      } else if (c.min != null) {
        const isExp = c.key === 'exposure';
        const range = el('input', { type: 'range', min: 0, max: isExp ? 1000 : c.max - c.min, step: 1, value: isExp ? toLog(c, c.value) : c.value - c.min });
        const out = el('output', { text: isExp ? expMs(c.value) : fmt(c.value, 0) });
        const valueOf = () => (isExp ? fromLog(c, +range.value) : c.min + +range.value);
        range.disabled = !c.settable || c.auto === true || (c.key === 'gain' && expoAuto);
        range.addEventListener('input', () => { out.textContent = isExp ? expMs(valueOf()) : fmt(valueOf(), 0); });
        range.addEventListener('change', () => {
          const v = valueOf();
          N.bridge.camSet(cam, [{ key: c.key, value: v }], true);
          saveCam(cam, c.key, { auto: false, value: v });
        });
        let autoBox = el('span');
        if ('auto' in c && (c.key === 'exposure')) {
          const cb = el('input', { type: 'checkbox' }); cb.checked = !!c.auto;
          cb.addEventListener('change', () => {
            // unticking automatic exposure must also fix the gain, or the camera keeps brightening by itself
            const gain = camInfo.find(x => x.key === 'gain');
            const items = cb.checked ? [{ key: 'exposure', auto: true }] : [{ key: 'exposure', auto: false, value: c.value }];
            if (gain && 'auto' in gain) items.push(cb.checked ? { key: 'gain', auto: true } : { key: 'gain', auto: false, value: gain.value });
            N.bridge.camSet(cam, items);
            for (const it of items) saveCam(cam, it.key, it.auto ? { auto: true } : { auto: false, value: it.value });
            N.event('info', `Camera exposure ${cb.checked ? 'automatic' : 'manual, ' + expMs(c.value)}`);
          });
          autoBox = el('label', { class: 'check' }, cb, 'Automatic');
        }
        row.append(range, out, autoBox);
      } else continue;
      if (info.note) row.append(el('div', { class: 'note', text: info.note }));
      pane.append(row);
    }
    pane.append(el('div', { class: 'fkeys' },
      el('button', { class: 'key', text: 'Reset camera', onclick: () => {
        N.bridge.camSet(cam, [{ key: 'exposure', auto: true }, { key: 'gain', auto: true }]);
        delete S.settings.camCtl[cam]; N.store.saveSettings();
        N.event('info', `Camera ${cam} reset to automatic exposure.`);
      } }),
      el('span', { class: 'fnote', text: 'Watch "Too bright" in the Camera panel: aim for 0 % pure white on the washer.' })));
  }

  function init() {
    for (const b of document.querySelectorAll('[data-drawer]')) b.addEventListener('click', () => open(b.dataset.drawer));
    for (const b of $('drawerTabs').children) b.addEventListener('click', () => open(b.dataset.tab));
    $('btnDrawerClose').addEventListener('click', close);
    $('btnCamSettings').addEventListener('click', () => open('camera'));
    $('btnSend').addEventListener('click', sendBox);
    $('serialIn').addEventListener('keydown', e => { if (e.key === 'Enter') sendBox(); });
    for (const b of document.querySelectorAll('[data-quick]')) b.addEventListener('click', () => {
      if (!N.link.send(b.dataset.quick)) N.util.toast('Not connected.');
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('detail').hidden && $('agent').hidden) close(); });
    N.on('hello', () => { if (!$('drawer').hidden && tab === 'ai') renderAI(); });
    setInterval(renderSerial, 200);
  }

  return { init, open, close };
})();
