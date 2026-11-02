// ui-tiles.js — the six sensor tiles (value, status word, sparkline, sub-line) and the Sensor detail sheet
// (big chart, 30 s – 15 min, Pause with Space, ← → to step, stats for the view, switch sensor keeping the pause).
'use strict';

N.uiTiles = (() => {
  const { $, el, fmt, hms } = N.util;
  const S = N.S;
  const SPARK_MS = 60000;
  const tiles = {};
  const RANGES = [[30000, '30 s'], [60000, '1 min'], [120000, '2 min'], [300000, '5 min'], [900000, '15 min']];
  const D = { open: false, key: 'ma', span: 120000, paused: null, cursor: null, hover: null };

  const sensorOf = key => N.SENSORS.find(s => s.key === key);

  function build() {
    const box = $('tiles');
    for (const s of N.SENSORS) {
      const t = {
        root: el('div', { class: 'tile', onclick: () => openDetail(s.key) }),
        state: el('div', { class: 'state st-none' }, el('i'), el('span', { text: 'Waiting' })),
        value: el('div', { class: 'value dim', text: '—' }),
        canvas: el('canvas'),
        foot: el('div', { class: 'foot', text: s.part }),
      };
      t.root.append(el('h3', { text: s.title }), t.state, t.value, t.canvas, t.foot);
      if (s.key === 'gate') {
        t.root.append(el('button', { class: 'key small tbtn', text: 'Test gate', title: 'Sends REJECT: fires the gate once, now',
          onclick: e => { e.stopPropagation(); if (N.link.send('REJECT')) N.event('info', 'Test gate pressed (REJECT sent).'); } }));
      }
      box.append(t.root);
      tiles[s.key] = t;
    }
  }

  function setState(t, cls, word) {
    t.state.className = 'state ' + cls;
    t.state.lastChild.textContent = word;
  }

  /** Text and class for one sensor now (shared by tiles and the detail sheet). */
  function describe(s, at) {
    const a = N.alarms.state(s.key);
    const tel = S.tel || {};
    if (S.source === 'none') return { cls: 'st-none', word: 'Not connected', value: '—', unit: '' };
    if (a.state === 'none') return { cls: 'st-none', word: 'No signal', value: 'No signal', unit: '', dim: true };
    if (a.state === 'wait' || tel[s.key] == null) return { cls: 'st-none', word: 'Waiting', value: '—', unit: '', dim: true };
    if (s.key === 'ir') return tel.ir ? { cls: 'st-info', word: 'Part present', value: 'Part', unit: '' } : { cls: 'st-ok', word: 'Clear', value: 'Clear', unit: '' };
    if (s.key === 'gate') return tel.gate ? { cls: 'st-red', word: 'Open', value: 'Open', unit: '' } : { cls: 'st-ok', word: 'Closed', value: 'Closed', unit: '' };
    const cls = { ok: 'st-ok', amber: 'st-amber', red: 'st-red', stopped: 'st-red' }[a.state] || 'st-none';
    let word = N.alarms.stateWord(s, a.state);
    let c = cls;
    if (s.key === 'ma' && tel.belt === 0 && a.state === 'ok') { word = 'Belt off'; c = 'st-info'; }
    return { cls: c, word, value: fmt(at != null ? at : tel[s.key], s.d), unit: s.unit, state: a.state };
  }

  function foot(s) {
    const tel = S.tel || {};
    const L = S.settings.limits;
    switch (s.key) {
      case 'ma': return tel.v != null && tel.ma != null ? `${fmt(tel.v, 2)} V · ${fmt(tel.v * tel.ma / 1000, 2)} W` : 'INA219';
      case 'vib': return tel.vpk != null ? `Peak ${fmt(tel.vpk, 3)} g · amber ${L.vib.amber}` : 'MPU-6050';
      case 'temp': {
        const now = Date.now(), a = N.alarms.medianAt('temp', now - 55000, 5000), b = N.alarms.medianAt('temp', now, 5000);
        return a != null && b != null ? `${b - a >= 0 ? '+' : ''}${fmt(b - a, 1)} °C per min` : 'DS18B20';
      }
      case 'lux': return `Amber below ${L.lux.amber} lx`;
      case 'ir': return `${S.totals.parts} counted`;
      case 'gate': return `${S.totals.rej} rejected`;
      default: return '';
    }
  }

  function render() {
    for (const s of N.SENSORS) {
      const t = tiles[s.key], d = describe(s);
      setState(t, d.cls, d.word);
      t.value.className = 'value' + (d.dim ? ' dim' : '');
      t.value.innerHTML = '';
      t.value.append(d.value);
      if (d.unit) t.value.append(el('small', { text: d.unit }));
      t.foot.textContent = foot(s);
      t.root.classList.toggle('alarm-red', d.state === 'red' || d.state === 'stopped');
      t.root.classList.toggle('alarm-amber', d.state === 'amber');
      N.charts.spark(t.canvas, s, SPARK_MS);
    }
    if (D.open) renderDetail();
  }

  // ---------- detail sheet ----------
  function openDetail(key) {
    D.open = true; D.key = key;
    $('detail').hidden = false;
    renderDetail();
  }
  function closeDetail() { D.open = false; D.paused = null; D.cursor = null; $('detail').hidden = true; $('dPause').textContent = 'Pause'; }

  function window_() {
    const t1 = D.paused || Date.now();
    return [t1 - D.span, t1];
  }

  function renderDetail() {
    const s = sensorOf(D.key);
    $('dTitle').textContent = `${s.title} · ${s.part}`;
    for (const b of $('dRanges').children) b.classList.toggle('on', +b.dataset.ms === D.span);
    for (const b of $('dSwitch').children) b.classList.toggle('on', b.dataset.key === D.key);
    const [t0, t1] = window_();
    const cursorT = D.cursor || D.hover;
    const geo = N.charts.big($('dChart'), s, t0, t1, cursorT);
    D.geo = geo;
    // value at the cursor (or now)
    let at = null, atT = null;
    if (cursorT) {
      const i = Math.min(S.hist.length - 1, N.store.histFrom(cursorT));
      if (i >= 0 && S.hist[i]) { at = S.hist[i][s.key]; atT = S.hist[i].t; }
    }
    const d = describe(s, at);
    let valueText = d.value + (d.unit ? ' ' + d.unit : '');
    let stateText = d.word, stateCls = d.cls;
    if (atT) {
      if (s.binary) valueText = at ? (s.key === 'gate' ? 'Open' : 'Part') : (s.key === 'gate' ? 'Closed' : 'Clear');
      else {
        valueText = `${fmt(at, s.d)} ${s.unit}`;
        const j = N.alarms.judge(s, N.alarms.medianAt(s.key, atT), S.hist[N.store.histFrom(atT)]);
        stateText = N.alarms.stateWord(s, j); stateCls = { ok: 'st-ok', amber: 'st-amber', red: 'st-red', stopped: 'st-red', none: 'st-none' }[j];
      }
    }
    $('dNowLabel').textContent = atT ? `At ${hms(atT)}${D.paused ? ' (paused)' : ''}` : 'Now';
    $('dValue').textContent = valueText;
    $('dState').className = stateCls; $('dState').textContent = stateText;
    // stats for the view
    const pts = N.charts.series(s.key, t0, t1).filter(p => p[1] != null);
    const dl = $('dStats'); dl.innerHTML = '';
    const row = (k, v) => dl.append(el('dt', { text: k }), el('dd', { text: v }));
    if (!pts.length) row('Readings in view', '0');
    else if (s.binary) {
      let edges = 0; for (let i = 1; i < pts.length; i++) if (pts[i][1] && !pts[i - 1][1]) edges++;
      row('Readings in view', String(pts.length));
      row(s.key === 'gate' ? 'Gate openings' : 'Parts seen', String(edges));
      row('Time active', `${fmt(pts.filter(p => p[1]).length / pts.length * 100, 1)} %`);
    } else {
      let lo = pts[0], hi = pts[0], sum = 0, over = 0;
      const L = S.settings.limits[s.lim];
      for (const p of pts) {
        sum += p[1]; if (p[1] < lo[1]) lo = p; if (p[1] > hi[1]) hi = p;
        if (s.dir === 'low' ? p[1] <= L.amber : p[1] >= L.amber) over++;
      }
      row('Average', `${fmt(sum / pts.length, s.d)} ${s.unit}`);
      row('Lowest', `${fmt(lo[1], s.d)} at ${hms(lo[0])}`);
      row('Highest', `${fmt(hi[1], s.d)} at ${hms(hi[0])}`);
      row(s.dir === 'low' ? 'Below amber' : 'Above amber', `${fmt(over / pts.length * 100, 1)} %`);
      row('Amber / red', `${L.amber} / ${L.red} ${s.unit}`);
    }
  }

  function step(dir) {
    if (!D.paused) return;
    const i = N.store.histFrom(D.cursor || D.paused) + dir;
    if (S.hist[i]) D.cursor = S.hist[i].t;
    renderDetail();
  }

  function togglePause() {
    if (D.paused) { D.paused = null; D.cursor = null; $('dPause').textContent = 'Pause'; }
    else { D.paused = Date.now(); D.cursor = D.hover || (S.hist.length ? S.hist[S.hist.length - 1].t : null); $('dPause').textContent = 'Resume chart'; }
    renderDetail();
  }

  function initDetail() {
    for (const [ms, label] of RANGES) {
      $('dRanges').append(el('button', { text: label, dataset: { ms }, onclick: () => { D.span = ms; renderDetail(); } }));
    }
    for (const s of N.SENSORS) {
      $('dSwitch').append(el('button', { class: 'key small', text: s.title, dataset: { key: s.key }, onclick: () => { D.key = s.key; renderDetail(); } }));
    }
    $('dClose').addEventListener('click', closeDetail);
    $('dPause').addEventListener('click', togglePause);
    $('detail').addEventListener('click', e => { if (e.target.id === 'detail') closeDetail(); });
    const cv = $('dChart');
    cv.addEventListener('mousemove', e => {
      if (!D.geo) return;
      const r = cv.getBoundingClientRect(), x = e.clientX - r.left, g = D.geo;
      if (x < g.L || x > g.w - g.R) { D.hover = null; return; }
      const t = g.t0 + (x - g.L) / (g.w - g.L - g.R) * (g.t1 - g.t0);
      if (D.paused) D.cursor = t; else D.hover = t;
      renderDetail();
    });
    cv.addEventListener('mouseleave', () => { D.hover = null; renderDetail(); });
    document.addEventListener('keydown', e => {
      if (!D.open || e.target.tagName === 'INPUT') return;
      if (e.key === 'Escape') closeDetail();
      else if (e.key === ' ') { e.preventDefault(); togglePause(); }
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    });
  }

  function init() {
    build(); initDetail();
    setInterval(render, 250);
    window.addEventListener('resize', render);
    render();
  }

  return { init, render, openDetail };
})();
