// Message contract between the grok.com content script ("page side") and the Studio app ("studio side").
//
// Transport:
//  - Embedded studio (iframe overlay on grok.com): a MessageChannel. The content script creates the iframe,
//    waits for `load`, then posts {type: HANDSHAKE, version, token} with port2 to the iframe window. All traffic
//    then flows over the port and supports structured clone (Blob/File/ArrayBuffer pass through untouched).
//    token: obtained from the service worker with chrome.runtime.sendMessage({gis: 'studio-token'}) -> {ok, token}
//    (bound to the tab; page scripts cannot ask for one). The studio checks it with the service worker before it
//    trusts the port, so a script on grok.com cannot hand the studio a port of its own. Handshakes without a token
//    are accepted only while HANDSHAKE_TOKEN_REQUIRED is false, and never once a tokened handshake was accepted.
//  - Standalone studio (extension tab): chrome.tabs.sendMessage(tabId, {gis: 'req', id, type, payload}) to the
//    most recently used grok.com tab; events arrive via chrome.runtime.sendMessage({gis: 'evt', name, payload}).
//    Blobs are encoded as {__blob: dataUrl, name?, type} by encodeForRuntime()/decodeFromRuntime().
//
// Envelope over the port:
//   request : {kind: 'req', id, type, payload}
//   response: {kind: 'res', id, ok: true, result} | {kind: 'res', id, ok: false, error: string}
//   event   : {kind: 'evt', name, payload}
// Both sides can send requests; both sides answer requests they implement.

export const PROTOCOL_VERSION = 1;
export const HANDSHAKE = 'gis:connect';
export const HANDSHAKE_ACK = 'gis:connected';
/** Set to true once content/overlay.js sends a token with every handshake (see Transport above). */
export const HANDSHAKE_TOKEN_REQUIRED = true;

/** Requests answered by the content script (studio -> page). */
export const REQ = {
  PAGE_INFO: 'page.info',              // () -> PageInfo
  PAGE_SCAN: 'page.scan',              // () -> {items: PageMedia[]}
  PAGE_FETCH: 'page.fetchMedia',       // {url} -> {blob: Blob}  (page-origin fetch with cookies; also works for blob: URLs)
  PAGE_REVEAL: 'page.reveal',          // {key, url?} -> {ok, error?}  scroll the page to that media element and flash it
  PAGE_SELECTION: 'page.selection',    // () -> {text}  current text selection on grok.com
  PAGE_LAST_REPLY: 'page.lastReply',   // () -> {text}  text of the latest Grok chat reply (best effort)
  PAGE_LOAD_MORE: 'page.loadMore',     // {steps?, keepPosition? = true} -> {added}  scroll the feed so Grok loads more media
  COMPOSER_INSERT: 'composer.insert',  // {text, mode: 'replace'|'append', submit?: boolean} -> {ok, method}
  COMPOSER_ATTACH: 'composer.attach',  // {blob: Blob, name: string} -> {ok, method}
  COMPOSER_SUBMIT: 'composer.submit',  // () -> {ok, method}
  COMPOSER_READ: 'composer.read',      // () -> {text, found}
  UI_SET_DOCK: 'ui.setDock',           // {mode: 'right'|'bottom'|'max'|'float', size?: number} -> {mode, size}
  UI_GET_DOCK: 'ui.getDock',           // () -> {mode, size}
  UI_CLOSE: 'ui.close',                // () -> {ok}   hide the overlay (studio stays alive)
  UI_TOAST: 'ui.toast',                // {message, kind?, duration?} -> {ok}  small toast on grok.com
};

