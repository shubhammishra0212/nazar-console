// bridge.js — one object the rest of the page talks to, whether it runs inside the Mac app or in a normal browser.
//
// In the app: messages go to Swift (window.webkit.messageHandlers.nazar) and answers come back through
// window.NazarNative.*, which we turn into events on the bus (N.emit('native:ports', list) ...).
// In a browser: there are no USB ports and no camera controls, files are saved as downloads, settings go to
// localStorage. Demo mode works the same in both.
'use strict';

N.bridge = (() => {
  const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.nazar;
  const native = !!(handler && window.__NAZAR_NATIVE);
  const post = msg => { try { handler.postMessage(msg); } catch (e) { console.error('bridge', e); } };
  const later = (name, ...args) => setTimeout(() => N.emit(name, ...args), 0);

  // answers from Swift
  window.NazarNative = {
    ports: list => N.emit('native:ports', list || []),
    opened: path => N.emit('native:opened', path),
    data: text => N.emit('native:data', text),
    closed: (reason, unexpected) => N.emit('native:closed', reason, unexpected),
    error: msg => N.emit('native:error', msg),
    saved: path => N.emit('native:saved', path),
    camInfo: (camera, list, ok) => N.emit('native:camInfo', camera, list, ok),
    opened_file: (path, ok, msg) => N.emit('native:openedFile', path, ok, msg),
  };

  function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    later('native:saved', name);
  }

  if (native) {
    return {
      native: true,
      listPorts: () => post({ cmd: 'listPorts' }),
      open: (path, baud) => post({ cmd: 'open', path, baud }),
      close: () => post({ cmd: 'close' }),
      write: text => post({ cmd: 'write', text }),
      saveText: (name, text) => post({ cmd: 'saveFile', name, text }),
      saveBase64: (name, base64) => post({ cmd: 'saveFile', name, base64 }),
      saveSettings: data => post({ cmd: 'saveSettings', data }),
      log: text => post({ cmd: 'log', text }),
      camDescribe: camera => post({ cmd: 'camDescribe', camera }),
      camSet: (camera, items, quiet) => post({ cmd: 'camSet', camera, items, quiet: !!quiet }),
      openFile: path => post({ cmd: 'openFile', path }),
      keepAwake: on => post({ cmd: 'keepAwake', on }),
    };
  }

  return {
    native: false,
    listPorts: () => later('native:ports', []),
    open: () => later('native:error', 'USB ports work only in the NAZAR Console Mac app. Use Demo data here.'),
    close: () => {},
    write: () => {},
    saveText: (name, text) => download(name, new Blob([text], { type: 'text/plain' })),
    saveBase64: (name, b64) => {
      const bin = atob(b64), arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      download(name, new Blob([arr]));
    },
    saveSettings: data => { try { localStorage.setItem('nazar-console', JSON.stringify(data)); } catch (e) { /* private window */ } },
    log: text => console.log(text),
    camDescribe: camera => later('native:camInfo', camera, null, false),
    camSet: () => {},
    openFile: path => later('native:openedFile', path, false, 'Start AI works only in the Mac app.'),
    keepAwake: () => {},
  };
})();
