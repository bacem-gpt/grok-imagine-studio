// Classic content script (isolated world): loads the ES-module content code from the extension.
(() => {
  if (window.__gisLoaded) return;
  window.__gisLoaded = true;
  import(chrome.runtime.getURL('content/main.js'))
    .then((m) => m.start())
    .catch((e) => console.error('[Imagine Studio] content script failed to load', e));
})();
