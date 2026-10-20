// Prompts tab regressions found in review: take decisions stick (Unlink / undo / redo / reload), one generation is
// one undo step, no duplicate "submitted on grok.com" step, reference images attached once, a failed submit is not
// reported as success, the take watcher runs before the tab is opened, variations keep a hand-written prompt,
// "Other" length, bold-label paste import, the Continue template without a style guide, comma tags, Alt+N as a
// macOS dead key, export downloads + Copy all, and the batch queue's "wait for each video" mode.
// UX review: text typed right before the window closes is kept, an insert-only send can be generated from the studio
// ("In Grok's box" → Generate), an unknown @Name goes straight to its description and back, the builder starts folded
// for a written shot, and the action bar / import tip / send menu / names hold up at 720 and 480 px.
import { test } from '@playwright/test';
import { launch, openGrok, studioFrame, openStudioTab, getProject, expect } from './harness.mjs';
import { POSTS, mediaPostList, videoUrl, thumbUrl } from './fixtures-map.mjs';
import { GENERATED_POST } from './content-mock-api.mjs';

const POLL = { polling: 200, timeout: 30000 }; // interval polling: rAF never fires in a hidden iframe
const WITHOUT_GENERATED = () => mediaPostList(Object.keys(POSTS).filter((id) => id !== GENERATED_POST));
const ownErrors = (ctx) => ctx.consoleErrors.filter((e) => !/favicon|ERR_FILE_NOT_FOUND|net::/i.test(e));
const shots = (t) => t.evaluate(() => window.__gis.projectStore.get().shots);

async function openPrompts(target) {
  await target.locator('.app-tabs .tab', { hasText: 'Prompts' }).click();
  await target.locator('.pr-root').waitFor();
}

/** Embedded studio frame with a connected bridge. */
async function studio(page) {
  const launcher = page.locator('gis-studio-root .launcher');
  if (await launcher.isVisible()) await launcher.click();
  const frame = await studioFrame(page, 30000);
  await frame.waitForFunction(() => window.__gis?.bridge?.connected && !!window.__gis.projectStore.get(), null, POLL);
  await frame.locator('.app-header').waitFor();
  return frame;
}

/** Opens the paste-list dialog with text through the app event (what grok.com's "send to prompts" does). */
async function importText(t, text) {
  await t.evaluate((txt) => window.__gis.appState.appEvents.emit('prompts.importText', { text: txt }), text);
  await t.locator('.pr-paste-dialog').waitFor();
}

const pageItem = (id, prompt, seenAt = Date.now()) => ({
  key: `video:${id}`,
  kind: 'video',
  url: videoUrl(id),
  altUrls: [],
  thumbUrl: thumbUrl(id),
  postId: id,
  prompt,
  model: null,
  createdAt: null,
  width: 640,
  height: 360,
  duration: null,
  source: 'network',
  pageUrl: 'https://grok.com/imagine',
  seenAt,
});

/** What grok.com reports as the media currently on the page. */
const setPageItems = (t, items) => t.evaluate((list) => window.__gis.pageStore.set((s) => ({ ...s, items: list })), items);

/** Marks shot #index as sent a second ago (as if its prompt had just been submitted). */
const markSent = (t, index) =>
  t.evaluate(async (i) => {
    const S = await import('/studio/prompts/shots.js');
    const p = window.__gis.projectStore.get();
    window.__gis.projectStore.update((q) => S.markShotSent(q, p.shots[i].id, { text: p.shots[i].prompt, at: Date.now() - 1000 }), { label: 'Send shot to Grok' });
  }, index);

/** Records the undo label after every history change (update / undo / redo). */
const recordHistory = (t) =>
  t.evaluate(() => {
    window.__hist = [];
    window.__gis.projectStore.onHistory(() => window.__hist.push(window.__gis.projectStore.undoLabel()));
  });
const history = (t) => t.evaluate(() => window.__hist.slice());

/**
 * Sets a text field inside the embedded studio through DOM events (after a send, grok.com's composer holds the
 * keyboard focus and CDP text input would go there).
 */
const setValue = (locator, value) =>
  locator.evaluate(async (el, v) => {
    el.focus();
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
  }, value);

/** Shots seeded straight into the project (one undo step). */
const seedShots = (t, list) =>
  t.evaluate(async (items) => {
    const S = await import('/studio/prompts/shots.js');
    window.__gis.projectStore.update((q) => S.addShots(q, items).project, { label: 'seed' });
  }, list);

