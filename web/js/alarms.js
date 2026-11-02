// alarms.js — turns readings into plain-language states.
//
// Each sensor is judged on the MEDIAN of its last second of readings (one spike does not raise an alarm), and a new
// state must hold for 1 s before it shows (no flicker at the limit). A sensor whose key has been missing from the
// telemetry for 3 s shows "No signal". The line status picks one big word for the andon from all of that.
'use strict';

N.SENSORS = [
  { key: 'ma', title: 'Belt motor', unit: 'mA', d: 0, dir: 'high', lim: 'ma', min: 0, max: 1200, part: 'INA219',
    high: ['Belt motor is working harder than normal.', 'Check the belt for something rubbing or jammed.'],
    red: ['Belt motor current is too high.', 'Stop the line and clear whatever is jamming the belt.'],
    stopped: ['Belt motor is not drawing current.', 'Check the 5.5 V supply, switch S1, the relay and the motor wires.'] },
  { key: 'vib', title: 'Motor shaking', unit: 'g', d: 3, dir: 'high', lim: 'vib', min: 0, max: 0.25, part: 'MPU-6050',
    high: ['Motor is shaking more than normal.', 'Check the motor mount screws.'],
    red: ['Motor is shaking hard.', 'Stop the line and tighten the motor mount.'] },
  { key: 'temp', title: 'Motor temperature', unit: '°C', d: 1, dir: 'high', lim: 'temp', min: 20, max: 70, part: 'DS18B20',
    high: ['Motor is getting warm.', 'Check that nothing is rubbing. Let it cool if it keeps rising.'],
    red: ['Motor is too hot.', 'Stop the line and let the motor cool down.'] },
  { key: 'lux', title: 'Tunnel light', unit: 'lx', d: 0, dir: 'low', lim: 'lux', min: 0, max: 1200, part: 'BH1750',
    high: ['Camera tunnel light is low.', 'Check the LED tunnel is on and nothing blocks it.'],
    red: ['Camera tunnel is dark: the AI cannot see the parts.', 'Switch the tunnel light on.'] },
  { key: 'ir', title: 'Part sensor', unit: '', binary: true, part: 'FC-51' },
  { key: 'gate', title: 'Reject gate', unit: '', binary: true, part: 'MG996R' },
];

