// Quick phrases (Prompts tab: phrase board, sets, auto phrases, Library → Phrases) and the Dialogue tab (paste →
// split into ~15 s parts → one shot per part → send to Grok → takes recognised by part in the bin → assemble in
// dialogue order → subtitles), including the narrow layout.
import { test } from '@playwright/test';
import { launch, openGrok, studioFrame, openStudioTab, seedMedia, getProject, expect } from './harness.mjs';
import { POSTS, mediaPostList } from './fixtures-map.mjs';
import { GENERATED_POST } from './content-mock-api.mjs';

const POLL = { polling: 200, timeout: 30000 };
const ownErrors = (ctx) => ctx.consoleErrors.filter((e) => !/favicon|ERR_FILE_NOT_FOUND|net::/i.test(e));
const shots = (t) => t.evaluate(() => window.__gis.projectStore.get().shots);
const dialogue = (t) => t.evaluate(() => window.__gis.projectStore.get().dialogue);

async function openTab(t, label, root) {
  await t.locator('.app-tabs .tab', { hasText: label }).click();
  await t.locator(root).waitFor();
}

const SCRIPT = `ALICE: Did you see the light over the hill last night?
BOB: I did. I thought it was a plane at first, but it never moved.
ALICE: Planes don't stop in the middle of the sky and hover for ten whole minutes.
BOB (whispering): Then what was it? Tell me what you think it was.
(They both look up.)
ALICE: I don't know. But I think it's coming back tonight, and I want to be there when it does.
BOB: Then we go together. I'll bring the camera and the big flashlight.`;

