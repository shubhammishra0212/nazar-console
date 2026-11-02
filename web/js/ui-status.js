// ui-status.js — the Line status panel: the andon word, a plain-language headline and steps, the held part with the
// green Resume production key, Start line after a Stop, and the counts (kept by the Mac, so they survive board reboots).
'use strict';

N.uiStatus = (() => {
  const { $, el, fmt, ago } = N.util;
  const S = N.S;
  let lastSteps = '';

  const img = b64 => (b64 ? `data:image/png;base64,${b64}` : '');

  function render() {
    const L = N.alarms.line();
    const now = Date.now();
    $('andon').className = 'andon ' + L.cls;
    $('andonWord').textContent = L.word;
    const secs = Math.floor((now - L.since) / 1000);
    $('andonFor').textContent = S.source === 'none' ? '' : `for ${secs < 60 ? secs + ' s' : Math.floor(secs / 60) + ' min'}`;
    $('statusHead').textContent = L.head;
    const key = JSON.stringify(L.steps);
    if (key !== lastSteps) {
      lastSteps = key;
      const ul = $('statusSteps'); ul.innerHTML = '';
      for (const s of L.steps || []) ul.append(el('li', { class: s.cls, text: s.text }));
    }
    $('btnResume').hidden = !L.buttons.resume;
    $('btnStart').hidden = !L.buttons.start;

    const h = S.held;
    $('heldBox').hidden = !(h && L.buttons.resume);
    if (h && L.buttons.resume) {
      if ($('heldCrop').dataset.n !== String(h.n)) {
        $('heldCrop').src = img(h.crop); $('heldHeat').src = img(h.heatmap); $('heldCrop').dataset.n = String(h.n);
      }
      $('heldTitle').textContent = `Part ${h.n} is held under the camera`;
      $('heldScore').textContent = `AI score ${fmt(h.score, 2)}: unsure. Red on the heatmap is where it looks different.`;
    }

    const T = S.totals;
    $('cParts').textContent = String(T.parts);
    $('cRate').textContent = String(T.partTimes.length);
    $('cRej').textContent = String(T.rej);
    $('cRejPct').textContent = `${fmt(T.parts ? T.rej / T.parts * 100 : 0, 1)} %`;
    $('cLast').textContent = T.lastPartAt ? ago(now - T.lastPartAt) : '—';
  }

  function init() {
    $('btnResume').addEventListener('click', () => {
      if (N.link.send('RESUME')) N.event('ok', 'Resume production pressed.');
    });
    $('btnStart').addEventListener('click', () => {
      if (N.link.send('START')) { S.stopRequested = false; N.event('ok', 'Start line pressed: the belt runs again.'); }
    });
    setInterval(render, 250);
    render();
  }

  return { init, render };
})();
