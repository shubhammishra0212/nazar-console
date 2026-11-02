// link.js — the connection to the board: connect / disconnect / demo, splitting the byte stream into lines, parsing the
// JSON messages of CONTRACT.md §1, sending text commands (§2), pushing the timing config with SET, and reconnecting
// by itself when the cable comes back. Everything it learns goes on the bus: 'tel', 'hello', 'msg:part', 'msg:inspect',
// 'msg:go', 'msg:gate', 'line' (raw, for the serial monitor) and 'link' (state changed).
'use strict';

N.link = (() => {
  const S = N.S;
  let buf = '';
  let retryTimer = 0, pingTimer = 0, rateTimer = 0;
  let linesThisSecond = 0;
  let wantPort = '';             // the port we are trying to (re)connect to
  let seenPorts = [];            // port list of the last refresh, to spot a board that was just plugged in
  const lastSet = {};            // key -> time we last sent SET for it (no SET storms)
  let lastStopResend = 0;

  function setState(state, extra) {
    Object.assign(S.link, { state }, extra || {});
    N.emit('link');
  }

  // ---------- incoming ----------
  function onText(text) {
    buf += text;
    if (buf.length > 65536) buf = buf.slice(-8192);   // garbage with no line ends (wrong baud)
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line) handleLine(line);
    }
  }

  function handleLine(line) {
    const now = Date.now();
    S.link.lastLineAt = now;
    S.link.lines += 1;
    linesThisSecond += 1;
    let m = null;
    if (line[0] === '{') { try { m = JSON.parse(line); } catch (e) { m = null; } }
    N.emit('line', line, m);
    if (!m || typeof m.t !== 'string') return;          // boot ROM noise, half lines: ignored
    switch (m.t) {
      case 'tel': N.store.addTel(m, now); N.emit('tel', m); break;
      case 'hello': onHello(m); break;
      case 'pong':
        if (!S.link.linkOk) N.event('ok', 'Two-way link OK: the ESP32 answered PING.');
        S.link.linkOk = true; N.emit('link'); break;
      case 'ack': N.emit('msg:ack', m); break;
      // a refused command (late or duplicate verdict, verdict during HOLD) is logged; the link itself is fine
      case 'err': N.event('amber', `The ESP32 refused a command: ${m.msg || '?'}`); N.emit('msg:err', m); break;
      case 'part': case 'inspect': case 'go': case 'gate': N.emit('msg:' + m.t, m); break;
      case 'log': break;                                  // serial monitor only
      default: break;                                     // unknown types are ignored (contract §1)
    }
  }

  const SENSOR_NAMES = { ina219: 'INA219 (belt motor)', mpu6050: 'MPU-6050 (shaking)', bh1750: 'BH1750 (light)', ds18b20: 'DS18B20 (temperature)' };

  function onHello(m) {
    const firstHello = !S.link.fw;
    const before = S.link.sensors;
    S.link.fw = m.fw || '?';
    S.link.sensors = m.sensors || null;
    S.link.cfg = m.cfg || null;
    if (firstHello) {
      const missing = Object.entries(m.sensors || {}).filter(([, ok]) => !ok).map(([k]) => SENSOR_NAMES[k] || k);
      N.event(missing.length ? 'amber' : 'info',
        `ESP32 firmware ${S.link.fw}. ${missing.length ? 'Not found: ' + missing.join(', ') + '.' : 'All four sensors found.'}`);
    } else if (before && m.sensors) {
      for (const [k, ok] of Object.entries(m.sensors)) {
        if (before[k] !== ok) N.event(ok ? 'ok' : 'amber', `${SENSOR_NAMES[k] || k} ${ok ? 'is back' : 'disappeared'}.`);
      }
    }
    // after a reboot (or a reconnect) the firmware starts in RUN with the belt on: put back the operator's Stop
    if (S.stopRequested && Date.now() - lastStopResend > 2000) { lastStopResend = Date.now(); send('STOP', true); }
    syncTiming();
    N.emit('hello', m);
    N.emit('link');
  }

  /** Send SET for every timing value that differs from the board's cfg (only keys the firmware reports). */
  function syncTiming() {
    const cfg = S.link.cfg;
    if (!cfg || S.source === 'none') return;
    const now = Date.now();
    for (const [k, v] of Object.entries(S.settings.timing)) {
      if (!(k in cfg) || cfg[k] === v) continue;
      if (lastSet[k] && now - lastSet[k] < 3000) continue;
      lastSet[k] = now;
      send(`SET ${k} ${Math.round(v)}`);
    }
  }

  // ---------- outgoing ----------
  function send(text, quiet) {
    if (S.source === 'none') return false;
    const line = String(text).trim();
    if (!line) return false;
    if (S.source === 'demo') N.demoBoard.write(line);
    else N.bridge.write(line + '\n');
    N.emit('tx', line, quiet);
    return true;
  }

  // ---------- connect / disconnect ----------
  function refreshPorts() { N.bridge.listPorts(); }

  /** USB-serial chips (CP2102, CH340, FTDI, native USB). Bluetooth earbuds and speakers also show up as /dev/cu.* */
  const isUSB = p => /usbserial|usbmodem|slab|wchusb|ch34|cp210|ftdi/i.test(p || '');

  function connect(path) {
    if (!path) return;
    if (S.source === 'demo') stopDemo(true);
    const samePort = path === S.link.port && S.link.state === 'lost';
    if (!samePort) { N.store.resetData(); }
    wantPort = path;
    buf = '';
    setState('connecting', { port: path });
    N.bridge.open(path, S.settings.baud || 115200);
  }

  function disconnect() {
    clearTimeout(retryTimer); retryTimer = 0;
    wantPort = '';
    if (S.source === 'live') N.bridge.close();
    if (S.source === 'demo') { stopDemo(); return; }
    S.source = 'none';
    setState('idle', { openedAt: 0 });
  }

  function startDemo() {
    if (S.source === 'live' || S.link.state === 'lost' || S.link.state === 'connecting') {
      clearTimeout(retryTimer); wantPort = ''; N.bridge.close();
    }
    N.store.resetData();
    S.source = 'demo';
    buf = '';
    setState('demo', { port: 'demo', openedAt: Date.now(), lastLineAt: 0 });
    N.event('info', 'Demo data started. These readings are made up.');
    N.demoBoard.start(line => onText(line + '\n'));
  }

  function stopDemo(silent) {
    N.demoBoard.stop();
    S.source = 'none';
    N.store.resetData();
    if (!silent) N.event('info', 'Demo data stopped.');
    setState('idle', { port: '', openedAt: 0 });
  }

  // ---------- answers from the Mac ----------
  N.on('native:ports', list => {
    N.emit('ports', list);
    const plugged = list.filter(p => isUSB(p) && !seenPorts.includes(p));
    seenPorts = list;
    const auto = window.__NAZAR_AUTOCONNECT;
    if (auto && !N.autoTried && S.source === 'none' && list.includes(auto)) {
      N.autoTried = true;
      connect(auto);                                      // test hook (NAZAR_AUTOCONNECT)
    } else if (S.link.state === 'lost' && wantPort && list.includes(wantPort)) {
      connect(wantPort);
    } else if (S.link.state === 'idle' && S.source === 'none' && !N.autoTried && S.settings.port && list.includes(S.settings.port)) {
      N.autoTried = true;
      connect(S.settings.port);                           // at launch: back to the last port by itself
    } else if (S.link.state === 'idle' && S.source === 'none' && plugged.length === 1) {
      N.autoTried = true;
      N.event('info', `ESP32 found on ${plugged[0].replace('/dev/', '')}. Connecting by itself.`);
      connect(plugged[0]);                                // a board was just plugged in (or is the only one at launch)
    }
  });

  N.on('native:opened', path => {
    const reconnect = S.link.state === 'connecting' && S.link.wasLost;
    S.source = 'live';
    S.settings.port = path; N.store.saveSettings();
    setState('open', { port: path, openedAt: Date.now(), lastLineAt: 0, wasLost: false, linkOk: false });
    N.event('ok', `${reconnect ? 'Reconnected' : 'Connected'} to ${path.replace('/dev/', '')}. The ESP32 restarts when the port opens.`);
    clearTimeout(pingTimer);
    pingTimer = setTimeout(() => { if (S.source === 'live') send('PING', true); }, 2500);   // after its reboot
  });

  N.on('native:data', text => { if (S.source === 'live') onText(text); });

  N.on('native:closed', (reason, unexpected) => {
    if (S.source !== 'live' && S.link.state !== 'connecting') return;
    S.source = 'none';
    if (unexpected && wantPort) {
      N.event('red', `Connection lost: ${reason}. Reconnecting when the board is back.`);
      setState('lost', { wasLost: true });
      scheduleRetry();
    } else {
      N.event('info', `Disconnected from ${S.link.port.replace('/dev/', '')}.`);
      setState('idle', { openedAt: 0 });
    }
  });

  N.on('native:error', msg => {
    if (S.link.state === 'connecting' && S.link.wasLost) { setState('lost'); scheduleRetry(); return; }
    if (S.link.state === 'connecting') { S.source = 'none'; setState('idle'); }
    N.event('amber', msg);
    N.util.toast(msg, 5000);
  });

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (S.link.state === 'lost') { refreshPorts(); scheduleRetry(); } }, 1500);
  }

  // lines per second, for the key bar
  rateTimer = setInterval(() => { S.link.rate = linesThisSecond; linesThisSecond = 0; }, 1000);

  return { refreshPorts, connect, disconnect, startDemo, stopDemo, send, syncTiming, handleLine, isUSB };
})();
