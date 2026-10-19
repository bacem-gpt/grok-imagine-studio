// Several studio windows at once (overlay in two grok.com tabs + a standalone tab) must never lose each other's work.
import { test } from '@playwright/test';
import { launch, openGrok, openStudio, openStudioTab, seedMedia, getProject, expect } from './harness.mjs';

test('two grok tabs + a standalone tab share one project and merge concurrent additions', async () => {
  const ctx = await launch();
  try {
    const pageA = await openGrok(ctx.page, '/imagine');
    const studioA = await openStudio(pageA);
    const pageB = await openGrok(await ctx.context.newPage(), '/imagine');
    const studioB = await openStudio(pageB);
    const idA = (await getProject(studioA)).id;
    expect((await getProject(studioB)).id).toBe(idA);

    // Concurrent edits in both windows.
    const [redIds, greenIds] = await Promise.all([seedMedia(studioA, ['clip-red.mp4']), seedMedia(studioB, ['clip-green.mp4'])]);
    await studioA.evaluate(() => window.__gis.projectStore.update((p) => window.__gis.model.renameProject(p, 'Renamed in A')));
    await studioB.evaluate((id) => window.__gis.projectStore.update((p) => window.__gis.model.appendMediaToTimeline(p, [id]).project), greenIds[0]);

    const has = (target, ids) =>
      target.waitForFunction((want) => want.every((id) => !!window.__gis.projectStore.get().media[id]), ids, { timeout: 15000 });
    await has(studioA, [...redIds, ...greenIds]);
    await has(studioB, [...redIds, ...greenIds]);
    await studioB.waitForFunction(() => window.__gis.projectStore.get().name === 'Renamed in A', null, { timeout: 15000 });
    await studioA.waitForFunction(() => window.__gis.projectStore.get().tracks.video.length === 1, null, { timeout: 15000 });

    // What is stored has everything too (after both windows' debounced saves).
    await studioA.waitForTimeout(1200);
    const stored = await studioA.evaluate(async (id) => window.__gis.db.getProject(id), idA);
    expect(Object.keys(stored.media)).toEqual(expect.arrayContaining([...redIds, ...greenIds]));
    expect(stored.name).toBe('Renamed in A');
    expect(stored.tracks.video.length).toBe(1);

    // A standalone studio tab (different top-level page) sees the same data.
    const standalone = await openStudioTab(ctx);
    await standalone.waitForFunction((want) => want.every((id) => !!window.__gis.projectStore.get().media[id]), [...redIds, ...greenIds], { timeout: 15000 });

    // Library merges too: snippets added in two windows both survive.
    await studioA.evaluate(() => window.__gis.libraryStore.set((s) => ({ ...s, snippets: [...s.snippets, { id: 'snA', title: 'A', text: 'from A', tags: [] }] })));
    await studioB.evaluate(() => window.__gis.libraryStore.set((s) => ({ ...s, snippets: [...s.snippets, { id: 'snB', title: 'B', text: 'from B', tags: [] }] })));
    for (const target of [studioA, studioB, standalone]) {
      await target.waitForFunction(() => ['snA', 'snB'].every((id) => window.__gis.libraryStore.get().snippets.some((s) => s.id === id)), null, { timeout: 15000 });
    }
  } finally {
    await ctx.close();
  }
});
