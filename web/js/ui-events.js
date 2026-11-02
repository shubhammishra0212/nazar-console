// ui-events.js — the Events list: alarms raised and cleared, no signal, holds, rejects, connect / disconnect,
// "Two-way link OK", limit changes. Newest on top; red rows tinted.
'use strict';

N.uiEvents = (() => {
  const { $, el, hms } = N.util;
  let shown = -1, pending = false;

  function render() {
    pending = false;
    const list = $('events');
    const ev = N.S.events;
    if (ev.length === shown && shown !== 0) return;
    shown = ev.length;
    list.innerHTML = '';
    if (!ev.length) { list.append(el('li', { class: 'empty', text: 'Nothing has happened yet.' })); return; }
    for (const e of ev.slice(0, 150)) {
      list.append(el('li', { class: e.level }, el('code', { text: hms(e.t) }), el('i'), el('span', { text: e.text })));
    }
  }

  function init() {
    N.on('event', () => { shown = -1; if (!pending) { pending = true; setTimeout(render, 50); } });
    $('btnClearEvents').addEventListener('click', () => { N.S.events.length = 0; shown = -1; render(); });
    render();
  }

  return { init };
})();
