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

## In progress
- `web/` UI (index.html first).

## Next
1. `web/`: index.html, css/, fonts/, js modules (util, store, bridge, link, demo, alarms, charts, camera, inspect, ui-*, agent, csv, main).
2. `tools/sim_board.py`.
3. Verify: node --check, headless Chrome screenshots (1440x900, 1920x1080, dark), native serial with sim.
4. README.md, docs/console.md → docs/NAZAR-04-Console-App.pdf (+ copy to ../PDFs/).

Scope note (coordinator): 8D view is English only — no language toggle, always send `"lang":"en"`.
