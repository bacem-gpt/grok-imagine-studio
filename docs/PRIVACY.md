# Privacy policy

_Last updated: 2026-10-19_

Grok Imagine Studio (the "extension") is a browser extension that adds a video editor and prompt workshop to
grok.com. It is an independent project and is **not affiliated with, endorsed by, or sponsored by xAI**.

## Summary

- The extension does **not** collect, sell, or share personal data.
- It has **no servers, accounts, analytics, telemetry, ads or tracking**.
- Everything you create (projects, clips, frames, prompts, snippets, reference images) stays **on your computer**,
  in the extension's local browser storage (IndexedDB and `chrome.storage.local`).

## What the extension accesses, and why

| Access | Why |
|---|---|
| Pages on `grok.com` | To show the studio panel and detect the images and videos Grok generated for you, with their prompts, so you can collect them. It reads Grok's own media API responses in your browser and never modifies or forwards them. |
| `assets.grok.com`, `*.grokusercontent.com`, `*.x.ai` | To download **your** generated media into the studio so you can edit it locally. Requests go only to these Grok asset hosts, with your existing browser session. |
| Other websites (optional, per site) | Only when **you** import an audio or video file from a URL. The browser asks your permission for that one site first. |
| `storage`, `unlimitedStorage` | To keep your projects and media locally. Video files can be large. |
| `downloads` | To save the videos, frames and audio you export. |
| `contextMenus` | To add "Add to Imagine Studio" entries to the right-click menu on grok.com. |

When you click **Send to Grok** or **Attach to Grok**, the extension types the prompt into, or attaches the image to,
grok.com's own prompt box in your browser, exactly as if you had done it by hand. Grok's handling of that content is
covered by xAI's terms and privacy policy.

## Data retention and deletion

Your data stays until you delete it. You can delete items, sequences or ingredients in the studio, use
**Sequence menu → Clean up unused storage**, or remove the extension. Removing the extension deletes all of its
local data.

## Contact

Questions or concerns: open an issue on the project's repository.