test('quick phrases: starters, one-click toggle in the prompt, own phrases, sets, auto phrases, library tab', async () => {
  const ctx = await launch();
  try {
    const t = await openStudioTab(ctx);
    await openTab(t, 'Prompts', '.pr-root');
    await t.locator('[data-testid="pr-new-shot"]').click();
    await t.locator('#pr-prompt-input').fill('A knight rides through the fog');
    await t.locator('#pr-prompt-input').blur();
    await expect.poll(async () => (await shots(t))[0].prompt).toBe('A knight rides through the fog');

    // empty board → starter phrases
    const board = t.locator('[data-testid="pr-phrases"]');
    await board.locator('[data-testid="pr-phrases-starters"]').click();
    await expect(board.locator('.pr-phrase')).toHaveCount(13);

    // one click adds, a second click removes
    const nobody = board.locator('.pr-phrase[data-phrase="nobody speaks"]');
    await nobody.click();
    await expect.poll(async () => (await shots(t))[0].prompt).toBe('A knight rides through the fog. Nobody speaks.');
    await expect(t.locator('#pr-prompt-input')).toHaveValue('A knight rides through the fog. Nobody speaks.');
    await expect(nobody).toHaveAttribute('aria-pressed', 'true');
    await board.locator('.pr-phrase[data-phrase="camera angle from top"]').click();
    await expect.poll(async () => (await shots(t))[0].prompt).toBe('A knight rides through the fog. Nobody speaks. Camera angle from top.');
    await nobody.click();
    await expect.poll(async () => (await shots(t))[0].prompt).toBe('A knight rides through the fog. Camera angle from top.');
    // typing the phrase by hand lights its chip up
    await t.locator('#pr-prompt-input').fill('A knight rides. nobody speaks');
    await expect(nobody).toHaveAttribute('aria-pressed', 'true');

    // own phrase from the inline field: saved to the list and added to the prompt
    await board.locator('[data-testid="pr-phrase-input"]').fill('the knight never takes off his helmet');
    await board.locator('[data-testid="pr-phrase-input"]').press('Enter');
    await expect(board.locator('.pr-phrase[data-phrase="the knight never takes off his helmet"]')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await shots(t))[0].prompt).toMatch(/The knight never takes off his helmet\.$/);
    const lib = await t.evaluate(() => window.__gis.libraryStore.get().phrases.map((x) => x.text));
    expect(lib).toContain('the knight never takes off his helmet');

    // undo restores the previous prompt in one step
    await t.locator('.undo-btn').click();
    await expect.poll(async () => (await shots(t))[0].prompt).toBe('A knight rides. nobody speaks');

    // save the phrases that are on as a set, then apply it to a new shot in one click
    await board.locator('.pr-phrase[data-phrase="static camera"]').click();
    await t.locator('[data-section="phrases"] [title="Phrase options"]').click();
    await t.locator('.menu-item', { hasText: 'Save the phrases now on as a set' }).click();
    await t.locator('.modal input, .modal textarea').first().fill('Talking scene');
    await t.locator('.modal button[type="submit"]').click();
    await expect(board.locator('.pr-set-chip', { hasText: 'Talking scene' })).toHaveClass(/is-active/);

    // "start every new shot with it" (right-click menu) → a new shot starts with the phrase
    await board.locator('.pr-phrase[data-phrase="no text on screen"]').click({ button: 'right' });
    await t.locator('.menu-item', { hasText: 'Start every new shot with it' }).click();
    await t.locator('[data-testid="pr-new-shot"]').click();
    await expect.poll(async () => (await shots(t)).length).toBe(2);
    expect((await shots(t))[1].prompt).toBe('No text on screen.');
    await board.locator('.pr-set-chip', { hasText: 'Talking scene' }).click();
    await expect.poll(async () => (await shots(t))[1].prompt).toBe('No text on screen. Nobody speaks. Static camera.');

    // Library → Phrases: prepared library adds phrases to the list
    if (!(await t.locator('.pr-col-lib').isVisible())) await t.locator('.pr-side-switch button', { hasText: 'Library' }).first().click();
    await t.locator('.pr-lib-tabs .tab', { hasText: 'Phrases' }).click();
    await expect(t.locator('.pr-phrase-row')).toHaveCount(14);
    await t.locator('[data-testid="pr-prepared-toggle"]').click();
    await t.locator('.pr-prepared [data-prepared="whispered dialogue"]').click();
    await expect(t.locator('.pr-phrase-row')).toHaveCount(15);
    await expect(board.locator('.pr-phrase[data-phrase="whispered dialogue"]')).toBeVisible();
    expect(ownErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('dialogue: paste → parts that fit the clip → shots → takes known by part → assemble in order → subtitles', async () => {
  const ctx = await launch();
  try {
    const t = await openStudioTab(ctx);
    await openTab(t, 'Dialogue', '.dlg-root');
    await t.locator('[data-testid="dlg-start-text"]').fill(SCRIPT);
    await expect(t.locator('[data-testid="dlg-start-split"]')).toContainText(/Split into \d+ parts/);
    await t.locator('[data-testid="dlg-start-split"]').click();
    const parts = t.locator('[data-testid="dlg-part"]');
    await expect.poll(() => parts.count()).toBeGreaterThan(1);
    const n15 = await parts.count();
    // every part fits a 15 s clip
    expect(await t.locator('.dlg-part.is-over').count()).toBe(0);

    // shorter clips → more parts after "split again"
    await t.locator('.dlg-toolbar .segmented button', { hasText: '6s' }).click();
    await expect.poll(async () => (await dialogue(t)).settings.clipSeconds).toBe(6);
    await t.locator('[data-testid="dlg-more"]').click();
    await t.locator('.menu-item', { hasText: 'Split again to fit 6 s clips' }).click();
    await expect.poll(() => parts.count()).toBeGreaterThan(n15);
    expect(await t.locator('.dlg-part.is-over').count()).toBe(0);
    await t.locator('.dlg-toolbar .segmented button', { hasText: '15s' }).click();
    await t.locator('[data-testid="dlg-more"]').click();
    await t.locator('.menu-item', { hasText: 'Split again to fit 15 s clips' }).click();
    await expect.poll(() => parts.count()).toBe(n15);

    // scene + phrases go in every part's prompt
    await t.locator('[data-testid="dlg-scene"]').fill('Two friends on a hill at night, cinematic');
    await t.locator('[data-testid="dlg-scene"]').blur();
    await t.locator('.dlg-setup .pr-chip', { hasText: 'no music' }).click();
    await parts.first().locator('.pr-link-btn', { hasText: 'Prompt' }).click();
    await expect(parts.first().locator('[data-testid="dlg-prompt"]')).toHaveText(/^Two friends on a hill at night, cinematic\. ALICE says: “Did you see the light over the hill last night\?”.*No music\.$/);

    // one shot per part, titled by part, in dialogue order
    await t.locator('[data-testid="dlg-create-shots"]').click();
    await expect.poll(async () => (await shots(t)).length).toBe(n15);
    const list = await shots(t);
    expect(list.map((s) => s.title)).toEqual(Array.from({ length: n15 }, (_, i) => expect.stringMatching(new RegExp(`^Part ${i + 1} · `))));
    expect(list.every((s) => s.duration === 15)).toBe(true);
    const d = await dialogue(t);
    expect(d.parts.map((x) => x.shotId)).toEqual(list.map((s) => s.id));

    // videos generated for parts 2 and 1 (linked as takes) → the bin shows which part each one is
    const [a, b] = await seedMedia(t, ['clip-red.mp4', 'clip-green.mp4']);
    await t.evaluate(
      async ({ a, b, s1, s2 }) => {
        const S = await import('/studio/prompts/shots.js');
        window.__gis.projectStore.update((p) => S.linkTake(S.linkTake(p, s2, a), s1, b), { label: 'link' });
      },
      { a, b, s1: list[0].id, s2: list[1].id },
    );
    await expect(parts.nth(0).locator('.dlg-take')).toHaveCount(1);
    await expect(parts.nth(1).locator('.dlg-take')).toHaveCount(1);
    await openTab(t, 'Clips', '.clips-root, .bin-grid');
    await expect(t.locator(`.bin-card[data-media-id="${a}"] .clips-thumb-part`)).toHaveText('P2');
    await expect(t.locator(`.bin-card[data-media-id="${b}"] .clips-thumb-part`)).toHaveText('P1');

    // assemble in dialogue order (part 1's video first), then subtitles over the clips
    await openTab(t, 'Dialogue', '.dlg-root');
    await t.locator('[data-testid="dlg-more"]').click();
    await t.locator('.menu-item', { hasText: 'Assemble the videos in dialogue order' }).click();
    await expect.poll(async () => (await getProject(t)).tracks.video.map((c) => c.mediaId)).toEqual([b, a]);
    await t.locator('[data-testid="dlg-more"]').click();
    await t.locator('.menu-item', { hasText: 'Add the dialogue as subtitles' }).click();
    await expect.poll(async () => (await getProject(t)).tracks.text.filter((c) => c.dialogue).length).toBeGreaterThan(1);
    const subs = (await getProject(t)).tracks.text.filter((c) => c.dialogue);
    expect(subs[0].text).toBe('ALICE: Did you see the light over the hill last night?');
    expect(subs[0].start).toBeLessThan(1);
    // adding again replaces them
    const count = subs.length;
    await t.locator('[data-testid="dlg-more"]').click();
    await t.locator('.menu-item', { hasText: 'Add the dialogue as subtitles' }).click();
    await expect.poll(async () => (await getProject(t)).tracks.text.filter((c) => c.dialogue).length).toBe(count);

    // editing a part flags its shot for an update; "Update shot" rewrites the shot prompt
    const txt = parts.first().locator('.dlg-part-text');
    await txt.fill('ALICE: Did you see the light?');
    await txt.blur();
    await parts.first().locator('.dlg-stale').click();
    await expect.poll(async () => (await shots(t))[0].prompt).toMatch(/ALICE says: “Did you see the light\?”/);

    // script view: a "---" line splits a part; the other parts keep their shots
    await t.locator('.dlg-toolbar .segmented button', { hasText: 'Script' }).click();
    const script = t.locator('[data-testid="dlg-script"]');
    const value = await script.inputValue();
    // a "---" before the second line of a part that has several
    const two = (await dialogue(t)).parts.find((x) => x.text.split('\n').length > 1);
    const second = two.text.split('\n')[1];
    await script.fill(value.replace(`\n${second}`, `\n---\n${second}`));
    await script.blur();
    await expect.poll(async () => (await dialogue(t)).parts.length).toBe(n15 + 1);
    const after = await dialogue(t);
    expect(after.parts.filter((x) => x.shotId).length).toBeGreaterThanOrEqual(n15 - 1);
    expect(ownErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('dialogue part → Send puts its prompt in grok.com’s composer (embedded)', async () => {
  const ctx = await launch({ grok: { apiPosts: () => mediaPostList(Object.keys(POSTS).filter((id) => id !== GENERATED_POST)) } });
  try {
    const page = await openGrok(ctx.page, '/imagine');
    const launcher = page.locator('gis-studio-root .launcher');
    if (await launcher.isVisible()) await launcher.click();
    const f = await studioFrame(page, 30000);
    await f.waitForFunction(() => window.__gis?.bridge?.connected && !!window.__gis.projectStore.get(), null, POLL);
    await f.evaluate(async (script) => {
      const D = await import('/studio/prompts/dialogue.js');
      window.__gis.projectStore.update((p) => D.autoSplit(p, script), { label: 'seed' });
      window.__gis.uiStore.set((s) => ({ ...s, tab: 'dialogue' }));
    }, 'ALICE: Hello Bob.\nBOB: Hello Alice.');
    await f.locator('[data-testid="dlg-part"]').first().waitFor();
    await f.locator('[data-testid="dlg-send"]').first().click();
    await expect(page.locator('.query-bar [contenteditable="true"]')).toHaveText('ALICE says: “Hello Bob.” BOB says: “Hello Alice.”');
    await expect.poll(async () => (await shots(f)).map((s) => [s.title, s.status])).toEqual([['Part 1 · ALICE & BOB', 'sent']]);
    expect(ownErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('dialogue tab at 480 px: setup pane, no horizontal overflow', async () => {
  const ctx = await launch({ viewport: { width: 480, height: 860 } });
  try {
    const t = await openStudioTab(ctx);
    await openTab(t, 'Dialogue', '.dlg-root');
    await t.locator('[data-testid="dlg-start-text"]').fill(SCRIPT);
    await t.locator('[data-testid="dlg-start-split"]').click();
    await expect(t.locator('.dlg-root')).toHaveClass(/is-narrow/);
    for (const label of ['Parts', 'Script', 'Setup']) {
      await t.locator('.dlg-toolbar .segmented button', { hasText: label }).click();
      const overflow = await t.evaluate(() => {
        const r = document.querySelector('.dlg-root');
        const widest = Math.max(...[...r.querySelectorAll('*')].filter((el) => el.offsetParent).map((el) => el.getBoundingClientRect().right));
        return { scroll: r.scrollWidth - r.clientWidth, widest: Math.round(widest), width: r.clientWidth };
      });
      expect(overflow.scroll, label).toBeLessThanOrEqual(0);
      expect(overflow.widest, label).toBeLessThanOrEqual(overflow.width + 1);
    }
    await expect(t.locator('[data-testid="dlg-scene"]')).toBeVisible();
    expect(ownErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});