N.alarms = (() => {
  const S = N.S;
  const st = {};                 // key -> {state, since, cand, candSince, value}
  let line = { word: 'NOT CONNECTED', cls: 'a-none', since: Date.now(), head: 'No board connected', steps: [], buttons: {} };

  const SEVERITY = { red: 3, stopped: 3, amber: 2, none: 1, ok: 0, wait: 0 };
  const STATE_WORD = { ok: 'Normal', amber: 'High', red: 'Too high', stopped: 'Not running', none: 'No signal', wait: 'Waiting' };

  function reset() { for (const s of N.SENSORS) st[s.key] = { state: 'wait', since: Date.now(), cand: 'wait', candSince: Date.now(), value: null }; }
  reset();
  N.on('reset', reset);

  /** Median of a sensor over [t-ms, t]. */
  function medianAt(key, t, ms = 1000) {
    const h = S.hist, out = [];
    for (let i = h.length - 1; i >= 0 && h[i].t > t - ms; i--) if (h[i].t <= t && typeof h[i][key] === 'number') out.push(h[i][key]);
    return N.util.median(out);
  }

  /** Raw state of one analog sensor for a value (no hold time). */
  function judge(sensor, value, tel) {
    const L = S.settings.limits[sensor.lim];
    if (value == null) return 'none';
    if (sensor.key === 'ma' && tel && tel.belt === 1 && tel.mode === 'RUN' && value < L.stopped) return 'stopped';
    if (sensor.dir === 'low') return value <= L.red ? 'red' : value <= L.amber ? 'amber' : 'ok';
    return value >= L.red ? 'red' : value >= L.amber ? 'amber' : 'ok';
  }

  function stateWord(sensor, state) {
    if (sensor.dir === 'low' && (state === 'amber' || state === 'red')) return state === 'red' ? 'Too low' : 'Low';
    return STATE_WORD[state] || state;
  }

  function limitText(sensor, state) {
    const L = S.settings.limits[sensor.lim];
    const u = sensor.unit;
    if (state === 'stopped') return `below ${L.stopped} ${u} while the belt should run`;
    const lim = state === 'red' ? L.red : L.amber;
    return `${sensor.dir === 'low' ? 'limit below' : 'limit'} ${N.util.fmt(lim, sensor.d)} ${u}`;
  }

  function evaluate() {
    const now = Date.now();
    if (S.source === 'none') { computeLine(now); return; }
    const ref = S.link.openedAt || now;
    for (const s of N.SENSORS) {
      const x = st[s.key];
      const seen = S.lastSeen[s.key];
      const silent = now - Math.max(seen || 0, ref) >= 3000 && (!seen || now - seen >= 3000);
      let raw;
      if (silent) raw = 'none';
      else if (!seen) raw = 'wait';
      else if (s.binary) raw = 'ok';
      else { x.value = medianAt(s.key, now); raw = judge(s, x.value, S.tel); }
      if (raw !== x.cand) { x.cand = raw; x.candSince = now; }
      if (x.cand !== x.state && (now - x.candSince >= 1000 || x.state === 'wait')) {
        const old = x.state;
        x.state = x.cand; x.since = now;
        announce(s, old, x.state, x.value);
      }
    }
    computeLine(now);
  }

  function announce(s, from, to, v) {
    if (from === 'wait' && to === 'ok') return;
    const val = s.binary ? '' : `${N.util.fmt(v, s.d)} ${s.unit}`;
    if (to === 'none') N.event('amber', `${s.title}: no signal. The ${s.part} is not sending readings.`);
    else if (to === 'red' || to === 'stopped') N.event('red', `${s.title} ${stateWord(s, to).toLowerCase()}: ${val} (${limitText(s, to)})`);
    else if (to === 'amber') N.event('amber', `${s.title} ${stateWord(s, to).toLowerCase()}: ${val} (${limitText(s, to)})`);
    else if (to === 'ok' && from === 'none') N.event('ok', `${s.title}: signal is back.`);
    else if (to === 'ok') N.event('ok', `${s.title} back to normal: ${val}`);
  }

  function issues() {
    const out = [];
    for (const s of N.SENSORS) {
      const x = st[s.key];
      if (x.state === 'red' || x.state === 'stopped') out.push({ sev: 'red', head: (s[x.state] || s.red)[0], step: (s[x.state] || s.red)[1] });
      else if (x.state === 'amber') out.push({ sev: 'amber', head: s.high[0], step: s.high[1] });
      else if (x.state === 'none') out.push({ sev: 'amber', head: `${s.title} is not sending readings.`, step: `Check the ${s.part} wires to the ESP32.` });
    }
    return out.sort((a, b) => (b.sev === 'red') - (a.sev === 'red'));
  }

  /** Steps when the first issue is already the headline: its step alone, then the other issues in full. */
  const headFirst = iss => iss.map((i, k) => ({ cls: i.sev, text: k === 0 ? i.step : `${i.head} ${i.step}` }));

  function computeLine(now) {
    const L = { buttons: {} };
    const tel = S.tel;
    const mode = tel && tel.mode;
    const iss = issues();
    const reds = iss.filter(i => i.sev === 'red');
    const issueSteps = iss.map(i => ({ cls: i.sev, text: `${i.head} ${i.step}` }));
    const noData = S.source !== 'none' && now - Math.max(S.telAt || 0, S.link.openedAt || 0) >= 3000;

    if (S.source === 'none') {
      L.word = 'NOT CONNECTED'; L.cls = 'a-none';
      if (S.link.state === 'lost') {
        L.head = 'Connection lost';
        L.steps = [{ cls: 'red', text: 'Check the USB cable between the Mac and the ESP32.' },
          { cls: '', text: `The console reconnects to ${S.link.port.replace('/dev/', '')} by itself when the board is back.` }];
      } else if (S.link.state === 'connecting') {
        L.head = 'Connecting…'; L.steps = [];
      } else {
        L.head = 'No board connected';
        L.steps = [{ cls: '', text: 'Pick the ESP32 port and press Connect.' }, { cls: '', text: 'No board here? Press Demo data.' }];
      }
    } else if (noData) {
      L.word = 'NO DATA'; L.cls = 'a-none';
      L.head = 'The port is open but no readings arrive.';
      L.steps = [{ cls: 'amber', text: 'Wait a few seconds: the ESP32 restarts when the port opens.' },
        { cls: '', text: 'Check the firmware is uploaded and the baud rate is 115200.' }];
    } else if (reds.length && mode !== 'HOLD') {
      L.word = 'STOP & CHECK'; L.cls = 'a-red'; L.head = reds[0].head; L.steps = headFirst(iss);
    } else if (mode === 'HOLD') {
      L.word = 'ON HOLD'; L.cls = 'a-hold';
      L.head = S.held ? `Line on hold: part ${S.held.n} is held for checking` : 'Line on hold';
      L.steps = [...issueSteps.filter(s => s.cls === 'red'),
        { cls: 'amber', text: 'Check the held part. Take it off the belt if it is bad.' },
        { cls: 'amber', text: 'Then press Resume production.' }];
    } else if (mode === 'STOP') {
      L.word = 'STOPPED'; L.cls = 'a-stop'; L.head = 'Line stopped from the console';
      L.steps = [{ cls: '', text: 'The belt is off. The part under the camera and the gate timing wait where they are.' },
        { cls: 'ok', text: 'Press Start line to run again.' }, ...issueSteps];
    } else if (iss.length) {
      L.word = 'CHECK SOON'; L.cls = 'a-amber'; L.head = iss[0].head; L.steps = headFirst(iss);
    } else if (mode === 'INSPECT') {
      L.word = 'INSPECTING'; L.cls = 'a-insp';
      L.head = `Part ${N.inspect ? N.inspect.currentPart() || '' : ''} is stopped under the camera`.replace('Part  ', 'A part ');
      L.steps = [{ cls: 'ok', text: 'The AI is checking it. The belt restarts by itself.' }];
    } else {
      L.word = 'RUNNING'; L.cls = 'a-run'; L.head = 'Line running normally';
      L.steps = [{ cls: 'ok', text: 'All sensors are normal.' }];
    }
    L.buttons.resume = S.source !== 'none' && mode === 'HOLD';
    L.buttons.start = S.source !== 'none' && mode === 'STOP';
    L.since = L.word === line.word ? line.since : now;
    if (L.word !== line.word && S.source !== 'none' && L.word === 'NO DATA') N.event('amber', 'No readings from the ESP32 for 3 s.');
    line = L;
  }

  /** Learn normal from the last 10 s: limits relative to what the line does when it is fine. */
  function learnNormal() {
    const now = Date.now();
    const m = k => medianAt(k, now, 10000);
    const ma = m('ma'), vib = m('vib'), lux = m('lux');
    const L = S.settings.limits;
    const done = [];
    if (ma != null && ma > 20) { L.ma.amber = Math.round(ma * 1.6); L.ma.red = Math.round(ma * 2.4); done.push(`belt ${L.ma.amber}/${L.ma.red} mA`); }
    if (vib != null) {
      L.vib.amber = +Math.max(vib * 2, vib + 0.02).toFixed(3); L.vib.red = +Math.max(vib * 3.5, vib + 0.05).toFixed(3);
      done.push(`shaking ${L.vib.amber}/${L.vib.red} g`);
    }
    if (lux != null && lux > 20) { L.lux.amber = Math.round(lux * 0.6); L.lux.red = Math.round(lux * 0.35); done.push(`light below ${L.lux.amber}/${L.lux.red} lx`); }
    if (!done.length) return null;
    N.store.saveSettings();
    N.event('info', `Limits learned from the last 10 s: ${done.join(', ')}.`);
    return done.join(', ');
  }

  setInterval(evaluate, 250);

  return {
    state: key => st[key],
    stateWord, judge, medianAt, learnNormal, evaluate,
    line: () => line,
  };
})();
