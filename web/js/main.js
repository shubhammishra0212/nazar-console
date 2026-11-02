// main.js — start-up: load the saved settings, wire the screen, look for the last port, and start Demo data when the
// page is opened as index.html?demo=1 (handy in a browser). For screenshots: &show=agent|limits|serial|ai|detail
// opens that view after &after=<ms> (default 20000). &realai=1 sends demo photos to the real vision service.
'use strict';

(() => {
  const { $ } = N.util;
  N.store.loadSettings();
  N.uiTop.init();
  N.uiTiles.init();
  N.uiStatus.init();
  N.uiInspect.init();
  N.uiEvents.init();
  N.uiDrawer.init();
  N.agent.init();
  N.camera.init();

  $('btnSaveCsv').addEventListener('click', N.csv.telemetry);
  $('btnSaveInsp').addEventListener('click', N.csv.inspections);
  $('btnResetCounts').addEventListener('click', () => {
    N.store.resetCounts();
    N.link.send('RESET', true);
    N.event('info', 'Counts reset to 0.');
  });

  N.event('info', `NAZAR Console started${N.bridge.native ? '' : ' in a browser (USB and camera settings need the Mac app)'}.`);
  N.link.refreshPorts();

  const q = new URLSearchParams(location.search);
  if (q.get('realai') === '1') N.S.settings.ai.demoUsesAI = true;   // test: demo board + real vision service
  if (q.get('demo') === '1') N.link.startDemo();
  const show = q.get('show');
  if (show) {
    setTimeout(() => {
      if (show === 'agent') N.agent.open();
      else if (show === 'detail') N.uiTiles.openDetail(q.get('key') || 'vib');
      else N.uiDrawer.open(show);
    }, +(q.get('after') || 20000));
  }
})();
