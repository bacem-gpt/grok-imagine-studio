// Prompts tab (studio/ui/prompts/**, studio/prompts/**): shot list, builder, token expansion, snippets, bible,
// paste-list import (incl. Grok's latest reply and the prompts.importText event), send to Grok (composer text,
// reference attach), generated videos auto-linked as takes, takes → assemble timeline, batch queue, keyboard,
// and the narrow (480 px) layout.
import { test } from '@playwright/test';
import { launch, openGrok, studioFrame, openStudioTab, seedMedia, getProject, expect } from './harness.mjs';
import { POSTS, mediaPostList, videoUrl, thumbUrl } from './fixtures-map.mjs';
import { GENERATED_POST } from './content-mock-api.mjs';

const POLL = { polling: 200, timeout: 30000 }; // interval polling: rAF never fires in a hidden iframe
const WITHOUT_GENERATED = () => mediaPostList(Object.keys(POSTS).filter((id) => id !== GENERATED_POST));

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

const shots = (t) => t.evaluate(() => window.__gis.projectStore.get().shots);

/**
 * Sets a text field inside the embedded studio iframe through DOM events. (When grok.com's composer holds focus,
 * headless Chrome routes CDP text input from locator.fill() to it instead of the extension iframe.)
 */
async function setValue(locator, value) {
  await locator.evaluate(async (el, v) => {
    el.focus();
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
  }, value);
}

/** Dispatches a keyboard shortcut on an element inside the embedded studio (same focus caveat as setValue). */
async function shortcut(locator, { key, ctrl = false, shift = false, alt = false }) {
  await locator.evaluate((el, o) => {
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: o.key, ctrlKey: o.ctrl, shiftKey: o.shift, altKey: o.alt, bubbles: true, cancelable: true }));
  }, { key, ctrl, shift, alt });
}

/** Shows a library tab (at medium widths the left column switches from the shot list to the library first). */
async function openLibrary(t, tab) {
  if (!(await t.locator('.pr-col-lib').isVisible())) await t.locator('.pr-side-switch button', { hasText: 'Library' }).first().click();
  await t.locator('.pr-lib-tabs .tab', { hasText: tab }).click();
}

/** Back to the shot list at medium widths. */
async function showList(t) {
  if (!(await t.locator('.pr-col-list').isVisible())) await t.locator('.pr-col-lib .pr-side-switch button', { hasText: 'Shots' }).click();
}
const ownErrors = (ctx) => ctx.consoleErrors.filter((e) => !/favicon|ERR_FILE_NOT_FOUND|net::/i.test(e));

/** Opens the paste-list dialog with text through the app event (what grok.com's "send to prompts" does). */
async function importText(t, text) {
  await t.evaluate((txt) => window.__gis.appState.appEvents.emit('prompts.importText', { text: txt }), text);
  await t.locator('.pr-paste-dialog').waitFor();
}

