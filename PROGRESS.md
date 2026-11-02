# NAZAR Console — build progress

Restarted agent: read this file and `git log` first, never redo finished work.

## Done
- `.gitignore`, this file.
- Swift app: `app/Sources/{SerialPort,Settings,CameraControls,Bridge,AppDelegate,Menu,main}.swift`, `app/make_icon.swift`,
  `app/build.sh` → builds `build/NAZAR Console.app` + zip with -warnings-as-errors (verified: builds clean, icon checked).
- Assets: `app/assets/eye-white-1024.png`, `web/img/eye.png`, `web/fonts/*.woff2`.
- Bridge protocol (page→Mac `{cmd}`): listPorts, open{path,baud}, close, write{text}, saveFile{name,text|base64},
  saveSettings{data}, log{text}, camDescribe{camera}, camSet{camera,items,quiet}, openFile{path}, keepAwake{on}.
  Mac→page `window.NazarNative.*`: ports(list), opened(path), data(text), closed(reason,unexpected), error(msg),
  saved(path|null), camInfo(camera, list|null, ok), opened_file(path, ok, msg). Settings injected as `window.__NAZAR_SAVED`,
  `window.__NAZAR_NATIVE=true`. Env `NAZAR_WEB_DIR` loads web/ from the repo.

- Web, written + `node --check` OK (not yet run in a browser): `web/index.html`, `web/css/{tokens,layout,panels,overlays}.css`,
  `web/js/{util,store,bridge,demo,link,alarms}.js`. Global namespace `N`, bus `N.on/N.emit`, state `N.S`.

- All web JS written: util, store, bridge, demo, link, alarms, charts, camera, inspect, csv, ui-top, ui-tiles,
  ui-status, ui-inspect, ui-events, ui-drawer, agent (English only), main. `node --check` OK.
- Headless Chrome demo screenshots checked (1440x900 light+dark, 1920x1080 dark, agent view, limits drawer):
  layout OK. Screenshot helper lives in the agent scratchpad (not in repo); command is in README later.
- Inspection rows take v/ma/vib/vpk from the last RUNNING second before the stop (belt is off at the photo).

- `tools/sim_board.py` (pty, v2 protocol, firmware contract choices: inspect in both modes, gate n 0 for manual
  REJECT, err for late/duplicate/HOLD verdicts, SET/BELT ack echo) — protocol self-test OK.
- `tools/mock_ai.py` (contract-shaped vision 8765 + agent 8766, --slow for timeout tests).
- Native app verified with sim (NAZAR_AUTOCONNECT + NAZAR_NO_CAMERA hooks): connect, PING → link OK, hello,
  PASS sent per part with no camera, alarms (shaking amber/red), light sensor no-signal + back, board reboot,
  unplug → CONNECTION LOST → auto-reconnect when the pty came back. App quit cleanly.
- Browser checks: AI offline → SKIPPED + PASS; slow vision (3 s) → TIMEOUT + PASS; mock AI → verdicts, crop,
  heatmap; mock agent → 8D view; continuous mode (stops 0), Stop/Start, Hold/Resume flows OK.
- Screenshots in `docs/screen-*.png`.

## In progress
- README.md, then docs/console.md → PDF.

## Next
- Final rebuild of the app after last web changes; final PROGRESS.

Scope note (coordinator): 8D view is English only — no language toggle, always send `"lang":"en"`.
