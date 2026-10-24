# Launch kit — Imagine Studio for Grok

Everything needed to go public. Posting needs your own accounts; every text below is ready to paste.

**Links**
- Website: https://bacem-gpt.github.io/grok-imagine-studio/
- Download (always the latest): https://github.com/bacem-gpt/grok-imagine-studio/releases/latest/download/imagine-studio-for-grok.zip
- Repo: https://github.com/bacem-gpt/grok-imagine-studio
- Promo video (72 s): [1920×1080 for YouTube / X / LinkedIn](https://github.com/bacem-gpt/grok-imagine-studio/releases/download/v1.2.0/promo-1080p.mp4) · [1280×800](https://github.com/bacem-gpt/grok-imagine-studio/releases/download/v1.2.0/promo.mp4)
- Feature loops: `docs/assets/demo/{collect,edit,dialogue,phrases,export}.mp4` · README GIF: `brand/demo/teaser.gif` (rebuild everything with `node scripts/record-demos.mjs && node scripts/build-promo.mjs`)
- Logo: `brand/logo-1024.png` · Social card: `docs/assets/og.png` · Store images: `store/`

**Order of the day**
1. Chrome Web Store: submit (see `docs/STORE_LISTING.md`). Review takes days, so start first; the site already works without it.
2. X post with the 1080p video (best reach: native video, not a link card), then reply with the link.
3. Reddit (r/grok, then r/aivideo and r/ChromeExtensions a few hours apart; read each sub's self-promotion rules).
4. Product Hunt (schedule for 00:01 PT on a Tuesday–Thursday), Hacker News "Show HN" (weekday morning US time).
5. YouTube: upload the 1080p promo (it gets found by people searching "Grok Imagine editor").
6. Reply to everyone who comments in the first hours. Pin the X post. Add the GitHub link to your profile.

---

## X / Twitter

**Main post (attach `promo-1080p.mp4`):**
> Grok Imagine makes 20 clips. You need 4 of them — trimmed, in order, with music.
>
> So I built a free Chrome extension that puts a full video editor right inside grok.com.
>
> No downloading. No other app. Nothing uploaded.
>
> 🎬 Imagine Studio for Grok ↓

**Reply 1:**
> What it does:
> • collects every video Grok makes for you, with its prompt
> • timeline: trim, 22 transitions, titles, music, picture-in-picture, green screen
> • dialogue planner: paste a long scene → one part per 15 s video, each video tagged with its lines
> • one-click prompt phrases ("nobody speaks", "camera from top"…)
> • exports MP4 in your browser

**Reply 2:**
> Free & open source. Install in 1 minute:
> https://bacem-gpt.github.io/grok-imagine-studio/
>
> Made it because I was tired of the download → edit → back to Grok loop. Feedback very welcome 🙏

**Short alternative (single post):**
> I made a free Chrome extension that turns grok.com into a video editor: pick your best Grok Imagine clips, cut them together, add music & transitions, export MP4 — without leaving Grok. https://bacem-gpt.github.io/grok-imagine-studio/

Hashtags (optional, max 2): #GrokImagine #AIvideo

---

## Reddit

**Title:** I built a free Chrome extension that lets you edit Grok Imagine videos right inside grok.com (timeline, transitions, music, dialogue planner)

**Body:**
> I make short films with Grok Imagine and the slowest part was never the generation — it was downloading every clip, importing it into an editor, cutting, then going back to Grok for the next shot. Over and over.
>
> So I built **Imagine Studio for Grok**, a free, open-source Chrome extension that docks a video editor next to grok.com:
>
> - **Collect**: every video Grok generates for you lands in a bin with its prompt (one click, or automatic). Hover to scrub, pick/reject with the keyboard.
> - **Edit**: timeline with trim/split, 22 transitions, titles, music from a file or URL, picture-in-picture, green screen, reverse, freeze frame, voice-over.
> - **Dialogue planner**: paste a long dialogue, it's split into parts that fit one 15-second video each, every part becomes a prompt, and every generated video is tagged with its part — so you know which clip says which lines. Then assemble in order + auto subtitles.
> - **Quick phrases**: the stuff you type in every prompt ("nobody speaks", "camera angle from top") as one-click chips.
> - **Export** MP4/WebM in the browser. Nothing is uploaded anywhere; no account.
>
> 70-second demo + install: https://bacem-gpt.github.io/grok-imagine-studio/
> Code: https://github.com/bacem-gpt/grok-imagine-studio
>
> It's unofficial (not affiliated with xAI). It's not on the Chrome Web Store yet (in review), so for now it's a 1-minute "Load unpacked" install. I'd love feedback — what would make it more useful for your workflow?

---

## Product Hunt

- **Name:** Imagine Studio for Grok
- **Tagline (60):** Edit your Grok Imagine videos without leaving Grok
- **Topics:** Chrome Extensions, Video, Artificial Intelligence, Open Source
- **Gallery:** `store/marquee-1400x560.png`, then `store/screenshot-*.png`; video: upload `promo-1080p.mp4` to YouTube and paste the link
- **Description:**
> A free Chrome extension that docks a full video editor next to grok.com. Collect the clips Grok generates (with their prompts), pick the best takes, trim and cut them together with transitions, titles and music, plan long dialogues one 15-second video at a time, and export MP4 — all in your browser, nothing uploaded.
- **Maker comment:**
> Hi Product Hunt! I make short films with Grok Imagine, and the bottleneck was the round trip: download every clip, import into an editor, cut, go back to Grok for the next shot. Imagine Studio removes the trip — the editor lives in the Grok tab. My favourite part is the dialogue planner: paste a whole scene and every generated video stays tagged with the lines it says. It's free and open source. I'd love to hear what you'd add next!

---

## Hacker News

**Title:** Show HN: A video editor that runs inside grok.com (Chrome extension, no build step)

**Text:**
> I make short films with Grok Imagine. The slow part was the loop of downloading clips, editing them elsewhere and coming back. This extension docks an editor in the Grok tab instead.
>
> Technical bits that might interest HN: it's an MV3 extension with no build step (plain ES modules, vendored Preact+htm); the studio runs as an extension page in an iframe so it works under grok.com's strict CSP; preview and export share one canvas compositor so the MP4 matches the preview frame for frame; export uses WebCodecs via Mediabunny (with a WASM AAC fallback, since MV3 forbids blob workers we extract the worker); everything is stored in IndexedDB with three-way merges between windows. ~550 tests (node:test + Playwright driving the real extension against a mocked grok.com).
>
> Site/demo: https://bacem-gpt.github.io/grok-imagine-studio/ — code: https://github.com/bacem-gpt/grok-imagine-studio

---

## YouTube

- **Title:** Edit Grok Imagine videos without leaving Grok — free Chrome extension (Imagine Studio)
- **Description:**
> Imagine Studio for Grok is a free, open-source Chrome extension that puts a video editor inside grok.com: collect your Grok Imagine clips, pick the best takes, trim, add transitions, titles and music, plan long dialogues (one part per 15-second video), and export MP4 — all in your browser.
>
> Install (1 minute): https://bacem-gpt.github.io/grok-imagine-studio/
> Code: https://github.com/bacem-gpt/grok-imagine-studio
>
> 0:00 Intro · 0:03 Collect & pick · 0:16 Edit · 0:31 Dialogue planner · 0:48 Quick phrases · 0:56 Export
>
> Unofficial project, not affiliated with xAI. Demo footage generated with Grok Imagine.
- **Tags:** grok imagine, grok video, ai video editor, chrome extension, xai grok, ai film

---

## Answers for common comments

- **"Is this official?"** No — independent, open source, not affiliated with xAI. It only works with your own Grok account in your own browser.
- **"Is it safe / what data does it collect?"** None. No server, no analytics; clips stay in your browser's storage. Code is public; privacy policy: https://bacem-gpt.github.io/grok-imagine-studio/PRIVACY
- **"Why not on the Chrome Web Store?"** Submitted, in review. Until then the zip + "Load unpacked" installs the same thing.
- **"Firefox / Safari?"** Chromium browsers for now (Chrome, Edge, Brave, Arc, Opera).