test('shots, builder compose, token expansion, bible, snippets, reorder and keyboard (standalone tab)', async () => {
  const ctx = await launch();
  try {
    const t = await openStudioTab(ctx);
    await openPrompts(t);
    await expect(t.locator('.pr-welcome')).toContainText('Prompt workshop');

    // New shot + title
    await t.locator('[data-testid="pr-new-shot"]').click();
    await expect.poll(async () => (await shots(t)).length).toBe(1);
    await expect(t.locator('#pr-prompt-input')).toBeFocused();
    await t.locator('[data-testid="pr-title"]').fill('Arrival');
    await t.locator('[data-testid="pr-title"]').press('Enter');
    await expect.poll(async () => (await shots(t))[0].title).toBe('Arrival');

    // Builder: chip + typed fields -> live preview -> Compose
    await t.locator('.pr-field[data-field="shot"] .pr-field-chips-btn').click();
    await t.locator('.pr-chip-panel[data-field="shot"] .pr-chip', { hasText: /^Wide$/ }).click();
    await expect.poll(async () => (await shots(t))[0].fields.shot).toBe('Wide shot');
    await t.locator('#pr-f-subject').fill('a lone rider');
    await t.locator('#pr-f-action').fill('cresting a dune at dawn');
    await t.locator('#pr-f-action').press('Enter');
    await t.locator('.pr-field[data-field="mood"] .pr-field-chips-btn').click();
    await t.locator('.pr-chip-panel[data-field="mood"] .pr-chip', { hasText: /^Epic$/ }).click();
    await expect(t.locator('[data-testid="pr-compose-preview"]')).toHaveText('Wide shot of a lone rider cresting a dune at dawn. Epic mood.');
    await t.locator('[data-testid="pr-compose"]').click();
    await expect(t.locator('#pr-prompt-input')).toHaveValue('Wide shot of a lone rider cresting a dune at dawn. Epic mood.');
    await expect.poll(async () => (await shots(t))[0].prompt).toBe('Wide shot of a lone rider cresting a dune at dawn. Epic mood.');

    // Quick look applies several fields at once (one undo step)
    await t.locator('.pr-recipe', { hasText: 'Film noir' }).click();
    await expect.poll(async () => (await shots(t))[0].fields.palette).toBe('black and white');

    // Bible character used by @mention expansion; unknown tokens are flagged
    await t.locator('.pr-lib-tabs .tab', { hasText: 'Bible' }).click();
    await t.locator('[data-testid="pr-add-characters"]').click();
    const card = t.locator('.pr-bible-card.is-open');
    await card.locator('.pr-bible-name').fill('Mara');
    await card.locator('textarea').fill('a courier with short silver hair');
    await card.locator('textarea').blur();
    await expect.poll(async () => (await getProject(t)).bible.characters[0]).toMatchObject({ name: 'Mara', description: 'a courier with short silver hair' });
    const prompt = t.locator('#pr-prompt-input');
    await prompt.fill('@Mara looks back at @Bob. {{style}}');
    await expect(t.locator('[data-testid="pr-preview"]')).toContainText('Mara (a courier with short silver hair) looks back at @Bob.');
    await expect(t.locator('.pr-warn-row')).toContainText('@Bob');
    await expect(t.locator('.pr-warn-row')).toContainText('Empty: {{style}}');
    await t.locator('[data-testid="pr-bible-style"]').fill('cinematic, 35mm film grain');
    await t.locator('[data-testid="pr-bible-style"]').blur();
    await expect(t.locator('[data-testid="pr-preview"]')).toContainText('cinematic, 35mm film grain');
    await expect(t.locator('.pr-warn-row')).not.toContainText('Empty');
    // Fix the unknown @Bob from the warning: adds him to the bible.
    await t.locator('.pr-warn-tok', { hasText: '@Bob' }).click();
    await expect.poll(async () => (await getProject(t)).bible.characters.map((c) => c.name)).toEqual(['Mara', 'Bob']);
    await expect(t.locator('.pr-warn-row')).toHaveCount(0);

    // Snippet ("prepared text") inserted at the cursor
    await t.locator('.pr-lib-tabs .tab', { hasText: 'Snippets' }).click();
    await t.locator('[data-testid="pr-snip-new"]').click();
    const editor = t.locator('.pr-snip-editor');
    await editor.locator('input').first().fill('No text');
    await editor.locator('textarea').fill('no text, no watermarks');
    await editor.locator('[data-testid="pr-snip-save"]').click();
    await expect(t.locator('.pr-snip')).toHaveCount(1);
    await expect(t.locator('.pr-snip .pr-token-chip')).toHaveText('{{no-text}}');
    await prompt.click();
    await prompt.press('End');
    await prompt.press('Control+End');
    await t.locator('[data-testid="pr-snip-insert"]').click();
    await expect(prompt).toHaveValue('@Mara looks back at @Bob. {{style}} no text, no watermarks');
    await expect.poll(async () => (await shots(t))[0].prompt).toContain('no text, no watermarks');
    // The token form expands too.
    await t.locator('.pr-snip .pr-token-chip').click();
    await expect(t.locator('[data-testid="pr-preview"]')).toContainText('no text, no watermarks no text, no watermarks');
    await expect(t.locator('[data-testid="pr-char-count"]')).toContainText('chars');

    // Keyboard: Alt+N new shot (works while typing), Alt+↑/↓ navigate, Ctrl+D duplicate, Ctrl+Z undo
    await prompt.press('Alt+n');
    await expect.poll(async () => (await shots(t)).length).toBe(2);
    await expect(t.locator('.pr-card.is-selected')).toContainText('No prompt yet');
    await t.locator('#pr-prompt-input').fill('Close-up of the rider’s eyes narrowing against the wind');
    await t.keyboard.press('Alt+ArrowUp');
    await expect(t.locator('.pr-card.is-selected')).toContainText('Arrival');
    await expect(t.locator('[data-testid="pr-title"]')).toHaveValue('Arrival');
    await t.locator('.pr-list-head .panel-title').click(); // leave the text field
    await t.keyboard.press('Control+d');
    await expect.poll(async () => (await shots(t)).map((s) => s.title)).toEqual(['Arrival', 'Arrival (copy)', '']);
    await t.keyboard.press('Control+z');
    await expect.poll(async () => (await shots(t)).map((s) => s.title)).toEqual(['Arrival', '']);
    await expect(t.locator('.pr-card.is-selected')).toContainText('Arrival');
    await t.keyboard.press('Alt+ArrowDown');
    await expect(t.locator('.pr-card.is-selected')).toContainText('Close-up');

    // Reorder: context menu "Move up", then drag the card back down
    await t.locator('.pr-card').nth(1).click({ button: 'right' });
    await t.locator('.menu-item', { hasText: 'Move up' }).click();
    await expect.poll(async () => (await shots(t)).map((s) => s.title)).toEqual(['', 'Arrival']);
    const first = await t.locator('.pr-card').nth(0).boundingBox();
    const second = await t.locator('.pr-card').nth(1).boundingBox();
    await t.mouse.move(first.x + 40, first.y + first.height / 2);
    await t.mouse.down();
    await t.mouse.move(first.x + 40, first.y + first.height / 2 + 20, { steps: 4 });
    await t.mouse.move(second.x + 40, second.y + second.height - 4, { steps: 8 });
    await t.mouse.up();
    await expect.poll(async () => (await shots(t)).map((s) => s.title)).toEqual(['Arrival', '']);

    // Generation hints: length and mode (image → video asks for a reference image)
    await t.locator('.pr-section[data-section="details"] .section-toggle').click();
    await t.locator('.pr-details .segmented button', { hasText: '10s' }).click();
    await t.locator('.pr-details .segmented button', { hasText: 'Image → video' }).click();
    await expect.poll(async () => (await shots(t)).find((s) => s.prompt.startsWith('Close-up'))).toMatchObject({ duration: 10, mode: 'animate' });
    await expect(t.locator('.pr-refs ~ .pr-hint, .pr-section[data-section="refs"] .pr-hint')).toContainText('need a reference image');

    // Variations: 2 camera moves -> 2 new shots right after this one
    await t.locator('.pr-section[data-section="variations"] .section-toggle').click();
    await t.locator('.pr-var-keys .chip', { hasText: 'Camera move' }).click();
    await t.locator('.pr-var-field .pr-chip', { hasText: /^Dolly in$/ }).click();
    await t.locator('.pr-var-field .pr-chip', { hasText: /^Orbit$/ }).click();
    await expect(t.locator('.pr-var-sample-text')).toContainText('Dolly in');
    await t.locator('[data-testid="pr-var-create"]').click();
    await expect.poll(async () => (await shots(t)).length).toBe(4);
    const vars = (await shots(t)).slice(2, 4); // inserted right after the selected shot (shot 2)
    expect(vars.map((v) => v.title)).toEqual(['Shot 2 · Dolly in', 'Shot 2 · Orbit']);
    expect(vars[0].prompt).toBe('Close-up of the rider’s eyes narrowing against the wind. Dolly in.');
    expect(vars[1].prompt).toBe('Close-up of the rider’s eyes narrowing against the wind. Slow 360-degree orbit around the subject.');
    expect(vars.every((v) => v.duration === 10 && v.mode === 'animate')).toBe(true);
    await t.locator('.pr-list-head .panel-title').click();
    await t.keyboard.press('Control+z'); // one undo removes all variations
    await expect.poll(async () => (await shots(t)).length).toBe(2);

    // Status menu
    await t.locator('[data-testid="pr-status-btn"]').click();
    await t.locator('.menu-item', { hasText: 'Approved' }).click();
    await expect.poll(async () => (await shots(t)).filter((s) => s.status === 'approved').length).toBe(1);
    await expect(t.locator('.pr-card.is-selected .pr-status')).toHaveText('Approved');

    expect(ownErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('import: Grok’s latest reply, prompts.importText event, paste preview with exclusions and replace (chat page)', async () => {
  const ctx = await launch();
  try {
    const page = await openGrok(ctx.page, '/c/mock-chat');
    const f = await studio(page);
    await openPrompts(f);

    await expect(f.locator('.pr-root')).toHaveClass(/is-medium/); // docked right at half the window
    await openLibrary(f, 'Import');
    await f.locator('[data-testid="pr-import-reply"]').click();
    const dialog = f.locator('.pr-paste-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.pr-paste-source')).toContainText('Grok’s latest reply');
    await expect(dialog.locator('.pr-paste-item')).toHaveCount(4);
    await expect(dialog.locator('.pr-paste-summary')).toContainText('4 shots');
    await dialog.locator('[data-testid="pr-paste-import"]').click();
    await expect(dialog).toBeHidden();
    const list = await shots(f);
    expect(list.map((s) => s.title)).toEqual(['Opening drift', 'Rooftop pursuit', 'Tunnel burst', 'Final stop']);
    expect(list[0].prompt).toBe('a red sports car drifts around a neon-lit corner in the rain, low tracking shot');
    await expect(f.locator('.pr-card')).toHaveCount(4);

    // Text sent from grok.com (context menu) arrives as an app event and opens the preview.
    await importText(f, '[{"title":"Harbor","prompt":"Boats rock in a glowing harbor"},{"title":"Skip me","prompt":"x y z"}]');
    await expect(dialog.locator('.pr-paste-summary')).toContainText('JSON');
    await dialog.locator('.pr-paste-item').nth(1).locator('input').uncheck();
    await expect(dialog.locator('[data-testid="pr-paste-import"]')).toHaveText(/Import 1 shot/);
    await dialog.locator('[data-testid="pr-paste-import"]').click();
    await expect.poll(async () => (await shots(f)).length).toBe(5);
    expect((await shots(f))[1].title).toBe('Harbor'); // inserted after the selected (first) shot

    // Template → Grok chat: fill the variables, send, then import Grok's reply as shots.
    await openLibrary(f, 'Templates');
    await f.locator('[data-template="shot-list"]').click();
    const tpl = f.locator('.pr-tpl-detail');
    await expect(tpl.locator('[data-testid="pr-tpl-send"]')).toBeDisabled(); // topic is required
    await setValue(tpl.locator('.pr-tpl-field', { hasText: 'Topic' }).locator('textarea'), 'a street race through a flooded neon city');
    await expect(tpl.locator('.pr-tpl-preview')).toContainText('Write 6 cinematic shot prompts for a short video sequence about a street race through a flooded neon city.');
    await tpl.locator('[data-testid="pr-tpl-send"]').click();
    await expect.poll(() => page.evaluate(() => window.__mock.submitted.length)).toBe(1);
    expect((await page.evaluate(() => window.__mock.submitted))[0]).toContain('a street race through a flooded neon city');
    await tpl.locator('[data-testid="pr-tpl-import"]').click();
    await expect(dialog).toBeVisible();
    await dialog.locator('.modal-header [aria-label="Close"]').click();

    // Manual paste, replacing the list.
    await showList(f);
    await f.locator('.pr-list-head [title="Paste a prompt list"]').click();
    await setValue(dialog.locator('[data-testid="pr-paste-text"]'), 'title,prompt,duration\nA,"First, with a comma",10\nB,Second,6');
    await expect(dialog.locator('.pr-paste-summary')).toContainText('CSV');
    await dialog.locator('select').selectOption('replace');
    await dialog.locator('[data-testid="pr-paste-import"]').click();
    await expect.poll(async () => (await shots(f)).map((s) => [s.title, s.prompt, s.duration])).toEqual([
      ['A', 'First, with a comma', 10],
      ['B', 'Second', 6],
    ]);
    expect(ownErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('send to Grok: composer text, reference attached, generated video auto-linked as a take (imagine page)', async () => {
  const ctx = await launch({ grok: { apiPosts: WITHOUT_GENERATED } });
  try {
    const page = await openGrok(ctx.page, '/imagine');
    const f = await studio(page);
    await openPrompts(f);
    // A snippet and a reference image in the library.
    const ingId = await f.evaluate(async () => {
      const { addIngredient } = await import('/studio/core/ingredients.js');
      const L = await import('/studio/prompts/library.js');
      window.__gis.libraryStore.set((s) => ({ ...s, snippets: [L.createSnippet({ title: 'look', text: 'cinematic and moody' })] }));
      const blob = await (await fetch('https://assets.grok.com/test/still.png')).blob();
      return addIngredient(blob, { name: 'Boat ref' });
    });
    // Record bridge traffic (payloads without blobs).
    await f.evaluate(() => {
      const b = window.__gis.bridge;
      const orig = b.request.bind(b);
      window.__calls = [];
      b.request = async (type, payload, opts) => {
        const rec = { type, payload: payload && typeof payload === 'object' ? Object.fromEntries(Object.entries(payload).filter(([, v]) => !(v instanceof Blob))) : payload };
        window.__calls.push(rec);
        try {
          rec.result = await orig(type, payload, opts);
          return rec.result;
        } catch (e) {
          rec.error = String(e.message || e);
          throw e;
        }
      };
    });

    await f.locator('[data-testid="pr-new-shot"]').click();
    const text = 'A paper boat sailing down a rainy neon street, {{look}}';
    const expanded = 'A paper boat sailing down a rainy neon street, cinematic and moody';
    await setValue(f.locator('#pr-prompt-input'), text);
    await expect(f.locator('[data-testid="pr-preview"]')).toContainText(expanded);
    // Reference image through the Ingredients picker.
    await f.locator('.pr-refs [data-testid="ing-picker-add"]').click();
    await f.locator(`.ing-pick-card[data-id="${ingId}"]`).click();
    await f.locator('[data-testid="picker-done"]').click();
    await expect.poll(async () => (await shots(f))[0].ingredientIds).toEqual([ingId]);

    // Send (insert only): the composer on grok.com receives the expanded prompt; the reference is attached first.
    await f.locator('[data-testid="pr-send"]').click();
    await expect(page.locator('.query-bar [contenteditable="true"]')).toHaveText(expanded);
    await expect.poll(() => page.evaluate(() => window.__mock.attached.length)).toBe(1);
    await expect.poll(() => f.evaluate(() => window.__calls.find((c) => c.type === 'composer.insert')?.result)).toMatchObject({ ok: true });
    const insert = (await f.evaluate(() => window.__calls)).find((c) => c.type === 'composer.insert');
    expect(insert.payload).toEqual({ text: expanded, mode: 'replace', submit: false });
    expect((await f.evaluate(() => window.__calls)).map((c) => c.type).filter((x) => x.startsWith('composer.'))).toEqual(['composer.attach', 'composer.insert']);
    await expect.poll(async () => (await shots(f))[0].status).toBe('sent');
    expect((await shots(f))[0].sentText).toBe(expanded);

    // Send + generate with the keyboard: Grok (mock) generates a video for this prompt; it comes back as a take.
    await shortcut(f.locator('#pr-prompt-input'), { key: 'Enter', ctrl: true, shift: true });
    await expect.poll(() => page.evaluate(() => window.__mock.submitted)).toEqual([expanded]);
    await f.waitForFunction(
      (gen) => {
        const p = window.__gis.projectStore.get();
        const s = p.shots[0];
        return s.takes.length === 1 && p.media[s.takes[0]]?.pageKey === `video:${gen}` && s.status === 'generated';
      },
      GENERATED_POST,
      POLL,
    );
    const p = await getProject(f);
    const take = p.media[p.shots[0].takes[0]];
    expect(take.shotId).toBe(p.shots[0].id);
    expect(take.prompt).toBe(expanded);
    await expect(f.locator('.pr-take')).toHaveCount(1);
    await expect(f.locator('.pr-card').first().locator('.pr-card-takes')).toContainText('1');
    await f.waitForFunction((id) => window.__gis.projectStore.get().media[id].status === 'ready', take.id, POLL);
    expect(ownErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('takes: link from the bin, choose the best take, assemble the timeline in shot order (standalone tab)', async () => {
  const ctx = await launch();
  try {
    const t = await openStudioTab(ctx);
    const [red, green, blue] = await seedMedia(t, ['clip-red.mp4', 'clip-green.mp4', 'clip-blue.mp4']);
    // Text sent to the prompt list before the Prompts tab was ever opened: the tab opens with the preview.
    expect(await t.evaluate(() => window.__gis.uiStore.get().tab)).toBe('clips');
    await importText(t, '1. Red car drifting\n2. Blue ocean waves');
    expect(await t.evaluate(() => window.__gis.uiStore.get().tab)).toBe('prompts');
    await t.locator('[data-testid="pr-paste-import"]').click();
    await expect(t.locator('.pr-card')).toHaveCount(2);

    // Shot 1: link two takes from the bin.
    await t.locator('.pr-card').first().click();
    await t.locator('.pr-takes-tools .btn', { hasText: 'Link from bin' }).click();
    await t.locator(`.pr-link-card[data-media-id="${red}"]`).click();
    await t.locator(`.pr-link-card[data-media-id="${green}"]`).click();
    await t.locator('[data-testid="pr-link-done"]').click();
    await expect(t.locator('.pr-take')).toHaveCount(2);
    let p = await getProject(t);
    expect(p.shots[0].takes).toEqual([red, green]);
    expect(p.shots[0].status).toBe('generated');
    expect(p.media[red].shotId).toBe(p.shots[0].id);
    // Choose the second take.
    await t.locator(`.pr-take[data-media-id="${green}"] .pr-take-foot [title^="Use this take"]`).click();
    await expect.poll(async () => (await shots(t))[0].chosenTake).toBe(green);
    await expect(t.locator(`.pr-take[data-media-id="${green}"]`)).toHaveClass(/is-chosen/);

    // Shot 2: one take.
    await t.locator('.pr-card').nth(1).click();
    await t.locator('.pr-takes-tools .btn', { hasText: 'Link from bin' }).click();
    await t.locator(`.pr-link-card[data-media-id="${blue}"]`).click();
    await t.locator('[data-testid="pr-link-done"]').click();

    // Open in the source monitor (switches to the Clips tab).
    await t.locator(`.pr-take[data-media-id="${blue}"] .pr-take-foot [title="Open in the source monitor"]`).click();
    await expect.poll(() => t.evaluate(() => window.__gis.uiStore.get().tab)).toBe('clips');
    await openPrompts(t);

    // Existing clip on the timeline, then assemble with "replace" and a dissolve.
    await t.evaluate((id) => window.__gis.projectStore.update((q) => window.__gis.model.appendMediaToTimeline(q, [id]).project, { label: 'x' }), red);
    await t.locator('[data-testid="pr-assemble"]').click();
    const dlg = t.locator('.pr-dialog', { hasText: 'Assemble the timeline' });
    await expect(dlg.locator('.pr-asm-row')).toHaveCount(2);
    await dlg.locator('.segmented button', { hasText: 'Replace timeline' }).click();
    await dlg.locator('select').selectOption('crossfade');
    await dlg.locator('[data-testid="pr-assemble-run"]').click();
    await expect(dlg).toBeHidden();
    p = await getProject(t);
    expect(p.tracks.video.map((c) => c.mediaId)).toEqual([green, blue]);
    expect(p.tracks.video[1].transition?.type).toBe('crossfade');
    await expect(t.locator('.toast', { hasText: 'Placed 2 clips' })).toBeVisible();
    // One undo step restores the previous timeline.
    await t.locator('.pr-list-head .panel-title').click();
    await t.keyboard.press('Control+z');
    await expect.poll(async () => (await getProject(t)).tracks.video.map((c) => c.mediaId)).toEqual([red]);
    expect(ownErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('queue: manual “Send next”, then an opt-in batch sends the remaining drafts in order (imagine page)', async () => {
  const ctx = await launch({ grok: { apiPosts: WITHOUT_GENERATED } });
  try {
    const page = await openGrok(ctx.page, '/imagine');
    const f = await studio(page);
    await openPrompts(f);
    await importText(f, '1. First shot prompt here\n2. Second shot prompt here\n3. Third shot prompt here');
    await f.locator('[data-testid="pr-paste-import"]').click();
    await expect(f.locator('.pr-card')).toHaveCount(3);

    await f.locator('[data-testid="pr-send-next"]').click();
    await expect.poll(() => page.evaluate(() => window.__mock.submitted)).toEqual(['First shot prompt here']);
    // The mock generates a clip for the submitted prompt: it is linked to shot 1 as a take.
    await expect.poll(async () => (await shots(f)).map((s) => s.status), { timeout: 20000 }).toEqual(['generated', 'draft', 'draft']);

    await f.locator('[data-testid="pr-batch"]').click();
    const dlg = f.locator('.pr-dialog', { hasText: 'Batch send to Grok' });
    await expect(dlg.locator('.pr-queue-warning')).toContainText('Automatic sending');
    await dlg.locator('.toggle', { hasText: 'Wait for each video' }).click();
    await expect(dlg.locator('.toggle', { hasText: 'Wait for each video' }).locator('input')).not.toBeChecked();
    // Note: after a send, grok.com's composer holds keyboard focus and headless Chrome routes CDP text input
    // (locator.fill) to it even when the extension iframe is clicked, so set the number via DOM events instead.
    const delay = dlg.locator('.pr-queue-field', { hasText: 'Pause between shots' }).locator('input');
    await setValue(delay, '0');
    await delay.evaluate((el) => el.dispatchEvent(new FocusEvent('blur'))); // NumberField commits on blur
    await expect.poll(() => f.evaluate(() => JSON.parse(localStorage.getItem('gis:prompts:prefs') || '{}').queueDelay)).toBe(0);
    await dlg.locator('[data-testid="pr-queue-start"]').click();
    await expect.poll(() => page.evaluate(() => window.__mock.submitted), { timeout: 20000 }).toEqual(['First shot prompt here', 'Second shot prompt here', 'Third shot prompt here']);
    await expect(dlg.locator('.pr-queue-run-head')).toContainText('Finished');
    await expect(dlg.locator('.pr-queue-item.is-done')).toHaveCount(2);
    expect((await shots(f)).map((s) => s.status)).toEqual(['generated', 'sent', 'sent']);
    expect(ownErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('take watcher: matching grok.com videos are offered (auto-link off) or linked automatically (standalone tab)', async () => {
  const ctx = await launch();
  try {
    const [RED, GREEN] = Object.keys(POSTS);
    const t = await openStudioTab(ctx);
    await openPrompts(t);
    await importText(t, '1. A red sports car drifting through neon rain, cinematic tracking shot\n2. A quiet harbor at dawn');
    await t.locator('[data-testid="pr-paste-import"]').click();
    await t.locator('.pr-takes-tools .toggle', { hasText: 'Auto-link' }).click(); // off
    await t.evaluate(async () => {
      const S = await import('/studio/prompts/shots.js');
      const p = window.__gis.projectStore.get();
      window.__gis.projectStore.update((q) => S.markShotSent(q, p.shots[0].id, { text: p.shots[0].prompt, at: Date.now() - 1000 }), { label: 'Send shot to Grok' });
    });
    await expect(t.locator('.pr-takes-empty')).toContainText('Waiting for Grok');
    // grok.com reports a new video whose (truncated) prompt matches shot 1, plus an older unrelated one.
    const item = (id, prompt, seenAt) => ({ key: `video:${id}`, kind: 'video', url: videoUrl(id), altUrls: [], thumbUrl: thumbUrl(id), postId: id, prompt, model: null, createdAt: null, width: 640, height: 360, duration: null, source: 'network', pageUrl: 'https://grok.com/imagine', seenAt });
    await t.evaluate((items) => window.__gis.pageStore.set((s) => ({ ...s, items })), [item(RED, 'A red sports car drifting through neon rain', Date.now()), item(GREEN, 'A misty green forest at dawn, slow dolly forward', Date.now())]);
    await expect(t.locator('.pr-offer')).toContainText('1 new video on grok.com matches this prompt');
    await expect(t.locator('.pr-card').first().locator('.pr-chip-mini.is-offer')).toHaveText('1 new');
    expect((await getProject(t)).mediaOrder).toEqual([]); // nothing imported until accepted
    await t.locator('.pr-offer .btn', { hasText: 'Link' }).click();
    await t.waitForFunction(() => {
      const p = window.__gis.projectStore.get();
      const s = p.shots[0];
      return s.takes.length === 1 && p.media[s.takes[0]]?.status === 'ready' && s.status === 'generated';
    }, null, POLL);
    await expect(t.locator('.pr-offer')).toHaveCount(0);
    let p = await getProject(t);
    expect(p.media[p.shots[0].takes[0]].pageKey).toBe(`video:${RED}`);
    expect(p.mediaOrder.length).toBe(1); // the unrelated video was not imported

    // Auto-link on: a matching Grok clip the user adds to the bin is linked automatically.
    await t.locator('.pr-takes-tools .toggle', { hasText: 'Auto-link' }).click();
    await t.evaluate(async (it) => window.__gis.media.importPageItems([it]), { ...item(GREEN, 'A red sports car drifting through neon rain, cinematic tracking shot, take two', Date.now()), key: 'video:take-two' });
    await expect.poll(async () => (await shots(t))[0].takes.length, POLL).toBe(2);
    await expect(t.locator('.toast', { hasText: 'Linked 1 new take to shot 1' })).toBeVisible();
    p = await getProject(t);
    expect(p.shots[1].takes).toEqual([]);
    expect(ownErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('narrow 480 px layout: pane switcher, editor back button, library pane, no horizontal overflow', async () => {
  const ctx = await launch({ viewport: { width: 480, height: 860 } });
  try {
    const t = await openStudioTab(ctx);
    await openPrompts(t);
    await expect(t.locator('.pr-root')).toHaveClass(/is-narrow/);
    await expect(t.locator('.pr-nav')).toBeVisible();
    await expect(t.locator('.pr-col-list .empty-title')).toHaveText('Plan your sequence shot by shot');
    await t.locator('[data-testid="pr-new-shot"]').click();
    await expect(t.locator('.pr-root')).toHaveClass(/pane-editor/);
    await expect(t.locator('#pr-prompt-input')).toBeVisible();
    await t.locator('#pr-prompt-input').fill('A lighthouse in a storm, waves exploding against the rocks');
    await t.locator('.pr-ed-nav [title="Back to the shot list"]').click();
    await expect(t.locator('.pr-root')).toHaveClass(/pane-list/);
    await expect(t.locator('.pr-card')).toContainText('A lighthouse in a storm');
    await t.locator('.pr-nav button', { hasText: 'Library' }).click();
    await expect(t.locator('.pr-col-lib')).toBeVisible();
    await expect(t.locator('.pr-lib-tabs .tab')).toHaveCount(4);
    for (const label of [/^Shots/, /^Editor$/, /^Library$/]) {
      await t.locator('.pr-nav button', { hasText: label }).click();
      const overflow = await t.evaluate(() => {
        const r = document.querySelector('.pr-root');
        const widest = Math.max(...[...r.querySelectorAll('*')].filter((el) => el.offsetParent).map((el) => el.getBoundingClientRect().right));
        return { scroll: r.scrollWidth - r.clientWidth, widest: Math.round(widest), width: r.clientWidth };
      });
      expect(overflow.scroll).toBeLessThanOrEqual(0);
      expect(overflow.widest).toBeLessThanOrEqual(overflow.width + 1);
    }
    expect(ownErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});
