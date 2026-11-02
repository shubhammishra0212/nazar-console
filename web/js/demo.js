// demo.js — a pretend ESP32 that lives in the page. It speaks exactly the serial protocol of CONTRACT.md (JSON lines
// out, text commands in), so Demo data runs through the same parser, alarms and inspection loop as a real board.
// Every ~90 s the motor mount "works loose" for ~25 s and the shaking climbs past amber and red; "Mark fix applied"
// in the 8D view stops that, so the before/after comparison has something to show.
'use strict';

N.demoBoard = (() => {
  let timer = 0, emit = null, b = null;

  function fresh() {
    return {
      t0: performance.now(), last: performance.now(), ms: 0,
      mode: 'RUN', belt: 1, parts: 0, rej: 0, gate: 0, ir: 0,
      cfg: { ...N.DEFAULTS.timing },
      nextPart: 2500,         // ms of belt running time until the next washer reaches the IR sensor
      irLeft: 0,              // ms the IR stays 1
      toStop: null,           // ms of running left until the belt stops under the camera
      insp: null,             // {n, stoppedFor, verdict}
      gates: [],              // [{n, left}] ms of running time until the gate fires
      gateOpen: 0,
      before: 'RUN',          // mode to return to after STOP
      temp: 32.5, vibLoose: 0, fixed: false, holdFor: 0,
    };
  }

  const send = obj => emit && emit(JSON.stringify(obj));

  function hello() {
    send({ t: 'hello', fw: '2.0.0-demo', sensors: { ina219: true, mpu6050: true, bh1750: true, ds18b20: true }, cfg: { ...b.cfg } });
  }

  function looseLevel(sec) {
    if (b.fixed) return 0;
    const phase = (sec - 40) % 90;                       // first episode 40 s in, then every 90 s
    if (sec < 40 || phase > 25) return 0;
    return phase < 12 ? phase / 12 : 1;                  // ramps up over 12 s, stays bad for 13 s
  }

  function step() {
    const now = performance.now();
    const dt = Math.min(250, now - b.last);
    b.last = now; b.ms += dt;
    const sec = b.ms / 1000;
    const running = b.belt === 1;

    // --- part flow (all timers count belt RUNNING time, like the firmware) ---
    if (running && b.mode === 'RUN') {
      b.nextPart -= dt;
      if (b.nextPart <= 0) {
        b.parts += 1;
        b.irLeft = 180;
        b.nextPart = 2200 + Math.random() * 1400;
        send({ t: 'part', n: b.parts });
        if (b.cfg.stops) b.toStop = b.cfg.stop_ms;
      }
    }
    if (b.irLeft > 0) { b.irLeft -= dt; b.ir = b.irLeft > 0 ? 1 : 0; } else b.ir = 0;
    if (running && b.toStop != null) {
      b.toStop -= dt;
      if (b.toStop <= 0) {
        b.toStop = null; b.belt = 0; b.mode = 'INSPECT';
        b.insp = { n: b.parts, stoppedFor: 0, verdict: null };
        send({ t: 'inspect', n: b.parts });
      }
    }
    if (b.mode === 'INSPECT' && b.insp) {
      b.insp.stoppedFor += dt;
      const v = b.insp.verdict;
      if (v && b.insp.stoppedFor >= b.cfg.dwell_ms) go(v === 'FAIL' ? 'reject' : 'pass');
      else if (!v && b.insp.stoppedFor >= b.cfg.wait_ms) go('timeout');
    }
    if (b.mode === 'HOLD') {
      b.holdFor += dt;
      if (b.holdFor > 12000) {                              // demo only: nobody is at the line to press Resume
        send({ t: 'log', msg: 'demo: hold released by itself after 12 s' });
        command('RESUME');
      }
    }
    if (b.belt) {
      for (const g of b.gates) g.left -= dt;
      const due = b.gates.filter(g => g.left <= 0);
      b.gates = b.gates.filter(g => g.left > 0);
      for (const g of due) { b.rej += 1; b.gateOpen = b.cfg.gate_open_ms; send({ t: 'gate', n: g.n }); }
    }
    if (b.gateOpen > 0) b.gateOpen -= dt;
    b.gate = b.gateOpen > 0 ? 1 : 0;

    // --- sensors ---
    const loose = looseLevel(sec);
    const target = 0.036 + loose * 0.15;
    b.vibLoose += (target - b.vibLoose) * 0.08;
    const vib = Math.max(0.004, (b.belt ? b.vibLoose : 0.006) + N.util.noise(b.belt ? 0.004 + loose * 0.012 : 0.001));
    const ma = b.belt ? 312 + loose * 70 + N.util.noise(9) : 6 + N.util.noise(2);
    b.temp += ((b.belt ? 37.5 + loose * 4 : 33) - b.temp) * 0.0015;
    const tel = {
      t: 'tel', ms: Math.round(b.ms),
      v: +(11.95 - ma * 0.00035 + N.util.noise(0.01)).toFixed(2),
      ma: +Math.max(0, ma).toFixed(1),
      vib: +vib.toFixed(3),
      vpk: +(vib * (2.4 + Math.random() * 0.6)).toFixed(3),
      lux: +(812 + N.util.noise(5)).toFixed(1),
      temp: +(b.temp + N.util.noise(0.05)).toFixed(1),
      ir: b.ir, parts: b.parts, rej: b.rej, gate: b.gate, belt: b.belt, mode: b.mode,
    };
    send(tel);
  }

  function go(res) {
    const n = b.insp ? b.insp.n : b.parts;
    if (res === 'reject') b.gates.push({ n, left: b.cfg.gate_ms });
    b.insp = null; b.mode = 'RUN'; b.belt = 1;
    send({ t: 'go', n, res });
  }

  function command(line) {
    const parts = line.trim().split(/\s+/);
    const cmd = (parts[0] || '').toUpperCase();
    if (!cmd) return;
    const ack = () => send({ t: 'ack', cmd });
    switch (cmd) {
      case 'PING': send({ t: 'pong' }); hello(); break;
      case 'PASS': case 'FAIL':
        if (b.mode === 'INSPECT' && b.insp) { b.insp.verdict = cmd; ack(); }
        else if (cmd === 'FAIL' && !b.cfg.stops) { b.gates.push({ n: b.parts, left: b.cfg.gate_ms }); ack(); }
        else send({ t: 'err', msg: `${cmd} but no part under the camera` });
        break;
      case 'HOLD':
        if (b.mode !== 'STOP') { b.mode = 'HOLD'; b.belt = 0; b.holdFor = 0; }
        ack(); break;
      case 'RESUME':
        if (b.mode === 'HOLD') {
          if (b.insp) { const n = b.insp.n; b.insp = null; send({ t: 'go', n, res: 'hold-released' }); }
          b.mode = 'RUN'; b.belt = 1;
        }
        ack(); break;
      case 'STOP':
        if (b.mode !== 'STOP') { b.before = b.mode; b.mode = 'STOP'; b.belt = 0; }
        ack(); break;
      case 'START':
        if (b.mode === 'STOP') { b.mode = b.before; b.belt = (b.mode === 'RUN') ? 1 : 0; }
        ack(); break;
      case 'REJECT': b.rej += 1; b.gateOpen = b.cfg.gate_open_ms; send({ t: 'gate', n: b.parts }); ack(); break;
      case 'BELT':
        if (b.mode === 'STOP') { b.belt = parts[1] === '1' ? 1 : 0; ack(); }
        else send({ t: 'err', msg: 'BELT only works in STOP mode' });
        break;
      case 'RESET': b.parts = 0; b.rej = 0; ack(); break;
      case 'SET': {
        const key = (parts[1] || '').toLowerCase(), val = parseInt(parts[2], 10);
        if (key in b.cfg && isFinite(val)) { b.cfg[key] = val; ack(); hello(); }
        else send({ t: 'err', msg: `bad SET ${parts.slice(1).join(' ')}` });
        break;
      }
      default: send({ t: 'err', msg: `unknown command ${cmd}` });
    }
  }

  return {
    start(onLine) {
      emit = onLine; b = fresh();
      send({ t: 'log', msg: 'NAZAR demo board starting' });
      hello();
      timer = setInterval(step, 100);
    },
    stop() { clearInterval(timer); timer = 0; emit = null; },
    write(text) { if (b) for (const l of String(text).split('\n')) command(l); },
    setFixed(on) { if (b) b.fixed = !!on; },
    get running() { return !!timer; },
    get vib() { return b ? b.vibLoose : 0; },
  };
})();
