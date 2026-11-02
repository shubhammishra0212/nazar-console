// ui-inspect.js — the Inspection panel: last verdict, score bar with the hold and reject marks, crop and heatmap,
// a strip of the last 12 parts, PASS / HOLD / REJECT counts, and the AI status ("AI ready · 52 ms" / "AI offline").
'use strict';

N.uiInspect = (() => {
  const { $, el, fmt, hms } = N.util;
  const S = N.S;

  const img = b64 => (b64 ? `data:image/png;base64,${b64}` : '');

  function renderAI() {
    const a = S.ai, box = $('aiState');
    if (S.source === 'demo' && !S.settings.ai.demoUsesAI) { box.className = 'aistate demo'; box.textContent = 'Demo verdicts (no AI)'; }
    else if (!S.settings.ai.on) { box.className = 'aistate'; box.textContent = 'AI switched off'; }
    else if (a.state === 'ready') { box.className = 'aistate ok'; box.textContent = `AI ready${a.ms != null ? ' · ' + a.ms + ' ms' : ''}`; }
    else { box.className = 'aistate'; box.textContent = 'AI offline — click Start AI'; }
    $('btnStartAI').hidden = (S.source === 'demo' && !S.settings.ai.demoUsesAI) || a.state === 'ready';
  }

  function render() {
    const li = S.lastInsp;
    const vb = $('vBlock');
    if (!li) {
      vb.className = 'verdict'; $('vWord').textContent = '—';
      $('vMeta').textContent = N.inspect.busy ? 'Checking a part…' : 'No part inspected yet';
      $('vCrop').removeAttribute('src'); $('vHeat').removeAttribute('src');
      $('vFill').style.width = '0'; $('vScore').textContent = 'score —';
    } else {
      vb.className = 'verdict v-' + (li.real ? li.verdict : 'SKIP');
      $('vWord').textContent = li.real ? li.verdict : li.verdict === 'NO_PART' ? 'NO PART' : 'NOT CHECKED';
      $('vMeta').innerHTML = '';
      $('vMeta').append(`Part ${li.n} · ${hms(li.at)}`, el('br'),
        li.real ? `${li.ms != null ? li.ms + ' ms' : ''}` : 'Sent PASS: the line keeps moving');
      if (li.crop) $('vCrop').src = img(li.crop); else $('vCrop').removeAttribute('src');
      if (li.heatmap) $('vHeat').src = img(li.heatmap); else $('vHeat').removeAttribute('src');
      const hold = li.hold ?? S.ai.hold ?? 0.33, rej = li.reject ?? S.ai.reject ?? 0.44;
      const max = Math.max(1, rej * 1.8);
      const pos = v => `${Math.min(100, v / max * 100)}%`;
      $('vFill').style.width = li.score != null ? pos(li.score) : '0';
      $('vFill').style.background = li.verdict === 'REJECT' ? 'var(--bad)' : li.verdict === 'HOLD' ? 'var(--warn)' : 'var(--data)';
      $('vHoldMark').style.left = pos(hold); $('vRejMark').style.left = pos(rej);
      $('vScore').textContent = li.score != null ? `score ${fmt(li.score, 2)}` : 'score —';
    }
    // last 12
    const strip = $('vStrip'); strip.innerHTML = '';
    const last = S.inspections.slice(-12);
    for (let i = 0; i < 12; i++) {
      const r = last[i - (12 - last.length)];
      const real = r && (r.verdict === 'PASS' || r.verdict === 'HOLD' || r.verdict === 'REJECT');
      strip.append(el('i', { class: r ? (real ? r.verdict : 'SKIP') : '', title: r ? `Part ${r.n}: ${r.verdict}${r.score != null ? ' ' + fmt(r.score, 2) : ''}` : '' }));
    }
    let p = 0, h = 0, x = 0;
    for (const r of S.inspections) { if (r.verdict === 'PASS') p++; else if (r.verdict === 'HOLD') h++; else if (r.verdict === 'REJECT') x++; }
    $('nPass').textContent = p; $('nHold').textContent = h; $('nRej').textContent = x;
    renderAI();
  }

  function init() {
    $('btnStartAI').addEventListener('click', () => N.inspect.startAI());
    N.on('inspection', render);
    N.on('inspection-state', render);
    N.on('ai', renderAI);
    N.on('reset', render);
    N.on('counts-reset', render);
    N.on('link', render);
    render();
  }

  return { init, render };
})();
