// agent.js — NAZAR Agent · 8D view. Sends the inspection log and the limits to the local agent service
// (POST 127.0.0.1:8766/report, contract §5), waits for the statistics and the D1–D8 report (the local LLM takes
// 15–30 s; we give up after 4 min), and shows the report on the left and the evidence on the right: p-chart,
// strata table (defect rate when each sensor is past its amber limit vs. normal, with ratio and p-value), and the
// before/after comparison once "Mark fix applied" has been pressed. English only for now (lang "en").
//
// With Demo data and no agent running, the console computes the same statistics itself and fills a plain template,
// clearly marked, so the screen can be shown without the AI services.
'use strict';

N.agent = (() => {
  const { $, el, fmt, hms, fetchT } = N.util;
  const S = N.S;
  let report = null;          // last response, plus {approved, nAtDraft, at, local}
  let busy = false, waitTimer = 0, t0 = 0;
  const FACTOR_LABEL = { vib: 'Motor shaking', lux: 'Tunnel light', temp: 'Motor temperature', ma: 'Belt motor current' };

  const realRows = () => S.inspections.filter(r => r.verdict === 'PASS' || r.verdict === 'HOLD' || r.verdict === 'REJECT');

  function requestBody() {
    const L = S.settings.limits;
    const body = {
      lang: 'en', use_llm: true, source: S.source === 'demo' ? 'demo' : 'live',
      limits: { vib: { amber: L.vib.amber, red: L.vib.red }, lux: { amber: L.lux.amber, red: L.lux.red },
        temp: { amber: L.temp.amber, red: L.temp.red }, ma: { amber: L.ma.amber, red: L.ma.red } },
      inspections: realRows().map(r => ({ at: r.at, n: r.n, verdict: r.verdict, score: r.score, vib: r.vib, vpk: r.vpk, lux: r.lux, temp: r.temp, ma: r.ma, v: r.v })),
    };
    if (S.settings.fix.at) { body.fix_at = S.settings.fix.at; body.fix_note = S.settings.fix.note || 'fix applied'; }
    return body;
  }

  // ---------------- open / draft ----------------
  function open() {
    $('agent').hidden = false;
    const n = realRows().length;
    const stale = !report || report.failed || report.enough === false || (!report.approved && n - report.nAtDraft >= 30);
    if (stale && !busy) draft(); else render();
  }
  function close() { $('agent').hidden = true; }

  async function draft() {
    if (busy) return;
    busy = true; t0 = Date.now();
    showWaiting();
    waitTimer = setInterval(showWaiting, 1000);
    const body = requestBody();
    const url = S.settings.ai.agentUrl.replace(/\/+$/, '') + '/report';
    let res = null;
    try {
      const r = await fetchT(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 240000);
      res = await r.json();
      if (!res || res.ok === false) res = { failed: true, message: (res && res.error) || `The agent answered HTTP ${r.status}.` };
    } catch (e) {
      const timeout = e && e.name === 'AbortError';
      if (!timeout && S.source === 'demo') res = localReport(body);
      else res = { failed: true, message: timeout ? 'The agent took longer than 4 minutes. Try again, or check its Terminal window.'
        : 'The NAZAR Agent is not running. Press Start AI, wait about 20 s, then Draft again.' };
    }
    clearInterval(waitTimer);
    busy = false;
    report = { ...res, nAtDraft: body.inspections.length, at: Date.now(), approved: null };
    if (!res.failed) N.event('info', `8D report drafted from ${body.inspections.length} inspections${res.local ? ' (console template, demo)' : ''}.`);
    render();
  }

  function showWaiting() {
    const s = Math.round((Date.now() - t0) / 1000);
    $('agState').textContent = `Writing… ${s} s`;
    $('agReport').innerHTML = '';
    $('agReport').append(el('div', { class: 'wait' }, el('div', {}, el('b', { text: `${s} s` }),
      `The NAZAR Agent is reading ${realRows().length} inspections and writing the 8D report on this Mac.`, el('br'),
      'The local model usually needs 15–30 s.')));
    $('agEvidence').innerHTML = '';
    syncButtons();
  }

  function syncButtons() {
    const fix = S.settings.fix.at;
    $('agFix').textContent = fix ? `Fix applied ${hms(fix).slice(0, 5)} · clear` : 'Mark fix applied';
    $('agDraft').disabled = busy;
    $('agApprove').disabled = busy || !report || report.failed || !report.report || !!report.approved;
    $('agSave').disabled = busy || !report || !report.report;
  }

  // ---------------- render ----------------
  function render() {
    syncButtons();
    if (busy) return;
    const box = $('agReport'), ev = $('agEvidence');
    box.innerHTML = ''; ev.innerHTML = '';
    if (!report) return;
    if (report.failed) {
      $('agState').textContent = 'Not drafted';
      box.append(el('div', { class: 'wait' }, el('div', {}, el('b', { text: 'No report' }), report.message)));
      return;
    }
    const writer = report.local ? 'console template (demo, agent offline)' : report.writer === 'llm' ? 'local AI model' : 'template';
    $('agState').textContent = `${report.stats ? report.stats.n : 0} inspections · written by ${writer}${report.ms ? ' in ' + fmt(report.ms / 1000, 0) + ' s' : ''}`;
    if (report.enough === false || !report.report) {
      box.append(el('div', { class: 'wait' }, el('div', {}, el('b', { text: 'Not enough inspections yet' }),
        report.message || 'At least 20 inspected parts are needed. Keep the line running, then Draft again.')));
    } else {
      const R = report.report;
      box.append(el('h3', { text: R.title || '8D report' }), el('p', { class: 'lead', text: R.summary || '' }));
      for (const s of R.sections || []) {
        box.append(el('section', {}, el('b', { text: s.id }), el('div', {}, el('h4', { text: s.title }),
          ...String(s.body || '').split(/\n{2,}/).map(p => el('p', { text: p })))));
      }
      if (report.approved) box.append(el('div', { class: 'stamp', text: `APPROVED ${new Date(report.approved).toLocaleString('en-GB')}` }));
    }
    if (report.stats) evidence(ev, report.stats);
  }

  function evidence(ev, st) {
    ev.append(el('div', { class: 'kpis' },
      el('div', {}, el('small', { text: 'Inspected' }), el('b', { text: String(st.n) })),
      el('div', {}, el('small', { text: 'Bad parts' }), el('b', { text: String(st.bad) })),
      el('div', {}, el('small', { text: 'Defect rate' }), el('b', { text: `${fmt(st.rate * 100, 1)} %` }))));
    if (st.pchart && st.pchart.length) {
      const cv = el('canvas');
      ev.append(el('div', {}, el('h4', { text: 'Defect rate over time (p-chart)' }), cv));
      requestAnimationFrame(() => pchart(cv, st));
      setTimeout(() => pchart(cv, st), 60);
    }
    if (st.strata && st.strata.length) {
      const t = el('table', { class: 'strata' }, el('tr', {}, el('th', { text: 'Machine state' }), el('th', { text: 'Past amber' }),
        el('th', { text: 'Normal' }), el('th', { text: 'Ratio' }), el('th', { text: 'p-value' })));
      for (const s of st.strata) {
        const rate = (b, n) => (n ? `${b}/${n} (${fmt(b / n * 100, 0)} %)` : '—');
        t.append(el('tr', { class: s.factor === st.cause ? 'cause' : '' }, el('td', { text: s.label || FACTOR_LABEL[s.factor] || s.factor }),
          el('td', { text: rate(s.high_bad, s.high_n) }), el('td', { text: rate(s.low_bad, s.low_n) }),
          el('td', { text: s.ratio == null ? '—' : `${fmt(s.ratio, 1)}×` }), el('td', { text: s.p_value == null ? '—' : s.p_value < 0.001 ? '< 0.001' : fmt(s.p_value, 3) })));
      }
      ev.append(el('div', {}, el('h4', { text: 'Defect rate by machine state' }), t,
        el('p', { class: 'fnote', text: st.cause ? `Highlighted: the likely cause (${FACTOR_LABEL[st.cause] || st.cause}). A p-value below 0.05 means the difference is unlikely to be chance.` : 'No machine state stands out yet.' })));
    }
    const ba = st.before_after;
    if (ba) {
      const r = (b, n) => (n ? `${fmt(b / n * 100, 1)} %` : '—');
      ev.append(el('div', {}, el('h4', { text: 'Before and after the fix' }), el('div', { class: 'ba' },
        el('div', {}, el('small', { text: `Before (${ba.before_n} parts)` }), el('b', { text: r(ba.before_bad, ba.before_n) })),
        el('div', {}, el('small', { text: `After (${ba.after_n} parts)` }), el('b', { text: r(ba.after_bad, ba.after_n) })))));
    }
  }

  function pchart(cv, st) {
    const { ctx, w, h } = N.charts.fit(cv);
    const c = N.charts.colors();
    const P = st.pchart, L = 44, R = 12, T = 12, B = 26;
    const top = Math.max(0.2, ...P.map(g => Math.max(g.p, g.ucl || 0))) * 1.1;
    const X = i => L + (P.length === 1 ? 0.5 : i / (P.length - 1)) * (w - L - R);
    const Y = v => T + (1 - v / top) * (h - T - B);
    ctx.font = '600 12px Barlow'; ctx.fillStyle = c.ink2; ctx.strokeStyle = c.rule; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const v = top * i / 4, y = Math.round(Y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke();
      ctx.fillText(`${Math.round(v * 100)} %`, 4, y + 4);
    }
    ctx.strokeStyle = c.bad; ctx.setLineDash([5, 4]); ctx.beginPath();
    P.forEach((g, i) => (i ? ctx.lineTo(X(i), Y(g.ucl)) : ctx.moveTo(X(i), Y(g.ucl)))); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = c.bad; ctx.fillText('UCL', w - R - 26, Y(P[P.length - 1].ucl) - 4);
    ctx.strokeStyle = c.ink2; ctx.beginPath(); ctx.moveTo(L, Y(st.rate)); ctx.lineTo(w - R, Y(st.rate)); ctx.stroke();
    ctx.strokeStyle = c.data; ctx.lineWidth = 2; ctx.beginPath();
    P.forEach((g, i) => (i ? ctx.lineTo(X(i), Y(g.p)) : ctx.moveTo(X(i), Y(g.p)))); ctx.stroke();
    P.forEach((g, i) => { ctx.fillStyle = g.p > g.ucl ? c.bad : c.data; ctx.beginPath(); ctx.arc(X(i), Y(g.p), 3.5, 0, 7); ctx.fill(); });
    if (S.settings.fix.at) {
      const i = P.findIndex(g => g.from >= S.settings.fix.at);
      if (i > 0) {
        const x = (X(i - 1) + X(i)) / 2;
        ctx.strokeStyle = c.ok || '#24873F'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, h - B); ctx.stroke();
        ctx.fillStyle = c.ink; ctx.fillText('fix', x + 4, T + 12);
      }
    }
    ctx.fillStyle = c.ink2;
    ctx.fillText(`groups of ${P[0].n} parts, oldest left`, L, h - 8);
  }

  // ---------------- local statistics (demo without the agent) ----------------
  const lnFact = (() => { const t = [0]; for (let i = 1; i <= 20000; i++) t[i] = t[i - 1] + Math.log(i); return n => t[n]; })();
  function fisher(a, b, c, d) {   // two-sided Fisher exact test for [[a, b], [c, d]]
    const n = a + b + c + d, r1 = a + b, c1 = a + c;
    const p = x => Math.exp(lnFact(r1) + lnFact(n - r1) + lnFact(c1) + lnFact(n - c1) - lnFact(n) - lnFact(x) - lnFact(r1 - x) - lnFact(c1 - x) - lnFact(n - r1 - c1 + x));
    const p0 = p(a);
    let sum = 0;
    for (let x = Math.max(0, r1 + c1 - n); x <= Math.min(r1, c1); x++) { const px = p(x); if (px <= p0 * (1 + 1e-7)) sum += px; }
    return Math.min(1, sum);
  }

  function localStats(rows, limits, fixAt) {
    const bad = r => r.verdict !== 'PASS';
    const n = rows.length, nb = rows.filter(bad).length, rate = n ? nb / n : 0;
    const size = 20, pchart = [];
    for (let i = 0; i + size <= n; i += size) {
      const g = rows.slice(i, i + size), b = g.filter(bad).length;
      const sd = Math.sqrt(rate * (1 - rate) / size);
      pchart.push({ from: g[0].at, to: g[g.length - 1].at, n: size, bad: b, p: b / size, ucl: Math.min(1, rate + 3 * sd), lcl: Math.max(0, rate - 3 * sd) });
    }
    const strata = [];
    for (const f of ['vib', 'temp', 'lux', 'ma']) {
      const lim = limits[f].amber, low = f === 'lux';
      const rs = rows.filter(r => r[f] != null);
      const hi = rs.filter(r => (low ? r[f] <= lim : r[f] >= lim)), lo = rs.filter(r => !(low ? r[f] <= lim : r[f] >= lim));
      const hb = hi.filter(bad).length, lb = lo.filter(bad).length;
      const ratio = hi.length && lo.length ? (hb / hi.length) / Math.max(lb / lo.length, 0.5 / lo.length) : null;
      strata.push({ factor: f, label: FACTOR_LABEL[f], high_n: hi.length, high_bad: hb, low_n: lo.length, low_bad: lb, ratio,
        p_value: hi.length && lo.length ? fisher(hb, hi.length - hb, lb, lo.length - lb) : null });
    }
    const cands = strata.filter(s => s.p_value != null && s.p_value < 0.05 && s.ratio > 1).sort((a, b) => a.p_value - b.p_value);
    const cause = cands.length ? cands[0].factor : null;
    let before_after = null;
    if (fixAt) {
      const be = rows.filter(r => r.at < fixAt), af = rows.filter(r => r.at >= fixAt);
      const inCause = r => cause && (cause === 'lux' ? r[cause] <= limits[cause].amber : r[cause] >= limits[cause].amber);
      before_after = { before_n: be.length, before_bad: be.filter(bad).length, after_n: af.length, after_bad: af.filter(bad).length,
        cause_before: be.length ? be.filter(inCause).length / be.length : 0, cause_after: af.length ? af.filter(inCause).length / af.length : 0 };
    }
    return { n, bad: nb, rate, pchart, strata, cause, before_after };
  }

  function localReport(body) {
    const st = localStats(body.inspections, body.limits, body.fix_at);
    if (st.n < 20) return { ok: true, enough: false, local: true, stats: st, message: `Only ${st.n} inspected parts so far; 20 are needed.` };
    const c = st.strata.find(s => s.factor === st.cause);
    const name = c ? c.label.toLowerCase() : null;
    const pct = v => `${fmt(v * 100, 1)} %`;
    const ba = st.before_after;
    const sections = [
      ['D1', 'Team', 'Team Parakh: line operator, maintenance (motor and conveyor), quality (AI inspection), and the NAZAR console as data recorder.'],
      ['D2', 'Problem', `${st.bad} of ${st.n} inspected washers (${pct(st.rate)}) were held or rejected by the AI inspection.${c ? ` Bad parts were ${fmt(c.ratio, 1)} times more likely while ${name} was past its amber limit.` : ''}`],
      ['D3', 'Containment', 'Rejected washers are pushed off by the gate and held washers are checked by hand before release. Parts made while the alarm was on are kept apart and re-checked.'],
      ['D4', 'Root cause', c ? `Stratifying the inspections by machine state shows ${name} as the factor that matters (p = ${c.p_value < 0.001 ? '< 0.001' : fmt(c.p_value, 3)}). Why does the washer look bad? It moved under the camera. Why did it move? The belt and motor shook. Why did they shake? The motor mount screws worked loose.` : 'No machine state stands out yet. Keep collecting inspections.'],
      ['D5', 'Corrective action', c && st.cause === 'vib' ? 'Tighten the motor mount screws, add thread-locker and a spring washer, and re-check after one hour of running.' : 'Act on the factor that stands out once there is one.'],
      ['D6', 'Verification', ba ? `Before the fix: ${ba.before_bad} bad of ${ba.before_n} (${pct(ba.before_n ? ba.before_bad / ba.before_n : 0)}). After the fix: ${ba.after_bad} bad of ${ba.after_n} (${pct(ba.after_n ? ba.after_bad / ba.after_n : 0)}).` : 'Press Mark fix applied after the fix, run the line, then Draft again to compare before and after.'],
      ['D7', 'Prevention', 'Keep the shaking limit on the console, add the motor mount to the daily start-up checklist, and learn normal limits again after maintenance.'],
      ['D8', 'Closure', 'Close the report when the after-fix rate stays at the normal level for a full shift. Thank the team.'],
    ].map(([id, title, b]) => ({ id, title, body: b }));
    return { ok: true, enough: true, writer: 'template', local: true, ms: 0, stats: st,
      report: { title: c ? `Rejects rise when the ${name} is high` : 'Defect rate on the NAZAR line', summary: 'Drafted by the console from demo data because the NAZAR Agent is not running.', sections } };
  }

  // ---------------- buttons ----------------
  function toggleFix() {
    const F = S.settings.fix;
    if (F.at) { F.at = null; F.note = ''; N.event('info', 'Fix mark cleared.'); if (S.source === 'demo') N.demoBoard.setFixed(false); }
    else {
      F.at = Date.now(); F.note = 'tightened motor mount';
      N.event('ok', 'Fix applied. Run the line, then Draft again to compare before and after.');
      if (S.source === 'demo') N.demoBoard.setFixed(true);
    }
    N.store.saveSettings();
    syncButtons();
  }

  function approve() {
    if (!report || !report.report) return;
    report.approved = Date.now();
    N.event('ok', '8D report approved.');
    render();
  }

  function saveHTML() {
    if (!report || !report.report) return;
    const R = report.report, st = report.stats || {};
    const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    const cv = document.querySelector('#agEvidence canvas');
    const chart = cv ? `<img src="${cv.toDataURL('image/png')}" style="width:100%;max-width:720px;border:1px solid #ccc">` : '';
    const strata = (st.strata || []).map(s => `<tr${s.factor === st.cause ? ' style="background:#f7e7c2"' : ''}><td>${esc(s.label)}</td><td>${s.high_bad}/${s.high_n}</td><td>${s.low_bad}/${s.low_n}</td><td>${s.ratio == null ? '—' : fmt(s.ratio, 1) + '×'}</td><td>${s.p_value == null ? '—' : fmt(s.p_value, 4)}</td></tr>`).join('');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(R.title)}</title>
<style>body{font:15px/1.55 -apple-system,Helvetica,sans-serif;max-width:900px;margin:30px auto;padding:0 20px;color:#1d2124}
h1{font-size:28px;margin:0 0 4px}.mast{border-bottom:3px solid #23282C;padding-bottom:6px;margin-bottom:16px;font-weight:700}
section{border-top:1px solid #ccc;padding:8px 0}section b{display:inline-block;background:#23282C;color:#fff;padding:2px 8px;margin-right:8px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ccc;padding:4px 8px;text-align:left}
.stamp{display:inline-block;border:3px solid #24873F;color:#24873F;padding:4px 10px;font-weight:700}</style></head><body>
<div class="mast">NAZAR · Team Parakh · 8D report · ${new Date(report.at).toLocaleString('en-GB')}${S.source === 'demo' ? ' · DEMO DATA' : ''}</div>
<h1>${esc(R.title)}</h1><p><strong>${esc(R.summary)}</strong></p>
<p>${st.n} inspections, ${st.bad} bad (${fmt((st.rate || 0) * 100, 1)} %).</p>${chart}
<table><tr><th>Machine state</th><th>Past amber</th><th>Normal</th><th>Ratio</th><th>p-value</th></tr>${strata}</table>
${(R.sections || []).map(s => `<section><h3><b>${esc(s.id)}</b>${esc(s.title)}</h3>${String(s.body || '').split(/\n{2,}/).map(p => `<p>${esc(p)}</p>`).join('')}</section>`).join('')}
${report.approved ? `<p class="stamp">APPROVED ${new Date(report.approved).toLocaleString('en-GB')}</p>` : '<p>Draft, not approved.</p>'}
</body></html>`;
    N.bridge.saveText(`NAZAR-8D-${N.util.stamp()}.html`, html);
  }

  function init() {
    $('btnAgent').addEventListener('click', open);
    $('agClose').addEventListener('click', close);
    $('agDraft').addEventListener('click', draft);
    $('agFix').addEventListener('click', toggleFix);
    $('agApprove').addEventListener('click', approve);
    $('agSave').addEventListener('click', saveHTML);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('agent').hidden) close(); });
    N.on('reset', () => { report = null; });
  }

  return { init, open, draft, localStats };
})();
