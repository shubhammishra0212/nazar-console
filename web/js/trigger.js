// trigger.js — the camera is the part sensor (timing.cam = 1, the default). The FC-51 stays wired, but firmware 2.1+
// ignores it in this mode. While the belt runs, a 640-px copy of the camera frame goes to the vision service /locate
// about eight times a second. As soon as a whole washer is in view with its centre inside the middle of the picture
// (trig.zone % of the width and height), SEEN is sent: the ESP32 stops the belt at once and sends `inspect`, and the
// inspection loop takes it from there, exactly as after an IR edge (photo → AI → PASS / FAIL → gate).
// The washer that was just judged is still in view when the belt restarts, so the next SEEN is only sent after the
// middle of the picture has been empty for EMPTY_LOOKS looks in a row. Washers on the belt must therefore be spaced
// about one camera view apart.
'use strict';

N.trigger = (() => {
  const S = N.S;
  const { fetchT } = N.util;
  const EMPTY_LOOKS = 3;
  const CONFIRM_MS = 1500;           // no `part` from the board by then: SEEN was refused or lost, look again
  let armed = true, empty = 0, busy = false, sentAt = 0, confirmed = true, state = 'off', offlineSince = 0;

  const vurl = path => S.settings.ai.visionUrl.replace(/\/+$/, '') + path;
  /** Camera trigger in use: chosen in the settings AND the board's firmware knows it (reports cam 1). */
  const active = () => S.source !== 'none' && S.settings.timing.cam === 1 && !!S.link.cfg && S.link.cfg.cam === 1;

  N.on('msg:part', () => { confirmed = true; });
  N.on('reset', () => { armed = true; empty = 0; sentAt = 0; confirmed = true; });

  async function find() {
    if (N.camera.isDemo) return N.camera.demoLocate();
    const blob = await N.camera.grabSmall(640);
    if (!blob) return null;
    try {
      const r = await fetchT(vurl('/locate'), { method: 'POST', body: blob, headers: { 'Content-Type': 'image/jpeg' } }, 800);
      const j = await r.json();
      return j && j.ok ? j : null;
    } catch (e) {
      return null;
    }
  }

  function set(s) {
    if (s === 'noai' && state !== 'noai') {
      offlineSince = Date.now();
      N.event('amber', 'Camera part trigger: the vision service does not answer /locate, so no washer can stop the belt. Press Start AI (or restart Start Vision).');
    }
    if (s !== 'noai' && state === 'noai' && offlineSince) N.event('ok', 'Camera part trigger is watching the belt again.');
    state = s;
  }

  async function look() {
    if (!active()) return set('off');
    if (!N.camera.on) return set('nocam');
    const t = S.tel;
    if (!t || t.mode !== 'RUN' || t.belt !== 1) return set(t && t.mode === 'INSPECT' ? 'seen' : 'paused');
    if (!confirmed && Date.now() - sentAt > CONFIRM_MS) { confirmed = true; armed = true; empty = 0; }
    const r = await find();
    if (!r) return set('noai');
    if (!active() || !S.tel || S.tel.mode !== 'RUN' || S.tel.belt !== 1) return;   // changed while we looked
    const zone = Math.min(100, Math.max(10, S.settings.trig.zone || 50)) / 100;
    const inZone = !!r.found && Math.abs(r.cx / r.w - 0.5) * 2 <= zone && Math.abs(r.cy / r.h - 0.5) * 2 <= zone;
    if (!armed) {
      empty = inZone ? 0 : empty + 1;
      if (empty < EMPTY_LOOKS) return set('leaving');
      armed = true;
    }
    if (inZone) {
      armed = false; empty = 0; sentAt = Date.now(); confirmed = false;
      N.link.send('SEEN', true);
      return set('seen');
    }
    set('watching');
  }

  async function loop() {
    if (!busy) {
      busy = true;
      try { await look(); } catch (e) { console.error(e); }
      busy = false;
    }
    setTimeout(loop, Math.max(60, S.settings.trig.everyMs || 120));
  }
  setTimeout(loop, 500);

  const LOOK = {
    watching: { cls: 'st-ok', word: 'Camera watching', value: 'Clear' },
    seen: { cls: 'st-info', word: 'Washer under camera', value: 'Washer' },
    leaving: { cls: 'st-info', word: 'Judged washer leaving', value: 'Leaving' },
    paused: { cls: 'st-none', word: 'Belt not running', value: 'Paused' },
    nocam: { cls: 'st-amber', word: 'No camera picture', value: 'No camera' },
    noai: { cls: 'st-red', word: 'Vision offline', value: 'Offline' },
    off: { cls: 'st-none', word: 'Off', value: '—' },
  };
  /** Part sensor tile while the camera is the trigger. */
  const describe = () => ({ ...LOOK[state], unit: '' });

  return { describe, get active() { return active(); }, get state() { return state; } };
})();
