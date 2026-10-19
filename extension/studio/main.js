// Studio entry point (extension page; embedded in grok.com as an iframe, or opened as a tab).
import { html, render } from '../vendor/preact-htm.mjs';
import { initApp } from './core/app-state.js';
import { bridge } from './core/bridge.js';
import { App } from './ui/app.js';
import { projectStore, uiStore, pageStore, libraryStore } from './core/store.js';
import * as model from './core/model.js';
import * as media from './core/media.js';
import * as appState from './core/app-state.js';
import { db } from './core/db.js';

// Listen for the content script's handshake right away (before the async boot) so it is never missed.
bridge.init();

const root = document.getElementById('root');
const params = new URLSearchParams(location.search);
document.documentElement.dataset.mode = params.get('mode') || (window.parent !== window ? 'embedded' : 'tab');

// Debug / test hook (used by the E2E suite and handy in DevTools).
window.__gis = { projectStore, uiStore, pageStore, libraryStore, model, media, appState, bridge, db };

initApp()
  .then(() => render(html`<${App} />`, root))
  .catch((err) => {
    console.error('[gis] failed to start', err);
    root.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'boot boot-error';
    box.textContent = `Imagine Studio failed to start: ${err?.message || err}`;
    root.appendChild(box);
  });