/** Events emitted by the content script (page -> studio). */
export const EVT = {
  PAGE_MEDIA: 'page.media',            // {items: PageMedia[]}  full current list, debounced on change
  PAGE_ADD: 'page.add',                // {items: PageMedia[], flag?: 'pick'|null, target?: 'bin'|'timeline'}  user clicked "+" on grok.com
  PAGE_INGREDIENT: 'page.ingredient',  // {item: PageMedia}  user sent a page image to Ingredients
  PAGE_IMPORT_TEXT: 'page.importText', // {text}  user sent selected text to the prompt list
  PAGE_NAVIGATED: 'page.navigated',    // PageInfo
  COMPOSER_SUBMITTED: 'composer.submitted', // {text}  user (or studio) submitted a prompt on grok.com
  UI_VISIBILITY: 'ui.visibility',      // {visible: boolean, mode}
};

/** Requests answered by the studio (page -> studio). */
export const STUDIO_REQ = {
  BIN_KEYS: 'studio.binKeys',          // () -> {keys: string[]}  PageMedia keys already in the bin (for on-page badges)
};

/** Events emitted by the embedded studio (studio -> page, over the port). */
export const STUDIO_EVT = {
  BIN_KEYS: 'studio.binKeys',          // {keys: string[]}  pushed whenever the bin changes
};

/**
 * @typedef {Object} PageMedia
 * @property {string} key            Stable identity (post id when known, else normalized URL).
 * @property {'video'|'image'} kind
 * @property {string} url            Best URL to fetch (HD when known).
 * @property {string[]} altUrls      Other candidate URLs, best first (SD, derived from thumbnails, ...).
 * @property {string|null} thumbUrl  Poster / thumbnail URL for quick display.
 * @property {string|null} postId
 * @property {string|null} prompt    Generation prompt when known (from Grok's API responses or the DOM).
 * @property {string|null} model
 * @property {string|null} createdAt ISO timestamp when known.
 * @property {number|null} width
 * @property {number|null} height
 * @property {number|null} duration  Seconds (videos), when known.
 * @property {'dom'|'network'|'both'} source
 * @property {string} pageUrl
 * @property {number} seenAt         ms epoch of first detection (used for "newest first").
 * @property {boolean} [fresh]       True for a new generation that appeared while the grok.com page was open (streamed
 *                                   result, createTime after the page loaded, or media right after a prompt submission).
 * @property {string[]} [aliases]    Other keys the same media may carry (key given before Grok's API named the post,
 *                                   post-id / URL keys): match these too when checking "already in the bin".
 */
// seenAt details (content/registry.js): fresh media is dated by its first detection; everything else (on the page
// when it loaded, older posts loaded by infinite scroll) is dated 30 days before the page session, in page order. So
// `seenAt >= someStudioStartTime` only ever matches fresh media while the list still sorts like the page.
// COMPOSER_SUBMITTED payloads also carry `at` (ms epoch of the submission).

/**
 * @typedef {Object} PageInfo
 * @property {string} url
 * @property {string} title
 * @property {'imagine'|'post'|'favorites'|'chat'|'other'} route
 * @property {boolean} composerFound
 */

const isBlob = (v) => typeof Blob !== 'undefined' && v instanceof Blob;

async function blobToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(5, comma);
  const type = meta.split(';')[0] || 'application/octet-stream';
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Deep-convert Blobs to {__blob} records so a value survives JSON-only chrome.runtime messaging. */
export async function encodeForRuntime(value) {
  if (isBlob(value)) return { __blob: await blobToDataUrl(value), type: value.type, name: value.name || null };
  if (Array.isArray(value)) return Promise.all(value.map(encodeForRuntime));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = await encodeForRuntime(v);
    return out;
  }
  return value;
}

/** Inverse of encodeForRuntime(). */
export function decodeFromRuntime(value) {
  if (value && typeof value === 'object' && typeof value.__blob === 'string') {
    const blob = dataUrlToBlob(value.__blob);
    if (value.name && typeof File !== 'undefined') return new File([blob], value.name, { type: blob.type });
    return blob;
  }
  if (Array.isArray(value)) return value.map(decodeFromRuntime);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decodeFromRuntime(v);
    return out;
  }
  return value;
}
