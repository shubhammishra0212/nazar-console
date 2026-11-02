// ui-top.js — title bar (port picker, Connect, Demo, Stop line, connection pill, clocks), the striped status band
// and the readouts in the key bar.
'use strict';

N.uiTop = (() => {
  const { $, duration, hms, fmt } = N.util;
  const S = N.S;
  let ports = [];

  const short = p => (p || '').replace('/dev/', '');

  function renderPorts() {
    const sel = $('portSelect');
    const keep = sel.value || S.link.port || S.settings.port;
    sel.innerHTML = '';
    if (!ports.length) sel.append(new Option(N.bridge.native ? 'No ESP32 found — plug it in' : 'USB needs the Mac app', ''));
    for (const p of ports) sel.append(new Option(short(p), p));
    if (keep && ports.includes(keep)) sel.value = keep;
  }

  function render() {
    const st = S.link.state;
    const pill = $('pill'), band = $('band');
    let pillCls = '', pillText = 'Not connected', word = 'NOT CONNECTED',
      text = 'Pick the ESP32 port and press Connect, or press Demo data.';
    if (S.source === 'demo') {
      pillCls = 'demo'; pillText = 'Demo data'; word = 'DEMO DATA';
      text = 'Made-up readings for practice. Nothing on this screen comes from the line.';
    } else if (S.source === 'live') {
      pillCls = 'live'; pillText = 'Connected'; word = 'LIVE DATA';
      text = `Readings from the ESP32 on ${short(S.link.port)}${S.link.fw ? ' · firmware ' + S.link.fw : ''}${S.link.linkOk ? ' · two-way link OK' : ''}.`;
    } else if (st === 'lost') {
      pillCls = 'lost'; pillText = 'Connection lost'; word = 'CONNECTION LOST';
      text = `The ESP32 on ${short(S.link.port)} stopped answering. The console reconnects by itself when it is back.`;
    } else if (st === 'connecting') {
      pillCls = 'wait'; pillText = 'Connecting'; text = `Opening ${short(S.link.port)}…`;
    }
    pill.className = 'pill ' + pillCls;
    $('pillText').textContent = pillText;
    $('pillPort').textContent = S.source === 'live' || st === 'lost' || st === 'connecting' ? short(S.link.port) : '';
    band.className = 'band' + (st === 'lost' ? ' lost' : '');
    $('bandWord').textContent = word;
    $('bandText').textContent = text;

    const busy = S.source === 'live' || st === 'lost' || st === 'connecting';
    $('btnConnect').textContent = busy ? 'Disconnect' : 'Connect';
    $('btnConnect').disabled = !busy && !$('portSelect').value;
    $('btnDemo').textContent = S.source === 'demo' ? 'Stop demo' : 'Demo data';
    $('btnDemo').classList.toggle('on', S.source === 'demo');
    $('btnStopLine').disabled = S.source === 'none';
  }

  function tick() {
    const now = Date.now();
    $('clock').textContent = hms(now);
    $('connFor').textContent = S.source !== 'none' && S.link.openedAt ? duration(now - S.link.openedAt) : '--:--:--';
    $('rRate').textContent = fmt(S.link.rate, 1);
    $('rAge').textContent = S.source !== 'none' && S.link.lastLineAt ? `${fmt((now - S.link.lastLineAt) / 1000, 1)} s` : '—';
    $('rBaud').textContent = S.source === 'demo' ? 'demo' : String(S.settings.baud);
    $('rFw').textContent = S.link.fw || '—';
  }

  function init() {
    $('btnConnect').addEventListener('click', () => {
      const busy = S.source === 'live' || S.link.state === 'lost' || S.link.state === 'connecting';
      if (busy) N.link.disconnect(); else N.link.connect($('portSelect').value);
    });
    $('btnDemo').addEventListener('click', () => (S.source === 'demo' ? N.link.stopDemo() : N.link.startDemo()));
    $('btnStopLine').addEventListener('click', () => {
      if (N.link.send('STOP')) {
        S.stopRequested = true;
        N.event('info', 'Stop line pressed: the belt is stopped from the console. Press Start line to run again.');
      }
    });
    $('portSelect').addEventListener('mousedown', () => N.link.refreshPorts());
    $('portSelect').addEventListener('change', render);
    N.on('ports', list => { ports = list; renderPorts(); render(); });
    N.on('link', render);
    N.on('hello', render);
    setInterval(tick, 250);
    setInterval(() => { if (S.source === 'none' && S.link.state !== 'lost') N.link.refreshPorts(); }, 3000);
    renderPorts(); render(); tick();
  }

  return { init, render };
})();
