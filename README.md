# Imagine Studio for Grok

> Unofficial, independent project — not affiliated with, endorsed by, or sponsored by xAI. "Grok" is a trademark of its owner.

**An in-place video sequence editor and prompt workshop for [Grok Imagine](https://grok.com/imagine).**

Grok generates a lot of clips. Picking the good ones, trimming them, grabbing stills, laying music from another
file under them, adding transitions and exporting used to mean downloading everything into a separate editor and
coming back to Grok for the next round. Grok Imagine Studio does all of that **inside grok.com**, in a panel docked
next to the Grok page, and it helps you prepare what you send to Grok next: shot lists, prompt texts and reference
images ("ingredients").

> Everything runs locally in your browser. No servers, no accounts, no analytics. Your clips, projects and
> ingredients are stored in the extension's IndexedDB on your machine.

## Features

**Collect & pick (Clips tab)**
- Detects every generated video and image on grok.com, in the Imagine feed, on post pages and in chats, with its prompt
  (read from Grok's own API responses).
- Hover any Grok video for **+ Bin / Pick / Timeline / Ingredient** buttons, or right-click it, or "Add all" from the studio.
  Optional auto-collect of every new generation.
- Bin with hover-scrub filmstrips, ratings, pick/reject flags, search, filters and sorting.
- **Review mode** for fast triage with the keyboard (← → to browse, P pick, X reject, 1–5 rate, I/O mark, Enter add to timeline).
- **Source monitor** with in/out marks, frame stepping, frame grabs, and **"Last frame → Grok"**, which attaches the final frame
  of a clip to the Grok composer so the next generation continues the shot.

**Edit (Edit tab)**
- Magnetic main track with drag-to-reorder, trim handles, split at playhead, duplicate, copy/paste, undo/redo.
- 22 transitions (dissolve, dip to black/white, blur, wipes, pushes, whip pans, zooms, spin, iris, clock, pixelate, glitch).
- Per-clip speed, volume/mute, fit, colour looks and fine filters, fades, Ken Burns on stills.
- Audio lanes: add music, voice or SFX from a **file or any URL**, or reuse another clip's sound; fades, volume, fit-to-video.
- Text overlays with fonts, styles and animations (fade, slide-up, pop, typewriter).
- Realtime preview; the export renders through the same compositor, so the result matches what you saw.

**Export**
- MP4 (H.264 + AAC, or Opus where the browser can't encode AAC) or WebM (VP9 + Opus), any resolution or frame rate,
  rendered offline frame by frame (WebCodecs via Mediabunny). Also a PNG of the current frame, or a WAV of the audio mix.

**Prompts tab**
- Storyboard / shot list with a structured **prompt builder** (subject, action, setting, shot type, camera move, lens,
  lighting, style, mood, palette, sound) and rich preset chips.
- **Prepared texts** (snippets), a project **bible** (characters, locations, style) with `{{tokens}}` / `@Name` expansion,
  variations generator, and meta-prompt templates that ask Grok itself to write shot lists.
- Paste or import prompt lists (numbered, bullets, JSON, CSV, markdown), or import Grok's last reply or the page selection.
- **Send to Grok**: inserts the prompt (and attaches reference images) into the grok.com composer, optionally submitting it.
  Generated takes are linked back to their shot; **Assemble timeline** builds the sequence in shot order.

**Ingredients tab**
- Library of reference images from files, the clipboard, URLs, grok.com images or video frames.
- Editor: crop with aspect presets, rotate, flip, resize, adjust. **Grid composer** to merge several references into one sheet.
- Attach to Grok in one click, or use the image as a shot reference or a still on the timeline.

## Install (developer mode)

1. Download `grok-imagine-studio-1.0.0.zip` from the [latest release](https://github.com/bacem-gpt/grok-imagine-studio/releases/latest) and unzip it (or clone this repo and use the `extension/` folder). No build step is needed.
2. Open `chrome://extensions` (Chrome, Edge, Brave, Arc, Opera; Chrome 116 or later), enable **Developer mode**.
3. Click **Load unpacked** and select the unzipped folder (the one containing `manifest.json`).
4. Open (or reload) [grok.com/imagine](https://grok.com/imagine). A **STUDIO** tab appears on the right edge of the page.
   Click it, or press **Alt+Shift+S**, or click the toolbar icon.

`npm run zip` produces `dist/grok-imagine-studio-<version>.zip`.

## Typical workflow

1. Generate on Grok as usual. Collect the clips you like: hover a clip and click **+ Bin**, or open **Clips → On grok.com → Add all**.
2. Press **Review** in the Clips tab and triage with the keyboard (P pick, X reject, 1–5 rate). Mark in/out points on the keepers and press Enter to send them to the timeline. Press `?` in the Clips tab for every shortcut.
3. In **Edit**, reorder, trim and split, click a junction to choose a transition, then add music (**Audio → From file / From URL**) and titles.
4. Click **Export**, choose MP4 or WebM, and download, or add the render back to the bin.
5. Need another shot? In **Prompts**, write or generate the next shot (attach a reference or the last frame), click **Send to Grok**, and the new take is linked to its shot.

The studio can dock right or bottom, fill the window, or pop out into its own tab (it then talks to your latest grok.com tab).

## Keyboard shortcuts

| Where | Keys |
|---|---|
| Anywhere on grok.com | `Alt+Shift+S` toggle the studio |
| Studio | `Ctrl/⌘+Z` undo · `Ctrl/⌘+Shift+Z` redo · `Ctrl/⌘+E` export · `Alt+1…4` switch tabs |
| Edit | `Space` play/pause · `J K L` shuttle · `←/→` frame (Shift = 1 s) · `↑/↓` previous/next edit · `S` split · `Del` delete · `Ctrl/⌘+D` duplicate · `T` text · `M` marker · `+/-` zoom |
| Clips bin | arrows move · `Enter` open in source monitor · `P` pick · `X` reject · `U` unflag · `1–5` rate · `E` add to timeline · `W` insert at playhead · `R` review · `Del` remove |
| Source monitor | `Space` play · `J K L` shuttle · `,` / `.` frame step · `I` / `O` mark in/out · `←/→` previous/next clip |
| Review mode | `←/→` browse · `P` pick · `X` reject · `1–5` rate · `I/O` in/out · `Enter` add to timeline and go to the next item · `Esc` exit |
| Prompts | `Ctrl/⌘+Enter` send shot · `Ctrl/⌘+Shift+Enter` send and submit · `Alt+↑/↓` previous/next shot |

## Troubleshooting

- **No STUDIO tab on grok.com**: reload the grok.com tab after installing or updating the extension.
- **"Could not download media"**: the clip URL may have expired. Re-open the post on grok.com so the studio sees a fresh
  URL, or download the file and drop it into the bin.
- **MP4 audio is Opus, not AAC**: some browsers (Chrome on Linux) have no AAC encoder. The MP4 still plays in browsers, VLC
  and most editors. Use Chrome on Windows/macOS for AAC, or export WebM.
- **Composer not found when sending prompts**: Grok changed its page. Use **Copy** instead, and please report it.
  Detection is heuristic, based on Grok's DOM and API in October 2026.

## Development

```bash
npm install          # dev dependencies (esbuild, Playwright, Mediabunny, Preact, htm)
npm run vendor       # rebuild extension/vendor/*.mjs from node_modules
npm run check        # static checks: manifest, syntax, module linking, MV3 rules
npm test             # unit tests (node:test)
npm run e2e          # Playwright end-to-end tests (Chrome for Testing + the unpacked extension; mocks grok.com)
npm run icons        # re-render the icons
npm run zip          # package dist/*.zip
```

Architecture, module contracts and Grok DOM notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Privacy & permissions

- `grok.com`, `*.grok.com`, `*.grokusercontent.com`, `*.x.ai`: detect media on Grok pages and download your generated clips.
- Optional per-site access, requested only when you import audio/video from another URL.
- `storage`, `unlimitedStorage`: projects and media live locally in IndexedDB. `downloads`: save exports. `contextMenus`: right-click actions.
- The extension only reads Grok's media API responses to learn clip URLs and prompts. It never modifies Grok's requests or sends your data anywhere.

## License

MIT for this extension. Vendored libraries: Preact and htm (MIT), Mediabunny (MPL-2.0).
