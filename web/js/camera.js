// camera.js — the live camera picture (getUserMedia), the camera picker, Snapshot, Turn off/on, enlarge, the
// "too bright" meter, and grabFrame() which the inspection loop uses to take the photo. Nothing is ever drawn on top
// of the live picture. With Demo data and no real camera, a drawn "demo camera" shows washers on a belt, so the whole
// loop can be seen without hardware; it is labelled as such in the picker.
'use strict';

N.camera = (() => {
  const { $ } = N.util;
  const S = N.S;
  const DEMO_ID = 'demo-camera';
  let stream = null, label = '', currentId = '', devices = [];
  let demoCanvas = null, demoTimer = 0;
  const meterCanvas = document.createElement('canvas');
  meterCanvas.width = 160; meterCanvas.height = 90;

  const video = () => $('video');
  const msg = text => { $('feedMsg').textContent = text || ''; $('feedMsg').hidden = !text; };

  async function listDevices() {
    try {
      devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    } catch (e) { devices = []; }
    const sel = $('camSelect');
    sel.innerHTML = '';
    for (const d of devices) sel.append(new Option(d.label || 'Camera', d.deviceId));
    if (S.source === 'demo' || !devices.length) sel.append(new Option('Demo camera (drawn)', DEMO_ID));
    if (currentId) sel.value = currentId;
  }

  async function start(deviceId) {
    stop(true);
    if (deviceId === DEMO_ID) return startDemoCam();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      msg('This window cannot use the camera.');
      return;
    }
    msg('Camera is starting…');
    try {
      const want = deviceId || (devices.find(d => d.label === S.settings.camera) || {}).deviceId;
      stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: want ? { exact: want } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
      });
      const track = stream.getVideoTracks()[0];
      label = track.label || 'Camera';
      currentId = (track.getSettings && track.getSettings().deviceId) || want || '';
      video().srcObject = stream;
      msg('');
      S.settings.camera = label; S.settings.camOff = false; N.store.saveSettings();
      track.addEventListener('ended', () => { msg('The camera was unplugged or taken by another app.'); N.event('amber', `Camera ${label} stopped.`); });
      await listDevices();
      N.event('info', `Camera on: ${label}`);
      setTimeout(() => applySaved(label), 800);   // after the stream starts (starting can reset exposure)
    } catch (e) {
      await listDevices();
      if (S.source === 'demo') return startDemoCam();
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      msg(denied ? 'Camera permission is off. Turn it on in System Settings › Privacy & Security › Camera, then restart the app.'
        : 'No camera found. Plug in the USB camera, then pick it above.');
    }
    $('btnCamPower').textContent = 'Turn off';
    N.emit('camera');
  }

  function stop(switching) {
    if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
    clearInterval(demoTimer); demoTimer = 0;
    video().srcObject = null;
    if (!switching) {
      label = '';
      msg('Camera is off. Press Turn on to start it.');
      $('btnCamPower').textContent = 'Turn on';
      S.settings.camOff = true; N.store.saveSettings();
      N.emit('camera');
    }
  }

  /** Re-apply this camera's saved picture settings (webcams forget them when unplugged). */
  function applySaved(cam) {
    const saved = S.settings.camCtl[cam];
    if (!saved || !N.bridge.native) return;
    const items = [];
    for (const [key, v] of Object.entries(saved)) items.push({ key, ...v });
    items.sort((a, b) => (a.key === 'exposure' ? -1 : 0) - (b.key === 'exposure' ? -1 : 0));
    N.bridge.camSet(cam, items, true);
  }

  // ---------- the drawn demo camera ----------
  const washers = [];
  function startDemoCam() {
    if (!demoCanvas) { demoCanvas = document.createElement('canvas'); demoCanvas.width = 1280; demoCanvas.height = 720; }
    stream = demoCanvas.captureStream ? demoCanvas.captureStream(15) : null;
    label = 'Demo camera (drawn)'; currentId = DEMO_ID;
    if (stream) video().srcObject = stream;
    msg(stream ? '' : 'Demo camera needs a newer browser.');
    let last = performance.now();
    demoTimer = setInterval(() => { const now = performance.now(); drawDemo((now - last) / 1000); last = now; }, 66);
    drawDemo(0);
    listDevices();
    $('btnCamPower').textContent = 'Turn off';
    N.emit('camera');
  }
  N.on('msg:part', () => { if (currentId === DEMO_ID) washers.push({ x: -120, stop: true, seed: Math.random() }); });
  N.on('msg:go', () => { for (const w of washers) w.stop = false; });

  function drawDemo(dt) {
    const g = demoCanvas.getContext('2d'), W = 1280, H = 720, cx = W / 2;
    const running = S.tel ? S.tel.belt === 1 : true;
    g.fillStyle = '#2b2f31'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#3a3f42'; g.fillRect(0, 170, W, 380);                 // belt
    const off = (performance.now() / 6) % 80;
    g.fillStyle = '#34393c';
    for (let x = -80; x < W + 80; x += 80) g.fillRect(x + (running ? off : 0), 170, 6, 380);
    g.fillStyle = '#1f2224'; g.fillRect(0, 150, W, 20); g.fillRect(0, 550, W, 20);   // rails
    for (const w of washers) {
      const target = cx;
      if (running) w.x += (w.stop && w.x < target ? Math.max(260, (target - w.x) * 6) : 260) * dt;
      if (w.stop && w.x > target) w.x = target;
      const r = 120;
      g.fillStyle = '#b9bcbc'; g.beginPath(); g.arc(w.x, 360, r, 0, Math.PI * 2); g.arc(w.x, 360, r * 0.45, 0, Math.PI * 2, true); g.fill();
      g.strokeStyle = '#8d9191'; g.lineWidth = 4; g.beginPath(); g.arc(w.x, 360, r * 0.72, 0, Math.PI * 2); g.stroke();
      if (w.seed > 0.86) { g.strokeStyle = '#4a3b30'; g.lineWidth = 5; g.beginPath(); g.moveTo(w.x + 40, 300); g.lineTo(w.x + 85, 335); g.stroke(); }
    }
    while (washers.length && washers[0].x > W + 200) washers.shift();
    g.fillStyle = 'rgba(242,183,5,.9)'; g.font = '600 26px Barlow, sans-serif';
    g.fillText('DEMO CAMERA', 24, 44);
  }

  // ---------- frames for the AI and Snapshot ----------
  function frameCanvas() {
    const v = video();
    if (!v.videoWidth) return null;
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return c;
  }

  /** The current frame as a JPEG Blob (quality 0.9), or null when there is no picture. */
  function grabFrame() {
    const c = frameCanvas();
    if (!c) return Promise.resolve(null);
    return new Promise(res => c.toBlob(b => res(b), 'image/jpeg', 0.9));
  }

  function snapshot() {
    const c = frameCanvas();
    if (!c) { N.util.toast('No camera picture to save.'); return; }
    const b64 = c.toDataURL('image/png').split(',')[1];
    N.bridge.saveBase64(`NAZAR-snapshot-${N.util.stamp()}.png`, b64);
  }

  // ---------- too-bright meter: % of pure-white pixels in the middle of the picture ----------
  function meter() {
    const v = video(), el = $('brightMeter');
    if (!v.videoWidth) { $('brightPct').textContent = '--'; el.className = 'meter'; return; }
    const g = meterCanvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(v, 0, 0, 160, 90);
    const d = g.getImageData(40, 22, 80, 46).data;      // centre half of the picture
    let white = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] >= 250 && d[i + 1] >= 250 && d[i + 2] >= 250) white++;
    const pct = white / (d.length / 4) * 100;
    $('brightPct').textContent = `${N.util.fmt(pct, 1)} %`;
    el.className = 'meter ' + (pct >= 2 ? 'bad' : pct > 0.2 ? 'warn' : 'ok');
    el.title = pct >= 2 ? 'Too bright: part of the washer is pure white and the AI cannot see marks there. Shorten the exposure in Camera settings.'
      : 'Share of pure-white pixels in the middle of the picture. Aim for 0 %.';
  }
  setInterval(meter, 500);

  function enlarge(on) { $('cameraGroup').classList.toggle('big', on); }

  function init() {
    $('feed').addEventListener('click', e => { if (e.target.id !== 'btnFeedClose') enlarge(true); });
    $('btnFeedClose').addEventListener('click', e => { e.stopPropagation(); enlarge(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') enlarge(false); });
    $('btnSnapshot').addEventListener('click', snapshot);
    $('btnCamPower').addEventListener('click', () => (stream ? stop() : start(currentId)));
    $('camSelect').addEventListener('change', e => start(e.target.value));
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', listDevices);
    }
    N.on('link', () => {
      // demo camera only with demo data; a real camera is kept whatever the source
      if (S.source !== 'demo' && currentId === DEMO_ID) { stop(true); label = ''; currentId = ''; msg('No camera found. Plug in the USB camera, then pick it above.'); listDevices(); }
      else if (S.source === 'demo' && !stream && !S.settings.camOff) start(DEMO_ID);
      else listDevices();
    });
    if (S.settings.camOff) { stop(); listDevices(); } else start();
  }

  return { init, start, stop, grabFrame, snapshot, applySaved, get label() { return label; }, get on() { return !!stream; }, DEMO_ID };
})();
