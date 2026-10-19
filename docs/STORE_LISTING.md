# Chrome Web Store listing (draft)

> Draft for review before submission. The store name must not suggest an official xAI product.

**Name (≤ 45 chars):** Imagine Studio for Grok

**Short description (≤ 132 chars):**
Edit Grok Imagine videos right on grok.com: pick the best clips, trim, add music and transitions, export. Plus a prompt workshop.

**Category:** Productivity → Tools (alternative: Photos)

**Language:** English

## Detailed description

Grok Imagine generates lots of clips. Picking the good ones, trimming them, grabbing stills, laying music under them
and adding transitions used to mean downloading everything into a separate video editor and coming back to Grok for
the next round. Imagine Studio does it **right inside grok.com**, in a panel docked next to the Grok page.

COLLECT & PICK
• Detects every video and image Grok generates for you (Imagine feed, post pages, chats), along with its prompt
• One-click "+ Bin" on any Grok video, right-click menu, or auto-collect new generations
• Fast keyboard review: browse, pick, reject, rate, mark in/out
• "Last frame → Grok": continue a shot from the final frame of a clip

EDIT
• Timeline with trim, split, reorder, undo/redo
• 22 transitions: dissolve, dip to black/white, wipes, pushes, whip pans, zooms, iris, glitch…
• Speed, volume, colour looks and filters, fades, Ken Burns on stills, animated titles
• Add music, voice or sound effects from a file or any URL; mix with clip sound

EXPORT
• MP4 (H.264 + AAC) or WebM, any resolution or frame rate, rendered in your browser
• PNG frame grabs and WAV audio mixdowns

PREPARE YOUR NEXT PROMPTS
• Shot list / storyboard with a structured prompt builder and preset chips (camera, lens, lighting, style, mood…)
• Prepared texts (snippets), a character/location bible with {{tokens}}, variations, prompt-list import
• Send a shot to Grok's prompt box (with reference images); new takes link back to the shot; one click assembles the timeline
• Reference-image library: crop, resize, adjust, combine into reference sheets, attach to Grok

PRIVATE BY DESIGN
No account, no servers, no analytics. Everything stays in your browser.

Imagine Studio is an independent project and is not affiliated with, endorsed by, or sponsored by xAI. "Grok" is a
trademark of its respective owner.

## Single purpose (required field)

Edit and assemble the media you generate with Grok Imagine (collect, trim, add audio and transitions, export), and
prepare the prompts and reference images you send to Grok, directly on grok.com.

## Permission justifications

| Permission | Justification |
|---|---|
| Host `grok.com`, `*.grok.com` | Show the editor panel on grok.com, detect the user's generated media and prompts, and fill Grok's prompt box when the user clicks Send. |
| Host `*.grokusercontent.com`, `*.x.ai` | Download the user's generated videos and images from Grok's asset servers so they can be edited locally. |
| Optional host `<all_urls>` | Requested per site, only when the user imports an audio or video file from a URL. |
| `storage`, `unlimitedStorage` | Store projects and media files locally; videos are large. |
| `downloads` | Save exported videos, frames and audio. |
| `contextMenus` | "Add to Imagine Studio" entries on grok.com images and videos. |
| Remote code | None. All code ships in the package (MV3). |

## Data usage disclosures

Does not collect or transmit user data. Everything is stored locally. Privacy policy: `docs/PRIVACY.md` (to be published at a public URL).

## Assets to provide

- Icon 128×128: `extension/icons/icon128.png`
- Screenshots 1280×800 (3–5): Clips tab with grok.com feed, Edit timeline with transitions, Export dialog, Prompts workshop, Ingredients editor
- Small promo tile 440×280
