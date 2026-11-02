// csv.js — Save CSV (every telemetry line since the source started) and Save inspections (contract §6 fields:
// at, n, verdict, score, ms, v, ma, vib, vpk, lux, temp). Saved through the Mac's save panel (a download in a browser).
'use strict';

N.csv = (() => {
  const S = N.S;
  const { csvCell, stamp } = N.util;
  const iso = t => new Date(t).toISOString();

  function telemetry() {
    if (!S.hist.length) { N.util.toast('No readings to save yet.'); return; }
    const cols = ['time', 'unix_ms', 'v', 'ma', 'w', 'vib', 'vpk', 'lux', 'temp', 'ir', 'gate', 'belt', 'mode'];
    const rows = [cols.join(',')];
    for (const h of S.hist) {
      const w = h.v != null && h.ma != null ? (h.v * h.ma / 1000).toFixed(3) : '';
      rows.push([iso(h.t), h.t, h.v, h.ma, w, h.vib, h.vpk, h.lux, h.temp, h.ir, h.gate, h.belt, h.mode].map(csvCell).join(','));
    }
    const tag = S.source === 'demo' ? 'DEMO-' : '';
    N.bridge.saveText(`NAZAR-${tag}telemetry-${stamp()}.csv`, rows.join('\n') + '\n');
  }

  const FIELDS = ['at', 'n', 'verdict', 'score', 'ms', 'v', 'ma', 'vib', 'vpk', 'lux', 'temp'];

  function inspections() {
    if (!S.inspections.length) { N.util.toast('No inspections to save yet.'); return; }
    const rows = [FIELDS.join(',')];
    for (const r of S.inspections) rows.push(FIELDS.map(k => csvCell(r[k])).join(','));
    const tag = S.source === 'demo' ? 'DEMO-' : '';
    N.bridge.saveText(`NAZAR-${tag}inspections-${stamp()}.csv`, rows.join('\n') + '\n');
  }

  N.on('native:saved', path => { if (path) N.event('info', `Saved ${String(path).split('/').pop()}`); });

  return { telemetry, inspections, FIELDS };
})();
