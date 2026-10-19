# Grok Imagine Studio — architecture & module contracts

A Chrome (MV3) extension that adds an **in-place video sequence editor and prompt workshop** to
[grok.com/imagine](https://grok.com/imagine) (and Grok chats). The user's problem: Grok generates many videos;
picking the good ones, trimming/cutting them, grabbing stills, adding music from another file/URL, adding
transitions, and preparing prompt lists/reference images currently means downloading everything into an
external editor and coming back. The studio does all of that **inside grok.com**.

## Runtime topology

```
grok.com tab
├── content/page-hook.js   MAIN world, document_start — read-only fetch/XHR sniffer for Grok media JSON
├── content/loader.js      isolated world — dynamic-imports content/main.js (ES modules)
│   └── content/main.js    overlay (launcher + docked panel), Server (page side of the bridge),
│                          media detection, hover toolbar, composer integration
└── <gis-studio-root> (shadow DOM, attached to <html>)
    └── iframe chrome-extension://…/studio/studio.html?mode=embedded   ← the Studio app (extension origin)

studio/studio.html?mode=tab  — the same app in a normal tab (talks to the latest grok.com tab via chrome.tabs)
background.js                — toolbar action / Alt+Shift+S toggle, context menus, open-in-tab
```

* The studio is an **extension page**: it can fetch Grok asset hosts without CORS issues (host permissions),
  uses IndexedDB in the extension origin, and is never tainted when drawing media to canvas.
* Content ↔ studio messaging is defined in **`extension/shared/protocol.js`** (MessageChannel when embedded —
  structured clone, Blobs pass through; JSON + base64 blobs over chrome.runtime in tab mode).
* **No build step.** Plain ES modules everywhere. Third-party code is vendored in `extension/vendor/`
  (`preact-htm.mjs` = Preact 10 + hooks + htm; `mediabunny.min.mjs` = Mediabunny for demux/decode/encode/mux).
  Regenerate with `npm run vendor`. MV3 forbids remote code: never load scripts from a CDN.

## Directory layout & ownership

| Path | Owner | What |
|---|---|---|
| `extension/manifest.json`, `background.js` | core | MV3 manifest, service worker |
| `extension/shared/protocol.js` | core (additive edits allowed) | message contract |
| `extension/shared/grok-urls.js` | core + content | URL helpers (pure) |
| `extension/content/**` | **content** | everything on grok.com (overlay.js/server.js exist; extend them) |
| `extension/studio/core/*` | core | model, stores, db, bridge, media pipeline, app-state, ingredients API, utils |
| `extension/studio/engine/compositor.js`, `effects.js`, `transitions.js` | core | frame compositor shared by preview & export |
| `extension/studio/engine/player.js` | **edit** | realtime preview engine |
| `extension/studio/engine/exporter.js`, `audio-mix.js` | **export** | offline render + mixdown + encoding |
| `extension/studio/ui/app.js`, `kit.js`, `hooks.js`, `hotkeys.js`, `icons.js` | core (additive edits allowed) | shell + UI kit |
| `extension/studio/ui/media/**`, `styles/media.css` | **clips** | Clips tab, bin, source monitor, review mode, BinCompact, MediaThumb |
| `extension/studio/ui/edit/**`, `styles/edit.css` | **edit** | Edit tab: program monitor, timeline, inspector |
| `extension/studio/ui/export/**`, `styles/export.css` | **export** | export dialog |
| `extension/studio/ui/prompts/**`, `extension/studio/prompts/**`, `styles/prompts.css` | **prompts** | Prompts tab + pure prompt engine |
| `extension/studio/ui/ingredients/**`, `styles/ingredients.css` | **ingredients** | Ingredients tab, image editor, grid composer, IngredientPicker |
| `tests/unit/<area>.test.mjs` | each area | node:test unit tests for pure modules |
| `tests/e2e/<area>.spec.mjs` | each area | Playwright tests (harness in `tests/e2e/harness.mjs`) |
| `tests/fixtures/grok/*.html` | **content** | mock grok.com pages |

**Shared files rule:** only edit files you own. For core/shared files marked "additive edits allowed"
(protocol.js, kit.js, icons.js, hooks.js, base.css, harness.mjs, model.js helpers) use small **additive**
`Edit`s (append a new export/icon/class) — never rewrite, reformat or rename existing code, never `Write` a
file you don't own. Several agents work in this tree at the same time.

## Conventions

* Preact + htm: `import { html, useState, ... } from '../../../vendor/preact-htm.mjs'` (adjust depth).
  Function components + hooks. Build UIs from **`ui/kit.js`** (Button, IconButton, Slider, NumberField,
  TimeField, Select, Toggle, TextField, Field, Tabs, Segmented, Modal, EmptyState, Badge, Kbd, Spinner,
  ProgressBar, DropZone, Section, Rating, `toast()`, `confirmDialog()`, `promptDialog()`, `showMenu()`,
  `pickFiles()`) and **`ui/icons.js`** (add icons additively if needed). Keyboard shortcuts via
  `useHotkeys(map, {enabled: active})` from `ui/hotkeys.js` — always gate by your view's `active` prop.
* State: `projectStore` (undoable) / `uiStore` / `pageStore` / `libraryStore` in `core/store.js`; read in
  components with `useProject(sel)`, `useUI(sel)`, `usePage(sel)`, `useLibrary(sel)` from `ui/hooks.js`.
  **Edit the project only via** `projectStore.update(p => M.op(p, ...), {label: 'Trim clip', merge})` using the
  immutable ops in `core/model.js` (add small helpers to your own module if needed). Drag gestures pass one
  `merge` key per gesture so the whole drag is one undo step. Background status changes use `{history:false}`.
* CSS: only in your own stylesheet (already linked from `studio.html`), prefix classes with your area
  (`.clips-`, `.bin-`, `.src-`, `.tl-`, `.mon-`, `.insp-`, `.ex-`, `.pr-`, `.ing-`). Use the tokens in
  `styles/base.css` (`--bg-0..4`, `--line`, `--text-0..3`, `--accent`, `--clip-video` …). Dark UI, dense, polished.
  The studio is often docked at ~480–960 px width: **every view must work at 480 px wide and at full width**.
* Code style: 2 spaces, single quotes, semicolons, trailing commas; JSDoc on exported functions. Match the
  surrounding code's comment density. No `eval`, no inline `<script>`, no remote code.
* Errors surface with `toast(msg, {kind: 'error'})`; log with `console.warn('[gis] …')`.

## Core APIs you can rely on

### `core/model.js` (pure; see unit tests in `tests/unit/model.test.mjs`)
Project shape:
```js
{ id, name, schema, createdAt, updatedAt,
  settings: { width, height, fps, background },
  media: { [id]: MediaItem }, mediaOrder: [id…],            // bin (newest first)
  tracks: { video: [VideoClip…], audio: [AudioClip…], text: [TextClip…] },
  markers: [{id, time, label, color}],
  shots: [Shot…],                                           // Prompts tab (shape below)
  bible: { characters: [], locations: [], style: '', notes: '' },
  exportSettings: null | {...} }
MediaItem { id, kind:'video'|'image'|'audio', name, origin:'grok'|'file'|'url'|'frame'|'export', sourceUrl, altUrls,
            pageUrl, pageKey, postId, prompt, mime, size, duration, width, height, hasAudio, fps,
            status:'pending'|'loading'|'ready'|'error', error, rating 0..5, flag:'pick'|'reject'|null, tags, note, addedAt, shotId }
VideoClip { id, mediaId, in, out, speed, volume, muted, fit:'cover'|'contain'|'fill', filters|null, fadeIn, fadeOut,
            transition: {type, duration}|null  /* INTO this clip */, kenBurns|null, label }
AudioClip { id, mediaId, start, in, out, volume, fadeIn, fadeOut, lane, label }      // mediaId may be a video (use its sound)
TextClip  { id, text, start, duration, style: TEXT_STYLE_DEFAULTS, animation, lane }
```
Main track is magnetic (no gaps); a transition overlaps the two clips. Key functions: `layoutProject`,
`layoutVideo`, `videoItemsAt`, `sourceTimeAt`, `timelineTimeOf`, `fadeFactor`, `transitionProgress`,
`insertionIndexAt`, `snapPoints`, `snapTime`, `findClip`, `addMedia`, `updateMedia`, `removeMedia`,
`appendMediaToTimeline`, `insertVideoClips`, `moveVideoClip`, `trimVideoClip`, `splitVideoAt`, `splitAllAt`,
`setTransition`, `setAllTransitions`, `updateClip`, `removeClips`, `duplicateClips`, `addAudioClip`,
`moveAudioClip`, `trimAudioClip`, `splitAudioAt`, `addTextClip`, `splitTextAt`, `addMarker`, `removeMarker`,
`fitAudioToVideo`, `updateSettings`, constants `TRANSITIONS`, `FILTER_DEFAULTS`, `FILTER_PRESETS`,
`TEXT_ANIMATIONS`, `TEXT_STYLE_DEFAULTS`, `RESOLUTION_PRESETS`, `FPS_PRESETS`.

### `core/media.js`
`importPageItems(pageItems, {flag, toTimeline})`, `importFiles(files, {toTimeline})`, `importUrl(url, {kind})`
(call from a click handler; asks host permission), `addBlobAsMedia(blob, {name, origin, kind, prompt, toTimeline})`,
`placeOnTimeline(ids)`, `retryMedia(id)`, `getMediaBlob(id)`, `getMediaUrl(id)` / `peekMediaUrl(id)` (object URL),
`getPreviews(id)` → `{thumb, strip, stripCount}` (filmstrip = `stripCount` frames side by side, 128×72 each),
`getPeaks(id)` → Float32Array of min/max pairs at `PEAKS_PER_SECOND`, `getAudioBuffer(id)` (48 kHz),
`grabFrame(id, time, {maxWidth, type})` → Blob, `loadMediabunny()`, `mediaFilename(media)`,
`onMediaEvent(fn)` (`{type:'ready'|'error'|'progress', id}`).
Hooks: `useMediaPreview(id)`, `useMediaUrl(id)` in `ui/hooks.js`.

### `core/ingredients.js`
`addIngredient(blob, meta)`, `getIngredient(id)`, `getIngredientBlob(id)`, `getIngredientThumb(id)`,
`getIngredientUrl(id)`, `updateIngredient(id, patch)`, `replaceIngredientImage(id, blob)`,
`removeIngredients(ids)`, `attachIngredientsToGrok(ids)`, `ingredientFromPageItem(pageMedia)`.
Metadata lives in `libraryStore.ingredients`.

### `core/bridge.js` + `shared/protocol.js`
`bridge.request(REQ.X, payload)` → Promise; `bridge.on(EVT.X, fn)`; `bridge.connected`, `bridge.mode`.
Requests the content script answers: `PAGE_INFO, PAGE_SCAN, PAGE_FETCH, PAGE_REVEAL, PAGE_SELECTION,
PAGE_LAST_REPLY, PAGE_LOAD_MORE, COMPOSER_INSERT {text, mode, submit}, COMPOSER_ATTACH {blob, name},
COMPOSER_SUBMIT, COMPOSER_READ, UI_SET_DOCK, UI_GET_DOCK, UI_CLOSE, UI_TOAST`.
Events it emits: `PAGE_MEDIA {items}`, `PAGE_ADD {items, flag, target}`, `PAGE_INGREDIENT {item}`,
`PAGE_IMPORT_TEXT {text}`, `PAGE_NAVIGATED`, `COMPOSER_SUBMITTED {text}`, `UI_VISIBILITY {visible, mode}`.
`pageStore.items` always holds the current `PageMedia[]` (shape in protocol.js).

### `core/app-state.js`
Boot/persistence (autosave is automatic), project management, and `appEvents` bus:
`'source.open' {mediaId}`, `'timeline.reveal' {clipId}`, `'ingredient.fromPage' {item}`,
`'ingredient.add' {blob, name, origin, sourceUrl}`, `'prompts.importText' {text}`, `'export.open'`,
`'project.loaded' {project}`. The shell switches tabs for `source.open` / `timeline.reveal`.

### `engine/compositor.js` (+ `effects.js`, `transitions.js`)
`drawFrame(ctx, {project, layout, t, getSource, scratch})` renders the composited frame at timeline time `t`.
`getSource(item, sourceTime)` returns `{image, width, height}` (HTMLVideoElement / VideoFrame / canvas / ImageBitmap)
or `null` if not ready; returns `{ready}`. Preview and export MUST both render through this function so the
export matches the preview. `createScratch()` gives per-user scratch canvases. Text overlays, fades, filters,
vignette, Ken Burns and all `TRANSITIONS` are implemented there.

## Area contracts (exports other areas rely on)

* **content** — implements every `REQ` handler and emits every `EVT` in protocol.js; queues events until the
  studio is connected (opening the iframe if needed); keeps `PAGE_MEDIA` current (debounced); hover toolbar on
  grok.com media; context-menu messages from background.js (`{gis:'context', action, srcUrl, mediaType, selectionText}`);
  `{gis:'toggle'}`. Mock pages in `tests/fixtures/grok/` mirror the real DOM facts below.
* **clips** — `ui/media/clips-view.js` → `ClipsView({active})`; `ui/media/bin-compact.js` → `BinCompact()`
  (compact bin for the Edit tab; items draggable with `dataTransfer` type **`application/x-gis-media`** = JSON
  array of media ids; double-click → `appEvents.emit('source.open', {mediaId})`); `ui/media/media-thumb.js` →
  `MediaThumb({mediaId, scrub, fit, class})` (thumbnail with hover-scrub filmstrip, status overlays).
* **edit** — `ui/edit/edit-view.js` → `EditView({active})` (BinCompact + program monitor + inspector + timeline);
  `engine/player.js` → `Player`; accepts drops of `application/x-gis-media` (and files) on the timeline;
  handles `'timeline.reveal'`.
* **export** — `engine/exporter.js` → `getExportCapabilities()`, `exportProject(project, opts)`,
  `exportFrame(project, t, opts)`, `exportAudioWav(project, opts)`; `engine/audio-mix.js` →
  `renderAudioMix(project, {start, end, sampleRate})`; `ui/export/export-dialog.js` → `ExportDialog({onClose})`.
* **prompts** — `ui/prompts/prompts-view.js` → `PromptsView({active})`; pure engine in
  `studio/prompts/*.js` (templates, `{{variables}}`/`@Bible` expansion, presets, list parsing, variations).
  Shot shape stored in `project.shots`:
  `{ id, title, prompt, fields: {}, ingredientIds: [], duration, mode, notes, status:'draft'|'sent'|'generated'|'approved', takes: [mediaId], chosenTake: mediaId|null, createdAt }`.
  Handles `'prompts.importText'`. Links generated media to shots (`media.shotId`, `shot.takes`).
* **ingredients** — `ui/ingredients/ingredients-view.js` → `IngredientsView({active})`;
  `ui/ingredients/ingredient-picker.js` → `IngredientPicker({value, onChange, multiple})`; handles
  `'ingredient.fromPage'` and `'ingredient.add'`; image editor + grid composer.

## Grok facts (researched Oct 2026 — the real site can change; code defensively, degrade gracefully)

* Routes: `/imagine` (feed), `/imagine/post/<uuid>` (detail), `/imagine/favorites`, `/imagine/saved`, `/c/<id>` (chat).
* Media hosts: `assets.grok.com` (CORS allows `https://grok.com` with credentials), `assets.grokusercontent.com`,
  `imagine-public.x.ai` (shared posts). URL shapes: `…/users/<uid>/generated/<postId>/generated_video.mp4`,
  `…/preview_image.jpg` (video thumbnail → swap to `generated_video.mp4`), `…/image.jpg` (full image),
  `…/share-videos/<id>_thumbnail.jpg` → `<id>.mp4`. Helpers in `shared/grok-urls.js`.
* API: `GET/POST /rest/media/post/list` → `{posts:[{id, mediaUrl, hdMediaUrl, mediaType:'MEDIA_POST_TYPE_VIDEO'|…,
  mimeType, prompt, originalPrompt, createTime, modelName, childPosts:[…same…]}]}`. Chat:
  `POST /rest/app-chat/conversations/new` and `/rest/app-chat/conversations/<id>/responses` (streamed NDJSON).
* DOM: feed cards `div[role="listitem"] div[class*="group/media-post-masonry-card"]` with `img`/`video` inside;
  detail page `main > article` with `video#sd-video[src]`, `video#hd-video[src]`; variant thumbnails
  `button img[alt^="Thumbnail"]`; moderated `img[alt="Moderated"]`; avatars `img[alt="pfp"]`.
* Composer: `.query-bar div[contenteditable="true"]` (ProseMirror-like), `textarea[aria-label*="Ask"]`,
  `textarea[aria-label="Make a video"]` (detail page), fallbacks `form textarea`, `main textarea`.
  Submit: `button[aria-label="Make video"]`, `button[aria-label="Send"]`, `button[data-testid="send-button"]`,
  `button[type="submit"]`, arrow icon path `M6 11L12 5M12 5L18 11M12 5V19`. Upload: `button[aria-label="Upload image"]`
  + hidden `input[type=file]`.
* Live SSR HTML check (2026-10-19): composer container `.query-bar`; chat composer `<textarea aria-label="Ask Grok anything">`;
  buttons `aria-label="Submit"` and `aria-label="Attach"`; feature flag `enable_tiptap_editor: true` (TipTap/ProseMirror contenteditable
  composers, `.ProseMirror`); `ASSET_SERVER_URL` = `https://assets.grok.com`.
* **Verified live on grok.com (2026-10-19, logged out, read-only):** overlay + page hook mount under the production CSP with no page
  errors and no Cloudflare challenge; the composer is found on `/` and `/imagine` and `composer.insert` (execCommand path) writes into
  Grok's real TipTap editor (replace + append read back exactly); the studio downloads from the real `imagine-public.x.ai` CDN. The
  logged-out `/imagine` page lists ~170 "agent-skills" template thumbnails (`imagine-public.x.ai/agent-skills/...`, with instruction
  prompts) — excluded from detection (`CATALOG_PATH_RE` in content/records.js, same rule in page-hook.js). Not verifiable without an
  account: detection of a user's own generated videos in the live feed, image attach and submit.
* CSP: strict (`frame-src` lacks chrome-extension:, still fine for extension iframes); never inject inline scripts.

## Testing

* Unit: `npm test` (node:test, `tests/unit/**/*.test.mjs`) — pure modules only.
* E2E: `npx playwright test tests/e2e/<file>.spec.mjs` — `tests/e2e/harness.mjs`: `launch()` (Chrome for Testing +
  unpacked extension, mock routes), `openGrok(page, path)`, `openStudio(page)` (embedded frame), `openStudioTab(ctx)`
  (standalone tab — prefer it for studio-only UI tests), `seedMedia(target, ['clip-red.mp4', …])` (imports fixtures
  through the real pipeline), `getProject(target)`. Fixtures: `npm run fixtures` → `tests/fixtures/media/`
  (clip-red 4s/440Hz, clip-green 3s/660Hz, clip-blue 5s/880Hz, clip-vertical 3s, clip-hd 6s 1280×720@24,
  clip-noaudio 2s, clip-cyan.webm 3s, music.mp3 12s, voice.wav 3s, still.jpg 1024², still.png 800×600).
  Fake Grok posts: `tests/e2e/fixtures-map.mjs`. `window.__gis` exposes stores/model/media in the studio.
* Visual check: `node tests/e2e/screenshot.mjs out.png --tab=edit [--dock=max] [--standalone]`, then look at it.
* Codecs in the test browser (Linux CfT 156): H.264/VP9 encode+decode ✓, Opus encode ✓, **AAC encode ✗**
  (Windows/macOS Chrome have AAC). MediaRecorder MP4 ✗.

## Additions from the hardening pass

* **Several studio windows** (overlay in several grok.com tabs, standalone tab) share one IndexedDB. Saves are three-way merges
  (`model.mergeProjects` / `mergeById`, atomic `db.updateProject` / `db.kvUpdate`); every window merges the others' broadcasts.
  Unsaved state is journaled synchronously to `localStorage` (`gis:journal:project`, `gis:journal:library`) and merged back at the
  next start, so closing a tab never drops the last edits. Storage cleanup asks every window (Web Locks) what it still references
  and only deletes files unreferenced for a grace period (`db.planGarbage`).
* **Grok page imports** go through `app-state.collectPageItems()` (one import per project across windows) and match
  `PageMedia.aliases`; auto-collect requires `PageMedia.fresh`.
* **Authenticated handshake**: the content script obtains a per-tab token from the service worker (`{gis:'studio-token'}`),
  the studio frame verifies it (`{gis:'studio-token-check'}`) before trusting the port (`HANDSHAKE_TOKEN_REQUIRED`). Page scripts
  can neither drive nor embed a working studio.
* **Clips placed before download** carry `clip.autoOut` and take the real duration when probed (also after undo / merges).
* Shared UI contracts in `ui/kit.js`: `MEDIA_DRAG_TYPE`, `notConnectedToast()`; `ui/hotkeys.js`: `useHotkeys(map, {modal})`,
  `modalOpen()`. Media status: `media.getAudioStatus(id)`. Events: `appEvents 'bin.reveal' {mediaId}`.
* Edit layout rules live in `ui/edit/edit-layout.js` (pure); the take watcher (`ui/prompts/take-watcher.js`) runs from boot.
* E2E note: in embedded tests, type into studio fields with `locator.fill()` and send shortcuts inside the frame —
  page-level keyboard input can land in grok.com's composer under load.
