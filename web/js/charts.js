// charts.js — canvas line charts, drawn by hand (no chart library: the page must work offline and stay light).
// One blue line for the data, amber and red dashed lines for the limits, a light fill under binary signals.
// Long time ranges are reduced to min/max per pixel column, so 15 minutes (9000 readings) still draw quickly.
'use strict';

N.charts = (() => {
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const colors = () => ({
    data: css('--data'), fill: css('--data-fill'), warn: css('--warn'), bad: css('--bad'),
    rule: css('--rule'), ink2: css('--ink-2'), ink: css('--ink'), panel: css('--panel'),
  });

  /** Size the canvas backing store to its CSS box × devicePixelRatio. Returns {ctx, w, h} in CSS pixels. */
  function fit(canvas) {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  /** Points of one key between t0 and t1 from the history. */
  function series(key, t0, t1) {
    const h = N.S.hist, out = [];
    for (let i = N.store.histFrom(t0); i < h.length && h[i].t <= t1; i++) {
      const v = h[i][key];
      if (typeof v === 'number') out.push([h[i].t, v]);
      else out.push([h[i].t, null]);        // a gap (sensor missing)
    }
    return out;
  }

  /** y range that shows the data and the limits that matter. */
  function yRange(sensor, pts) {
    if (sensor.binary) return [-0.15, 1.25];
    const L = N.S.settings.limits[sensor.lim];
    let lo = Infinity, hi = -Infinity;
    for (const [, v] of pts) if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!isFinite(lo)) { lo = sensor.min; hi = sensor.max; }
    if (sensor.key === 'temp') {
      lo = Math.min(lo - 2, L.amber - 15); hi = Math.max(hi + 2, L.amber + 3);
      if (L.red < hi * 1.25) hi = Math.max(hi, L.red + 2);
      return [lo, hi];
    }
    if (sensor.dir === 'low') return [0, Math.max(hi * 1.12, L.amber * 1.25)];
    let top = Math.max(hi * 1.15, L.amber * 1.12);
    if (L.red < top * 1.5) top = Math.max(top, L.red * 1.1);
    return [0, top];
  }

  function line(ctx, c, pts, X, Y, binary) {
    ctx.lineWidth = binary ? 1.6 : 2;
    ctx.strokeStyle = c.data;
    ctx.beginPath();
    let pen = false, colX = null, mn = 0, mx = 0, lastY = 0;
    const flush = () => {
      if (colX == null) return;
      if (!pen) { ctx.moveTo(colX, Y(mn)); pen = true; } else ctx.lineTo(colX, Y(lastY));
      if (mx !== mn) { ctx.lineTo(colX, Y(mx)); ctx.lineTo(colX, Y(mn)); }
    };
    for (const [t, v] of pts) {
      if (v == null) { flush(); colX = null; pen = false; continue; }
      const x = Math.round(X(t));
      if (x !== colX) { flush(); colX = x; mn = mx = v; }
      else { if (v < mn) mn = v; if (v > mx) mx = v; }
      lastY = v;
    }
    flush();
    if (binary) {
      ctx.stroke();
      ctx.lineTo(colX ?? 0, Y(0)); ctx.lineTo(X(pts.length ? pts[0][0] : 0), Y(0)); ctx.closePath();
      ctx.fillStyle = c.fill; ctx.fill();
    } else ctx.stroke();
  }

  function limits(ctx, c, sensor, Y, x0, x1, labels) {
    if (sensor.binary) return;
    const L = N.S.settings.limits[sensor.lim];
    ctx.setLineDash([5, 4]); ctx.lineWidth = 1.4;
    for (const [v, col, name] of [[L.amber, c.warn, 'amber'], [L.red, c.bad, 'red']]) {
      const y = Math.round(Y(v)) + 0.5;
      if (y < 0 || y > 2000) continue;
      ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      if (labels) {
        ctx.setLineDash([]); ctx.fillStyle = col; ctx.font = '600 13px Barlow';
        ctx.fillText(`${name} ${N.util.fmt(v, sensor.d)}`, x1 - 86, y - 5); ctx.setLineDash([5, 4]);
      }
    }
    ctx.setLineDash([]);
  }

  /** Small chart in a sensor tile: the last `span` ms, newest at the right edge, with a dot on the newest value. */
  function spark(canvas, sensor, span) {
    const { ctx, w, h } = fit(canvas);
    const c = colors();
    const t1 = Date.now(), t0 = t1 - span;
    const pts = series(sensor.key, t0, t1);
    const [lo, hi] = yRange(sensor, pts);
    const pad = 5;
    const X = t => (t - t0) / span * (w - 8);
    const Y = v => h - pad - (v - lo) / (hi - lo || 1) * (h - pad * 2);
    ctx.strokeStyle = c.rule; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h - 0.5); ctx.lineTo(w, h - 0.5); ctx.stroke();
    limits(ctx, c, sensor, Y, 0, w, false);
    if (!pts.length) return;
    line(ctx, c, pts, X, Y, sensor.binary);
    const last = pts[pts.length - 1];
    if (last[1] != null) {
      ctx.fillStyle = c.data; ctx.beginPath(); ctx.arc(X(last[0]), Y(last[1]), 3.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  /** Big chart in Sensor detail: axes, time labels, limit labels, and a cursor at `cursorT` (pause / hover). */
  function big(canvas, sensor, t0, t1, cursorT) {
    const { ctx, w, h } = fit(canvas);
    const c = colors();
    const pts = series(sensor.key, t0, t1);
    const [lo, hi] = yRange(sensor, pts);
    const L = 64, R = 18, T = 18, B = 34;
    const X = t => L + (t - t0) / (t1 - t0) * (w - L - R);
    const Y = v => T + (1 - (v - lo) / (hi - lo || 1)) * (h - T - B);
    ctx.font = '600 13px Barlow'; ctx.fillStyle = c.ink2; ctx.strokeStyle = c.rule; ctx.lineWidth = 1;
    // horizontal grid
    if (sensor.binary) {
      for (const [v, t] of [[0, sensor.key === 'gate' ? 'Closed' : 'Clear'], [1, sensor.key === 'gate' ? 'Open' : 'Part']]) {
        const y = Math.round(Y(v)) + 0.5; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke();
        ctx.fillText(t, 8, y + 4);
      }
    } else {
      const steps = 5;
      for (let i = 0; i <= steps; i++) {
        const v = lo + (hi - lo) * i / steps, y = Math.round(Y(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke();
        ctx.fillText(N.util.fmt(v, sensor.d > 1 ? 2 : sensor.d === 1 ? 0 : 0), 8, y + 4);
      }
    }
    // time labels
    const span = t1 - t0;
    const tick = span <= 60000 ? 10000 : span <= 120000 ? 20000 : span <= 300000 ? 60000 : 180000;
    for (let t = Math.ceil(t0 / tick) * tick; t <= t1; t += tick) {
      const x = Math.round(X(t)) + 0.5;
      ctx.strokeStyle = c.rule; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, h - B); ctx.stroke();
      ctx.fillText(N.util.hms(t), x - 26, h - 12);
    }
    limits(ctx, c, sensor, Y, L, w - R, true);
    if (pts.length) line(ctx, c, pts, X, Y, sensor.binary);
    if (cursorT) {
      const x = Math.round(X(cursorT)) + 0.5;
      ctx.strokeStyle = c.ink; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, h - B); ctx.stroke(); ctx.setLineDash([]);
    }
    return { X, Y, L, R, t0, t1, w };
  }

  return { fit, spark, big, series, colors };
})();