test('take decisions stick: Unlink, undo / redo of an auto-link and a studio reload never re-link (standalone tab)', async () => {
  const ctx = await launch();
  try {
    const [RED, GREEN] = Object.keys(POSTS);
    const t = await openStudioTab(ctx);
    await openPrompts(t);
    await importText(t, '1. A red sports car drifting through neon rain, cinematic tracking shot\n2. A quiet harbor at dawn, fishing boats rocking');
    await t.locator('[data-testid="pr-paste-import"]').click();
    await expect(t.locator('.pr-card')).toHaveCount(2);
    await t.locator('.pr-card').first().click();
    await markSent(t, 0);
    await recordHistory(t);

    // A matching video shows up on grok.com: imported and linked as ONE undo step.
    const redItem = pageItem(RED, 'A red sports car drifting through neon rain');
    await setPageItems(t, [redItem]);
    await expect.poll(async () => (await shots(t))[0].takes.length, POLL).toBe(1);
    expect(await history(t)).toEqual(['Add to bin']);
    const red = (await shots(t))[0].takes[0];

    // Unlink sticks: the watcher does not link it back.
    await t.locator(`.pr-take[data-media-id="${red}"] .pr-take-foot [title^="Unlink"]`).click();
    await expect.poll(async () => (await shots(t))[0].takes).toEqual([]);
    await t.waitForTimeout(2000);
    expect((await shots(t))[0]).toMatchObject({ takes: [], status: 'sent' });
    expect(await history(t)).toEqual(['Add to bin', 'Unlink take']);

    // Undo / redo of the Unlink, with nothing re-linking in between.
    await t.locator('.pr-list-head .panel-title').click();
    await t.keyboard.press('Control+z');
    await expect.poll(async () => (await shots(t))[0].takes).toEqual([red]);
    await t.keyboard.press('Control+Shift+z');
    await expect.poll(async () => (await shots(t))[0].takes).toEqual([]);
    await t.waitForTimeout(1500);
    expect((await shots(t))[0].takes).toEqual([]);

    // A second take: Ctrl+Z right after the auto-link removes the clip and its link, and they stay removed.
    await setPageItems(t, [redItem, pageItem(GREEN, 'A red sports car drifting through neon rain, take two')]);
    await expect.poll(async () => (await shots(t))[0].takes.length, POLL).toBe(1);
    const green = (await shots(t))[0].takes[0];
    expect(green).not.toBe(red);
    await t.keyboard.press('Control+z');
    await expect.poll(async () => (await getProject(t)).media[green]).toBeUndefined();
    await t.waitForTimeout(2000);
    expect((await shots(t))[0].takes).toEqual([]);
    expect(await t.evaluate(() => window.__gis.projectStore.canRedo())).toBe(true);
    await t.keyboard.press('Control+Shift+z');
    await expect.poll(async () => (await shots(t))[0].takes).toEqual([green]);

    // After a reload the decisions still hold: the unlinked red clip in the bin is not linked again.
    await t.waitForTimeout(1000); // autosave
    await t.reload();
    await t.locator('.app-header').waitFor();
    await openPrompts(t);
    await t.waitForTimeout(2500);
    const p = await getProject(t);
    expect(p.shots[0].takes).toEqual([green]);
    expect(p.media[red].shotId).toBeFalsy();
    expect(ownErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('the take watcher links videos before the Prompts tab is ever opened (standalone tab)', async () => {
  const ctx = await launch();
  try {
    const [RED] = Object.keys(POSTS);
    const t = await openStudioTab(ctx);
    expect(await t.evaluate(() => window.__gis.uiStore.get().tab)).toBe('clips');
    await t.evaluate(async () => {
      const S = await import('/studio/prompts/shots.js');
      const text = 'A red sports car drifting through neon rain';
      window.__gis.projectStore.update((q) => {
        const r = S.addShot(q, { prompt: text });
        return S.markShotSent(r.project, r.id, { text, at: Date.now() - 1000 });
      }, { label: 'seed' });
    });
    await setPageItems(t, [pageItem(RED, 'A red sports car drifting through neon rain')]);
    await expect.poll(async () => (await shots(t))[0].takes.length, POLL).toBe(1);
    expect(await t.evaluate(() => !!document.querySelector('.pr-root'))).toBe(false); // the tab never rendered
    await expect(t.locator('.toast', { hasText: 'Linked 1 new take to shot 1' })).toBeVisible();
    expect(ownErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('send flow: one undo step per send and per generation, references attached once, a failed submit stays unsent (imagine page)', async () => {
  const ctx = await launch({ grok: { apiPosts: WITHOUT_GENERATED } });
  try {
    const page = await openGrok(ctx.page, '/imagine');
    const f = await studio(page);
    await openPrompts(f);
    const ingId = await f.evaluate(async () => {
      const { addIngredient } = await import('/studio/core/ingredients.js');
      const blob = await (await fetch('https://assets.grok.com/test/still.png')).blob();
      return addIngredient(blob, { name: 'Boat ref' });
    });
    await f.evaluate(async (ing) => {
      const S = await import('/studio/prompts/shots.js');
      window.__gis.projectStore.update(
        (q) =>
          S.addShots(q, [
            { title: 'Boat', prompt: 'A paper boat sailing down a rainy neon street', ingredientIds: [ing] },
            { title: 'Harbor', prompt: 'A quiet harbor at dawn with fishing boats rocking gently' },
          ]).project,
        { label: 'seed' },
      );
    }, ingId);
    await f.locator('.pr-card').first().click();
    await recordHistory(f);

    // Insert only: the reference image is attached, then the text.
    await f.locator('[data-testid="pr-send"]').click();
    await expect.poll(() => page.evaluate(() => window.__mock.attached.length)).toBe(1);
    await expect.poll(async () => (await shots(f))[0].status).toBe('sent');
    // Send & generate: the image is still in Grok's prompt box, so it is not uploaded a second time.
    await f.locator('.pr-send-caret').click();
    await f.locator('.menu-item', { hasText: 'Insert & generate' }).click();
    await expect.poll(() => page.evaluate(() => window.__mock.submitted)).toEqual(['A paper boat sailing down a rainy neon street']);
    await expect.poll(async () => (await shots(f))[0].takes.length, POLL).toBe(1);
    expect(await page.evaluate(() => window.__mock.attached.length)).toBe(1);
    // History: one step per send, one for the generated take — the echo of our own submit adds nothing.
    expect(await history(f)).toEqual(['Send shot 1 to Grok', 'Send shot 1 to Grok', 'Add to bin']);

    // A submit that doesn't happen: the text is in Grok's box, the shot stays a draft and the user is told so.
    await f.evaluate(() => {
      const b = window.__gis.bridge;
      const orig = b.request.bind(b);
      b.request = async (type, payload, opts) => {
        if (type === 'composer.insert' && payload?.submit) {
          const res = await orig(type, { ...payload, submit: false }, opts);
          return { ...res, submitted: false, error: 'the Submit button stayed disabled' };
        }
        return orig(type, payload, opts);
      };
    });
    await f.locator('.pr-card').nth(1).click();
    await f.locator('.pr-send-caret').click();
    await f.locator('.menu-item', { hasText: 'Insert & generate' }).click();
    await expect(f.locator('.toast', { hasText: "didn't start the generation" })).toContainText("press Grok's button");
    await expect(page.locator('.query-bar [contenteditable="true"]')).toHaveText('A quiet harbor at dawn with fishing boats rocking gently');
    expect((await shots(f))[1].status).toBe('draft');
    expect((await history(f)).length).toBe(3);
    // The user presses Grok's button: grok.com reports the submission and the shot is marked sent (one step).
    await page.locator('form.query-bar button.send').evaluate((b) => b.click());
    await expect.poll(async () => (await shots(f))[1].status, POLL).toBe('sent');
    expect(await history(f)).toEqual(['Send shot 1 to Grok', 'Send shot 1 to Grok', 'Add to bin', 'Prompt submitted on grok.com']);
    expect(ownErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('variations keep a hand-written prompt; “Other” length; bold-label paste; Continue template; comma tags; Alt+N dead key (standalone tab)', async () => {
  const ctx = await launch();
  try {
    const t = await openStudioTab(ctx);
    await openPrompts(t);
    await t.locator('[data-testid="pr-new-shot"]').click();
    const prompt = 'A paper boat sailing down a rainy neon street, @Mara watching from a window';
    await t.locator('#pr-prompt-input').fill(prompt);
    await t.locator('.pr-list-head .panel-title').click();
    await expect.poll(async () => (await shots(t))[0].prompt).toBe(prompt);

    // A Quick look fills builder fields; the variations still start from the hand-written prompt.
    await t.locator('.pr-recipe', { hasText: 'Film noir' }).click();
    await expect.poll(async () => (await shots(t))[0].fields.palette).toBe('black and white');
    await t.locator('.pr-section[data-section="variations"] .section-toggle').click();
    await t.locator('.pr-var-keys .chip', { hasText: 'Camera move' }).click();
    await t.locator('.pr-var-field .pr-chip', { hasText: /^Dolly in$/ }).click();
    await t.locator('.pr-var-field .pr-chip', { hasText: /^Whip pan$/ }).click();
    await expect(t.locator('.pr-var-sample')).toContainText('your prompt, with the varied phrases');
    await expect(t.locator('.pr-var-sample-text')).toHaveText(`${prompt}. Dolly in.`);
    await t.locator('[data-testid="pr-var-create"]').click();
    await expect.poll(async () => (await shots(t)).map((s) => s.prompt)).toEqual([prompt, `${prompt}. Dolly in.`, `${prompt}. Whip pan.`]);
    expect((await shots(t))[1].fields).toMatchObject({ camera: 'Dolly in', palette: 'black and white' });

    // "Other" length opens a number field for any length.
    await t.locator('.pr-card').first().click();
    await t.locator('.pr-section[data-section="details"] .section-toggle').click();
    const other = t.locator('.pr-details .segmented button', { hasText: 'Other' });
    await other.click();
    await expect(other).toHaveClass(/is-active/);
    const len = t.locator('.pr-other-len input');
    await expect(len).toBeVisible();
    await len.fill('7.5');
    await len.press('Enter');
    await expect.poll(async () => (await shots(t))[0].duration).toBe(7.5);
    await t.locator('.pr-details .segmented button', { hasText: '10s' }).click();
    await expect.poll(async () => (await shots(t))[0].duration).toBe(10);
    await expect(len).toBeHidden();

    // Bold "Shot N: Title" labels (typical Grok replies) import without Markdown; a timecode becomes the length.
    await importText(t, '**Shot 1: Opening drift** — a red sports car drifts around a neon-lit corner\n**Shot 2 (6-12s): Rooftop pursuit** — a hooded figure sprints across wet rooftops');
    const dlg = t.locator('.pr-paste-dialog');
    await expect(dlg.locator('.pr-paste-title')).toHaveText(['Opening drift', 'Rooftop pursuit']);
    await expect(dlg.locator('.pr-paste-list')).not.toContainText('**');
    await expect(dlg.locator('.pr-paste-meta')).toHaveText(['6s']);
    await dlg.locator('select').selectOption('end');
    await dlg.locator('[data-testid="pr-paste-import"]').click();
    expect((await shots(t)).slice(-2).map((s) => [s.title, s.prompt, s.duration])).toEqual([
      ['Opening drift', 'a red sports car drifts around a neon-lit corner', 6],
      ['Rooftop pursuit', 'a hooded figure sprints across wet rooftops', 6],
    ]);

    // "Continue from the last frame" works with an empty style guide.
    await t.locator('.pr-lib-tabs .tab', { hasText: 'Templates' }).click();
    await t.locator('[data-template="continue"]').click();
    const tpl = t.locator('.pr-tpl-detail');
    await expect(tpl.locator('.pr-tpl-missing')).toHaveText('Fill in: next');
    await tpl.locator('.pr-tpl-field', { hasText: 'What happens next' }).locator('textarea').fill('she turns and runs toward the train');
    await expect(tpl.locator('.pr-tpl-missing')).toHaveCount(0);
    await expect(tpl.locator('.pr-tpl-preview')).toContainText('she turns and runs toward the train. Keep the same character');
    await expect(tpl.locator('.pr-tpl-preview')).toContainText('Visual style: identical to the previous shot.');
    await expect(tpl.locator('.pr-tpl-field', { hasText: 'Style' }).locator('.pr-req')).toHaveCount(0);
    await expect(tpl.locator('[title="Copy the message"]')).toBeEnabled();

    // Snippet tags are comma separated: "film noir" stays one tag.
    await t.locator('.pr-lib-tabs .tab', { hasText: 'Snippets' }).click();
    await t.locator('[data-testid="pr-snip-new"]').click();
    const ed = t.locator('.pr-snip-editor');
    await ed.locator('input').first().fill('Noir look');
    await ed.locator('textarea').fill('high-contrast black and white, hard shadows');
    await ed.locator('input').nth(1).fill('film noir, house style');
    await ed.locator('[data-testid="pr-snip-save"]').click();
    await expect(t.locator('.pr-snip .pr-tag')).toHaveText(['#film noir', '#house style']);

    // The Import tab names grok.com's real context-menu item.
    await t.locator('.pr-lib-tabs .tab', { hasText: 'Import' }).click();
    await expect(t.locator('.pr-lib-tip')).toContainText('Send selected text to Studio prompt list');

    // Alt+N on macOS arrives as a dead key ("Dead" + KeyN): still a new shot. In library forms it is left alone.
    const before = (await shots(t)).length;
    await t.locator('#pr-prompt-input').evaluate((el) => {
      el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Dead', code: 'KeyN', altKey: true, bubbles: true, cancelable: true }));
    });
    await expect.poll(async () => (await shots(t)).length).toBe(before + 1);
    await t.locator('.pr-lib-tabs .tab', { hasText: 'Snippets' }).click();
    await t.locator('.pr-lib .pr-search input').evaluate((el) => {
      el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Dead', code: 'KeyN', altKey: true, bubbles: true, cancelable: true }));
    });
    await t.waitForTimeout(300);
    expect((await shots(t)).length).toBe(before + 1);
    expect(ownErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('exports download the list (the .txt re-imports with titles intact) and Copy all fills the clipboard (standalone tab)', async () => {
  const ctx = await launch();
  try {
    const t = await openStudioTab(ctx);
    await ctx.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openPrompts(t);
    await t.evaluate(async () => {
      const L = await import('/studio/prompts/library.js');
      window.__gis.libraryStore.set((s) => ({ ...s, snippets: [L.createSnippet({ title: 'look', text: 'moody and cinematic' })] }));
    });
    const list = [
      { title: 'Opening shot', prompt: 'A quiet harbor at dawn with fishing boats' },
      { title: '', prompt: 'Mara: walks slowly into the neon bar and orders a drink' },
      { title: 'The hero arrives at the old station', prompt: 'A train pulls into a foggy station at night, {{look}}' },
    ];
    await importText(t, JSON.stringify(list));
    await t.locator('[data-testid="pr-paste-import"]').click();
    await expect(t.locator('.pr-card')).toHaveCount(3);
    // Capture downloads instead of writing files.
    await t.evaluate(() => {
      window.__dl = [];
      chrome.downloads.download = async (opts) => {
        window.__dl.push({ filename: opts.filename, text: await (await fetch(opts.url)).text() });
        return 1;
      };
    });
    await t.locator('.pr-lib-tabs .tab', { hasText: 'Import' }).click();
    for (const fmt of ['txt', 'md', 'json', 'csv']) await t.locator('.pr-export-row .btn', { hasText: `.${fmt}` }).click();
    await expect.poll(() => t.evaluate(() => window.__dl.length)).toBe(4);
    const dl = await t.evaluate(() => window.__dl);
    expect(dl.map((d) => d.filename.replace(/^.*-shots/, '-shots'))).toEqual(['-shots.txt', '-shots.md', '-shots.json', '-shots.csv']);
    const txt = dl[0].text;
    expect(txt).toBe(
      [
        '1. **Opening shot** — A quiet harbor at dawn with fishing boats',
        '2. Prompt: Mara: walks slowly into the neon bar and orders a drink',
        '3. **The hero arrives at the old station** — A train pulls into a foggy station at night, moody and cinematic',
      ].join('\n'),
    );
    expect(JSON.parse(dl[2].text)[2]).toMatchObject({ title: 'The hero arrives at the old station', prompt: list[2].prompt, expanded: 'A train pulls into a foggy station at night, moody and cinematic' });
    expect(dl[3].text.split('\n')[0]).toBe('shot,title,prompt,duration,notes,status');
    expect(dl[1].text).toContain('### 2. Shot 2');

    // The .txt export reads back with the same titles (the paste preview).
    await importText(t, txt);
    const dlg = t.locator('.pr-paste-dialog');
    await expect(dlg.locator('.pr-paste-item')).toHaveCount(3);
    await expect(dlg.locator('.pr-paste-title')).toHaveText(['Opening shot', 'The hero arrives at the old station']);
    await expect(dlg.locator('.pr-paste-prompt').nth(1)).toHaveText('Mara: walks slowly into the neon bar and orders a drink');
    await dlg.locator('.modal-header [aria-label="Close"]').click();

    // Copy all = the .txt list.
    await t.bringToFront();
    await t.locator('.pr-export-row .btn', { hasText: 'Copy all' }).click();
    await expect(t.locator('.toast', { hasText: 'Copied 3 prompts' })).toBeVisible();
    expect(await t.evaluate(() => navigator.clipboard.readText())).toBe(txt);
    expect(ownErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('batch queue “wait for each video”: moves on when a new video appears, times out without one (standalone tab, stubbed grok.com)', async () => {
  const ctx = await launch();
  try {
    const [RED, GREEN] = Object.keys(POSTS);
    const t = await openStudioTab(ctx);
    await openPrompts(t);
    await importText(t, '1. A red sports car drifting through neon rain\n2. A misty green forest at dawn, slow dolly forward\n3. A third shot that never comes back');
    await t.locator('[data-testid="pr-paste-import"]').click();
    await expect(t.locator('.pr-card')).toHaveCount(3);
    // Pretend a grok.com tab is connected: inserts are recorded; generations are simulated below.
    await t.evaluate(async () => {
      const b = window.__gis.bridge;
      b.findTab = async () => {};
      b.connected = true;
      window.__gis.pageStore.set((s) => ({ ...s, connected: true }));
      window.__sent = [];
      b.request = async (type, payload) => {
        if (type === 'composer.insert') {
          window.__sent.push(payload);
          return { ok: true, method: 'mock', submitted: !!payload.submit };
        }
        if (type === 'composer.read') return { text: '', found: true };
        throw new Error(`unexpected request ${type}`);
      };
      const st = await import('/studio/ui/prompts/state.js');
      st.setPrefs({ queueWait: true, queueDelay: 0, queueTimeout: 3 });
    });
    const sent = () => t.evaluate(() => window.__sent.map((s) => [s.text, s.submit]));

    await t.locator('[data-testid="pr-batch"]').click();
    const dlg = t.locator('.pr-dialog', { hasText: 'Batch send to Grok' });
    await expect(dlg.locator('.toggle', { hasText: 'Wait for each video' }).locator('input')).toBeChecked();
    await dlg.locator('[data-testid="pr-queue-start"]').click();
    // Shot 1 is submitted, then the queue waits for its video.
    const items = dlg.locator('.pr-queue-item');
    await expect(items.nth(0)).toHaveClass(/is-waiting/);
    expect(await sent()).toEqual([['A red sports car drifting through neon rain', true]]);
    await t.waitForTimeout(800);
    expect((await sent()).length).toBe(1);
    // grok.com shows the new video: linked to shot 1, and the queue moves on to shot 2.
    const redItem = pageItem(RED, 'A red sports car drifting through neon rain');
    await setPageItems(t, [redItem]);
    await expect.poll(async () => (await sent()).length).toBe(2);
    await expect(items.nth(0)).toHaveClass(/is-done/);
    await expect(items.nth(1)).toHaveClass(/is-waiting/);
    await setPageItems(t, [redItem, pageItem(GREEN, 'A misty green forest at dawn, slow dolly forward')]);
    await expect.poll(async () => (await sent()).length).toBe(3);
    // No video for shot 3: it times out after 3 s and the run finishes.
    await expect(dlg.locator('.pr-queue-run-head')).toContainText('Finished', { timeout: 15000 });
    await expect(dlg.locator('.pr-queue-item.is-timeout')).toHaveCount(1);
    await expect(items.nth(2)).toContainText('Timed out');
    await expect(t.locator('.toast', { hasText: 'Batch finished' })).toContainText('1 without a new video');
    await expect.poll(async () => (await shots(t)).map((s) => s.status), POLL).toEqual(['generated', 'generated', 'sent']);
    expect(ownErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('text typed right before the window goes away is kept: grok.com tab closed, studio tab reloaded', async () => {
  const ctx = await launch();
  try {
    // A shot prompt typed in the docked studio, then the grok.com tab is closed at once (beforeunload runs).
    const page = await openGrok(ctx.page, '/imagine');
    const f = await studio(page);
    await openPrompts(f);
    await f.locator('.pr-welcome .btn', { hasText: 'New shot' }).click();
    await expect(f.locator('#pr-prompt-input')).toBeFocused();
    // Fill the studio frame's field itself: keyboard input can land in grok.com's composer under load (headless focus).
    await f.locator('#pr-prompt-input').fill('A lighthouse in a storm, waves crashing');
    await expect(f.locator('#pr-prompt-input')).toHaveValue('A lighthouse in a storm, waves crashing');
    // Typed text reaches the project (and its unload-proof localStorage journal) within ~60 ms; a human can't close
    // the tab faster than that.
    await page.waitForTimeout(150);
    await page.close({ runBeforeUnload: true });
    const again = await ctx.context.newPage();
    await openGrok(again, '/imagine');
    const f2 = await studio(again);
    // The closing page's save may land a moment after the new studio booted; it then arrives through the cross-window merge.
    await expect.poll(async () => (await shots(f2)).map((s) => s.prompt), { timeout: 10000 }).toEqual(['A lighthouse in a storm, waves crashing']);

    // The style guide typed in the standalone studio, which is reloaded at once.
    const t = await openStudioTab(ctx);
    await openPrompts(t);
    await t.locator('.pr-lib-tabs .tab', { hasText: 'Bible' }).click();
    await t.locator('[data-testid="pr-bible-style"]').click();
    await t.keyboard.type('cinematic, 35mm film grain');
    await t.reload();
    await t.waitForFunction(() => !!window.__gis?.projectStore.get(), null, POLL);
    await expect.poll(async () => (await getProject(t)).bible.style, { timeout: 10000 }).toBe('cinematic, 35mm film grain');
    expect(ownErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('insert-only send: the shot is "In Grok’s box" until submitted, and Generate (toast or action bar) presses Grok’s button (imagine page)', async () => {
  const ctx = await launch({ grok: { apiPosts: WITHOUT_GENERATED } });
  try {
    const page = await openGrok(ctx.page, '/imagine');
    const f = await studio(page);
    await openPrompts(f);
    const BOAT = 'A paper boat sailing down a rainy neon street';
    const HARBOR = 'A quiet harbor at dawn with fishing boats rocking gently';
    await seedShots(f, [
      { title: 'Boat', prompt: BOAT },
      { title: 'Harbor', prompt: HARBOR },
    ]);
    const card = (i) => f.locator('.pr-card').nth(i);
    const composer = page.locator('.query-bar [contenteditable="true"]');
    const submitted = () => page.evaluate(() => window.__mock.submitted);
    await card(0).click();
    await recordHistory(f);

    // Insert only: the prompt waits in Grok's box — the studio says so and offers to start the generation.
    await f.locator('[data-testid="pr-send"]').click();
    await expect(composer).toHaveText(BOAT);
    const inserted = f.locator('.toast', { hasText: "Shot 1 is in Grok's prompt box" });
    await expect(inserted.locator('.toast-action')).toHaveText('Generate now');
    await expect(card(0).locator('.pr-status')).toHaveText('In Grok’s box');
    await expect(f.locator('[data-testid="pr-status-btn"] .pr-status')).toHaveText('In Grok’s box');
    await expect(f.locator('.pr-takes-empty')).toContainText('In Grok’s prompt box');
    await expect(f.locator('[data-testid="pr-generate"]')).toHaveText('Generate');
    expect((await shots(f))[0].status).toBe('sent');
    expect(await submitted()).toEqual([]);

    // "Generate now" (toast): Grok's button is pressed, the new video becomes the take — and no extra undo step.
    await inserted.locator('.toast-action').click();
    await expect.poll(submitted).toEqual([BOAT]);
    await expect(f.locator('.toast', { hasText: 'Shot 1 sent to Grok — generating' })).toBeVisible();
    await expect(f.locator('[data-testid="pr-send"]')).toHaveText(/Send to Grok/);
    await expect.poll(async () => (await shots(f))[0].takes.length, POLL).toBe(1);
    await expect(card(0).locator('.pr-status')).toHaveText('Generated');
    expect(await history(f)).toEqual(['Send shot 1 to Grok', 'Add to bin']);

    // Shot 2: the action bar's Generate does the same, and the toast's offer goes away with it (a stale "Generate
    // now" would insert and generate the shot a second time).
    await card(1).click();
    await f.locator('[data-testid="pr-send"]').click();
    await expect(composer).toHaveText(HARBOR);
    const offer2 = f.locator('.toast', { hasText: "Shot 2 is in Grok's prompt box" });
    await expect(offer2).toHaveCount(1);
    await f.locator('[data-testid="pr-generate"]').click();
    await expect.poll(submitted).toEqual([BOAT, HARBOR]);
    await expect(card(1).locator('.pr-status')).toHaveText('Sent');
    await expect(offer2).toHaveCount(0);

    // Inserted again, then edited in the studio: Grok's box holds the old text, so the shot is no longer "in the
    // box" and "Generate now" inserts the new prompt before generating.
    await f.locator('[data-testid="pr-send"]').click();
    await expect(f.locator('[data-testid="pr-generate"]')).toBeVisible();
    const DUSK = 'A quiet harbor at dusk, paper lanterns drifting on the water';
    await setValue(f.locator('#pr-prompt-input'), DUSK);
    await expect(f.locator('[data-testid="pr-send"]')).toBeVisible();
    await expect(card(1).locator('.pr-status')).toHaveText('Sent');
    await offer2.locator('.toast-action').click();
    await expect.poll(submitted).toEqual([BOAT, HARBOR, DUSK]);

    // Pressing Grok's own button ends "In Grok's box" as well.
    await card(0).click();
    await f.locator('[data-testid="pr-send"]').click();
    await expect(card(0).locator('.pr-status')).toHaveText('In Grok’s box');
    await page.locator('form.query-bar button.send').evaluate((b) => b.click());
    await expect.poll(submitted).toEqual([BOAT, HARBOR, DUSK, BOAT]);
    await expect(card(0).locator('.pr-status')).toHaveText('Generated');
    await expect(f.locator('[data-testid="pr-send"]')).toBeVisible();
    expect(ownErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('an unknown @Name opens its new bible card with the description focused; “Back to shot” returns to the prompt (480 and 720 px)', async () => {
  for (const width of [480, 720]) {
    const ctx = await launch({ viewport: { width, height: 860 } });
    try {
      const narrow = width < 700;
      const t = await openStudioTab(ctx);
      await openPrompts(t);
      await t.locator('[data-testid="pr-new-shot"]').click();
      await t.locator('#pr-prompt-input').fill('@Mara walks into the neon bar');
      await t.locator('.pr-warn-tok', { hasText: '@Mara' }).click();

      // Straight to the description: the library (pane / left column) on the Bible tab, Mara's card open.
      const card = t.locator('.pr-bible-card.is-open');
      await expect(card.locator('.pr-bible-name')).toHaveValue('Mara');
      await expect(card.locator('textarea')).toBeFocused();
      await expect(t.locator('.pr-lib-tabs .tab[aria-selected="true"]')).toHaveText('Bible');
      if (narrow) await expect(t.locator('.pr-root')).toHaveClass(/pane-library/);
      else await expect(t.locator('.pr-col-list')).toBeHidden();
      await t.keyboard.type('a courier with short silver hair');

      // Back to the shot (the button at 480, Ctrl+Enter at 720): the layout is restored and the prompt focused.
      if (narrow) await card.locator('[data-testid="pr-bible-back"]').click();
      else await t.keyboard.press('Control+Enter');
      await expect(t.locator('#pr-prompt-input')).toBeFocused();
      if (narrow) await expect(t.locator('.pr-root')).toHaveClass(/pane-editor/);
      else await expect(t.locator('.pr-col-list')).toBeVisible();
      await expect(t.locator('[data-testid="pr-preview"]')).toContainText('Mara (a courier with short silver hair) walks into the neon bar');
      await expect(t.locator('.pr-warn-row')).toHaveCount(0);
      expect((await getProject(t)).bible.characters).toEqual([expect.objectContaining({ name: 'Mara', description: 'a courier with short silver hair' })]);
      // The way back is offered once.
      if (narrow) await t.locator('.pr-nav button', { hasText: 'Library' }).click();
      else await t.locator('.pr-side-switch button', { hasText: 'Library' }).first().click();
      await expect(t.locator('.pr-bible-card', { hasText: 'Mara' })).toBeVisible();
      await expect(t.locator('[data-testid="pr-bible-back"]')).toHaveCount(0);
      expect(ownErrors(ctx)).toEqual([]);
    } finally {
      await ctx.close();
    }
  }
});

test('the prompt builder starts folded for a shot that has a prompt, open for a new one; a toggle by hand sticks (standalone tab)', async () => {
  const ctx = await launch();
  try {
    const t = await openStudioTab(ctx);
    // Prefs saved by the previous version always held the old default (builder open): that no longer pins it open.
    await t.evaluate(() => localStorage.setItem('gis:prompts:prefs', JSON.stringify({ attachRefs: true, sections: { builder: true, refs: true, takes: true, details: false, variations: false } })));
    await t.reload();
    await t.locator('.app-header').waitFor();
    await openPrompts(t);
    await importText(t, '1. A red sports car drifting through neon rain\n2. A quiet harbor at dawn');
    await t.locator('[data-testid="pr-paste-import"]').click();
    await t.locator('.pr-card').first().click();
    const builder = t.locator('.pr-section[data-section="builder"]');
    await expect(builder).not.toHaveClass(/is-open/);
    // The quick phrases and the reference images (what goes to Grok with the prompt) come right after the prompt.
    expect(await t.locator('.pr-editor-body > .pr-section').evaluateAll((els) => els.map((e) => e.dataset.section))).toEqual(['phrases', 'refs', 'builder', 'takes', 'details', 'variations']);

    // A new shot has no prompt yet: the builder is open, and typing the first words doesn't fold it away.
    await t.locator('[data-testid="pr-new-shot"]').click();
    await expect(builder).toHaveClass(/is-open/);
    await t.locator('#pr-prompt-input').fill('A lighthouse in a storm');
    await expect.poll(async () => (await shots(t))[1].prompt).toBe('A lighthouse in a storm');
    await expect(builder).toHaveClass(/is-open/);

    // Folded by hand: it stays folded for every shot, also after a reload; opened by hand: it stays open.
    await builder.locator('.section-toggle').click();
    await expect(builder).not.toHaveClass(/is-open/);
    await t.locator('[data-testid="pr-new-shot"]').click();
    await expect(builder).not.toHaveClass(/is-open/);
    await builder.locator('.section-toggle').click();
    await expect(builder).toHaveClass(/is-open/);
    await t.locator('.pr-card').first().click();
    await expect(builder).toHaveClass(/is-open/);
    await expect.poll(() => t.evaluate(() => JSON.parse(localStorage.getItem('gis:prompts:prefs') || '{}').sections?.builder)).toBe(true);
    await t.reload();
    await t.locator('.app-header').waitFor();
    await openPrompts(t);
    await t.locator('.pr-card').first().click();
    await expect(t.locator('.pr-section[data-section="builder"]')).toHaveClass(/is-open/);
    expect(ownErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('layout at 720 and 480 px: “Approved” never covers the offline note, one-column import tip, whole send-menu labels, consistent names', async () => {
  for (const width of [720, 480]) {
    const ctx = await launch({ viewport: { width, height: 900 } });
    try {
      const narrow = width < 700;
      const t = await openStudioTab(ctx); // no grok.com tab: "Not connected"
      await openPrompts(t);
      await importText(t, '1. A lone astronaut walks across a red desert at dawn, wide shot, slow dolly in\n2. A quiet harbor at dawn');
      await t.locator('[data-testid="pr-paste-import"]').click();
      await t.locator('.pr-card').first().click();
      if (narrow) await expect(t.locator('.pr-nav button')).toHaveText(['Shots · 2', 'Editor', 'Library']);

      // Action bar: the left group keeps its size; the offline note (an icon below ~540 px of editor) gives way.
      await t.locator('.pr-actionbar .btn', { hasText: 'Approve' }).click();
      const offline = t.locator('.pr-offline');
      await expect(offline).toBeVisible();
      const note = await t.locator('.pr-approved-note').boundingBox();
      const off = await offline.boundingBox();
      const send = await t.locator('.pr-send').boundingBox();
      expect(note.x + note.width, 'Approved ends before the offline note').toBeLessThanOrEqual(off.x + 0.5);
      expect(off.x + off.width, 'the offline note ends before the send button').toBeLessThanOrEqual(send.x + 0.5);
      await expect(offline).toHaveAttribute('title', /isn't connected to a grok\.com tab/);
      await expect(offline.locator('.icon')).toBeVisible();
      const textWidth = await offline.locator('.pr-offline-text').evaluate((el) => el.getBoundingClientRect().width);
      expect(textWidth, 'icon only at this editor width').toBeLessThanOrEqual(1);

      // Send menu: every label shows in full.
      await t.locator('.pr-send-caret').click();
      const labels = await t.locator('.menu .menu-label').evaluateAll((els) => els.map((el) => ({ text: el.textContent, cut: el.scrollWidth > el.clientWidth + 1 })));
      expect(labels.map((l) => l.text)).toEqual(['Insert into Grok', 'Insert & generate', 'Inserts only', 'Inserts & generates', 'Attach reference images first']);
      expect(labels.filter((l) => l.cut)).toEqual([]);
      await t.keyboard.press('Escape');

      // Names: "Reference images (Ingredients)" in the editor; the Snippets tab speaks of snippets.
      await expect(t.locator('.pr-section[data-section="refs"] .section-toggle')).toContainText('Reference images (Ingredients)');
      await expect(t.locator('[data-testid="pr-open-ingredients"]')).toBeVisible();
      if (narrow) await t.locator('.pr-nav button', { hasText: 'Library' }).click();
      else await t.locator('.pr-side-switch button', { hasText: 'Library' }).first().click();
      await t.locator('.pr-lib-tabs .tab', { hasText: 'Snippets' }).click();
      await expect(t.locator('.pr-lib .pr-search input')).toHaveAttribute('placeholder', 'Search snippets');
      await expect(t.locator('.pr-lib .empty-title')).toHaveText('Snippets');

      // Import tip: the icon and ONE text block (not a column per text node).
      await t.locator('.pr-lib-tabs .tab', { hasText: 'Import' }).click();
      const tip = t.locator('.pr-lib-tip');
      expect(await tip.evaluate((el) => [...el.children].map((c) => c.localName))).toEqual(['svg', 'span']);
      await expect(tip.locator('span b')).toHaveText('Send selected text to Studio prompt list');
      expect(ownErrors(ctx)).toEqual([]);
    } finally {
      await ctx.close();
    }
  }
});
