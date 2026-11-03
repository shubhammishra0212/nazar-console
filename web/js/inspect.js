// inspect.js — the inspection loop. The rule that matters: THE LINE NEVER WAITS ON THE AI.
//
//   {"t":"inspect","n":18}  → wait settle (300 ms, the washer stops wobbling) → grab a JPEG of the camera frame
//   → POST it to the vision service /inspect with a 2 s timeout → send PASS / FAIL / HOLD to the ESP32.
//
// NO_PART, AI offline, an error or a timeout are logged and answered with PASS, so the belt moves on. (The firmware
// also lets the part pass by itself after wait_ms if no verdict arrives at all.) With `stops 0` firmware the belt
// never stops: `inspect` still arrives when the part reaches the camera, the verdict is sent the same way, and the
// ESP32 times the gate; no `go` follows, so we do not wait for one.
'use strict';

N.inspect = (() => {
  const S = N.S;
  const { fetchT, sleep, fmt } = N.util;
  let current = null;                 // {n, at, kind}
  const done = new Set();             // parts the board already moved on (go seen): never send a late verdict

  const vurl = path => S.settings.ai.visionUrl.replace(/\/+$/, '') + path;

  // The firmware sends `inspect` in both modes: stop-and-inspect (belt stopped, a `go` follows) and continuous
  // (`stops 0`: belt keeps running, mode stays RUN, no `go`).
  N.on('msg:inspect', m => run(m.n, S.link.cfg && S.link.cfg.stops === 0 ? 'flow' : 'stop'));
  N.on('msg:go', m => {
    done.add(m.n);
    if (done.size > 200) done.delete(done.values().next().value);
    if (m.res === 'timeout') N.event('amber', `Part ${m.n} passed without a verdict (no answer within ${S.link.cfg ? S.link.cfg.wait_ms : 5000} ms). The line did not wait.`);
    if (m.res === 'hold-released') N.event('ok', `Part ${m.n} released from hold. Production resumed.`);
    if (S.held && S.held.n === m.n) S.held = null;
    if (current && current.n === m.n) current = null;
    N.emit('inspection-state');
  });
  N.on('msg:gate', m => {
    if (!N.stopGate()) N.event('info', m.n ? `Reject gate fired for part ${m.n}.` : 'Reject gate fired (manual test).');
    else if (m.n) N.event('red', `Gate closed for part ${m.n}: it will be stopped at the gate. Take it off the belt; the next good washer opens the gate again.`);
    else N.event('info', 'Gate closed by hand (test). Press Open gate on the Reject gate tile to open it.');
  });
  N.on('reset', () => { current = null; done.clear(); });

  async function run(n, kind) {
    if (S.source === 'none' || (current && current.n === n)) return;
    current = { n, at: Date.now(), kind };
    done.delete(n);
    N.emit('inspection-state');
    const source = S.source;

    if (!S.settings.ai.on && source !== 'demo') {
      finish(n, kind, { skip: 'AI_OFF' }, null, Date.now());
      return;
    }
    await sleep(S.settings.ai.settleMs || 0);
    if (S.source !== source) return;

    const at = Date.now();
    const tel = snapshot(at);                     // sensors at the moment of the photo (contract §6), see snapshot()
    let result;
    if (source === 'demo' && !S.settings.ai.demoUsesAI) {
      await sleep(40 + Math.random() * 40);
      result = fake(tel);
    } else {                                      // live, or Demo with "ask the real AI" ticked
      const blob = await N.camera.grabFrame();
      if (!blob) result = { skip: 'NO_CAMERA' };
      else result = await ask(blob);
    }
    if (S.source !== source) return;
    finish(n, kind, result, tel, at);
  }

  /** Sensor values for the inspection row. Light and temperature are taken at the photo. The belt is stopped at the
   *  photo in stop-and-inspect mode, so motor current and shaking would always read "motor off"; for v, ma, vib and
   *  vpk we take the median of the last second the belt was RUNNING before the stop (within 5 s). That is the state
   *  the washer travelled in, and what the root-cause statistics need. */
  function snapshot(at) {
    if (!S.tel) return null;
    const out = { ...S.tel };
    const h = S.hist;
    let end = -1;
    for (let i = h.length - 1; i >= 0 && h[i].t > at - 5000; i--) if (h[i].belt === 1) { end = i; break; }
    if (end >= 0) {
      for (const k of ['v', 'ma', 'vib', 'vpk']) {
        const vals = [];
        for (let i = end; i >= 0 && h[i].t > h[end].t - 1000; i--) if (h[i].belt === 1 && typeof h[i][k] === 'number') vals.push(h[i][k]);
        const m = N.util.median(vals);
        if (m != null) out[k] = +m.toFixed(k === 'vib' || k === 'vpk' ? 4 : 2);
      }
    }
    return out;
  }

  async function ask(blob) {
    const q = [];
    if (S.settings.ai.hold != null && S.settings.ai.hold !== '') q.push(`hold=${S.settings.ai.hold}`);
    if (S.settings.ai.reject != null && S.settings.ai.reject !== '') q.push(`reject=${S.settings.ai.reject}`);
    const t0 = performance.now();
    try {
      const r = await fetchT(vurl('/inspect' + (q.length ? '?' + q.join('&') : '')),
        { method: 'POST', body: blob, headers: { 'Content-Type': 'image/jpeg' } }, 2000);
      const j = await r.json();
      if (!j || !j.ok) return { skip: 'AI_ERROR', msg: (j && j.error) || `HTTP ${r.status}` };
      S.ai = { ...S.ai, state: 'ready', ms: j.ms ?? Math.round(performance.now() - t0), hold: j.hold, reject: j.reject, checkedAt: Date.now() };
      return j;
    } catch (e) {
      const timeout = e && e.name === 'AbortError';
      if (!timeout) S.ai = { ...S.ai, state: 'offline', checkedAt: Date.now() };
      N.emit('ai');
      return { skip: timeout ? 'TIMEOUT' : 'AI_OFFLINE' };
    }
  }

  const SKIP_TEXT = {
    AI_OFF: 'AI inspection is switched off', NO_CAMERA: 'no camera picture', AI_ERROR: 'the AI returned an error',
    TIMEOUT: 'the AI took longer than 2 s', AI_OFFLINE: 'the AI service is not running', NO_PART: 'no washer found in the photo',
  };

  function finish(n, kind, r, tel, at) {
    const verdict = r.verdict || r.skip;                        // PASS HOLD REJECT NO_PART or a skip code
    const real = verdict === 'PASS' || verdict === 'HOLD' || verdict === 'REJECT';
    // the command to the ESP32
    const cmd = verdict === 'REJECT' ? 'FAIL' : verdict === 'HOLD' ? 'HOLD' : 'PASS';
    if (cmd && !done.has(n) && S.source !== 'none') N.link.send(cmd, true);
    else if (cmd && done.has(n)) N.event('amber', `Verdict for part ${n} came after the belt had moved on; not sent.`);

    const t = tel || {};
    const dmg = r.damage ? { kind: r.damage.kind, label: r.damage.label, spots: r.damage.spots, where: r.damage.where,
      zone: r.damage.zone, clock: r.damage.clock, area_pct: r.damage.area_pct, match: r.damage.match } : null;
    const row = { at, n, verdict, score: r.score ?? null, ms: r.ms ?? null, v: t.v ?? null, ma: t.ma ?? null, vib: t.vib ?? null,
      vpk: t.vpk ?? null, lux: t.lux ?? null, temp: t.temp ?? null, damage: dmg };
    S.inspections.push(row);
    if (S.inspections.length > 20000) S.inspections.shift();
    S.lastInsp = { ...row, crop: r.crop || null, heatmap: r.heatmap || null, hold: r.hold ?? null, reject: r.reject ?? null, real,
      damageText: r.damage ? r.damage.text : '' };
    if (verdict === 'REJECT' && dmg) {
      S.rejectShots.push({ n, at, score: r.score, damage: r.damage, crop: r.crop || null, heatmap: r.heatmap || null });
      if (S.rejectShots.length > 24) S.rejectShots.shift();
    }

    const what = r.damage ? ` ${r.damage.text}.` : '';
    if (verdict === 'HOLD') S.held = { n, crop: r.crop, heatmap: r.heatmap, score: r.score };
    if (verdict === 'REJECT') N.event('red', `Part ${n}: REJECT (score ${fmt(r.score, 2)}).${what} ${N.stopGate() ? 'The gate will stop it.' : 'The gate will push it off.'}`);
    else if (verdict === 'HOLD') N.event('amber', `Part ${n}: HOLD (score ${fmt(r.score, 2)}).${what} The line waits for a person to check it.`);
    else if (!real) N.event(verdict === 'NO_PART' ? 'info' : 'amber', `Part ${n}: not judged (${SKIP_TEXT[verdict] || verdict}). Sent PASS so the line keeps moving.`);
    if (current && current.n === n && kind === 'flow') current = null;
    N.emit('inspection', row);
    N.emit('inspection-state');
  }

  // ---------- demo verdicts: ~85 % PASS, 8 % HOLD, 7 % REJECT, rejects mostly while the motor shakes ----------
  function fake(tel) {
    const shaking = tel && tel.vib >= S.settings.limits.vib.amber;
    const u = Math.random();
    const pR = shaking ? 0.22 : 0.02, pH = shaking ? 0.10 : 0.07;
    const verdict = u < pR ? 'REJECT' : u < pR + pH ? 'HOLD' : 'PASS';
    const score = verdict === 'REJECT' ? 0.46 + Math.random() * 0.3 : verdict === 'HOLD' ? 0.34 + Math.random() * 0.09 : 0.1 + Math.random() * 0.19;
    return { ok: true, verdict, score: +score.toFixed(3), hold: 0.33, reject: 0.44, ms: Math.round(45 + Math.random() * 20),
      crop: drawThumb(false, verdict !== 'PASS'), heatmap: drawThumb(true, verdict !== 'PASS'), box: [480, 200, 320, 320] };
  }

  const thumb = document.createElement('canvas');
  thumb.width = thumb.height = 128;
  function drawThumb(heat, defect) {
    const g = thumb.getContext('2d');
    const ang = Math.random() * Math.PI * 2;
    const dx = 64 + Math.cos(ang) * 34, dy = 64 + Math.sin(ang) * 34;
    if (!heat) {
      g.fillStyle = '#2f3436'; g.fillRect(0, 0, 128, 128);
      g.fillStyle = '#b8bbbb'; g.beginPath(); g.arc(64, 64, 56, 0, 7); g.arc(64, 64, 24, 0, 7, true); g.fill();
      g.strokeStyle = '#8e9292'; g.lineWidth = 2; g.beginPath(); g.arc(64, 64, 40, 0, 7); g.stroke();
      if (defect) { g.strokeStyle = '#4a3b30'; g.lineWidth = 3; g.beginPath(); g.moveTo(dx - 9, dy - 7); g.lineTo(dx + 9, dy + 6); g.stroke(); }
    } else {
      g.fillStyle = '#1d2f6b'; g.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 6; i++) {
        g.fillStyle = 'rgba(40,110,200,.35)'; g.beginPath(); g.arc(Math.random() * 128, Math.random() * 128, 14 + Math.random() * 16, 0, 7); g.fill();
      }
      if (defect) {
        for (const [r, c] of [[26, 'rgba(250,210,40,.55)'], [16, 'rgba(240,120,30,.75)'], [8, 'rgba(220,30,30,.95)']]) {
          g.fillStyle = c; g.beginPath(); g.arc(dx, dy, r, 0, 7); g.fill();
        }
      }
    }
    return thumb.toDataURL('image/png').split(',')[1];
  }

  // ---------- AI service health ----------
  async function health() {
    if (S.source === 'demo' && !S.settings.ai.demoUsesAI) { S.ai = { ...S.ai, state: 'demo' }; N.emit('ai'); return; }
    const t0 = performance.now();
    try {
      const r = await fetchT(vurl('/health'), {}, 1500);
      const j = await r.json();
      if (!j.ok) throw new Error('not ok');
      const was = S.ai.state;
      S.ai = { ...S.ai, state: 'ready', model: j.model || '', hold: j.hold, reject: j.reject, ms: S.ai.ms ?? Math.round(performance.now() - t0), checkedAt: Date.now() };
      if (was === 'offline') N.event('ok', `AI vision service is ready (${S.ai.model}).`);
    } catch (e) {
      if (S.ai.state === 'ready') N.event('amber', 'AI vision service stopped answering. Parts pass without a check until it is back.');
      S.ai = { ...S.ai, state: 'offline', checkedAt: Date.now() };
    }
    N.emit('ai');
  }
  setInterval(health, 5000);
  N.on('link', () => setTimeout(health, 50));

  function startAI() {
    const a = S.settings.ai;
    N.bridge.openFile(a.startVision);
    N.bridge.openFile(a.startAgent);
    N.event('info', 'Starting the AI services in Terminal windows. Leave them open.');
    setTimeout(health, 6000); setTimeout(health, 12000);
  }
  N.on('native:openedFile', (path, ok, msg) => {
    if (!ok) N.event('amber', `Could not open ${String(path).split('/').pop()}: ${msg}`);
  });

  return { run, startAI, health, currentPart: () => (current ? current.n : null), get busy() { return !!current; } };
})();
