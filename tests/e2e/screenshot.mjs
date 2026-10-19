// Visual check helper: node tests/e2e/screenshot.mjs [out.png] [--tab=edit] [--dock=max] [--standalone] [--width=1440] [--height=900]
// Opens mock grok.com, opens the studio (or the standalone tab) and saves a screenshot.
import { launch, openGrok, openStudio, openStudioTab, setDockMode } from './harness.mjs';

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const out = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'screenshot.png';
const ctx = await launch({ viewport: { width: Number(args.width || 1440), height: Number(args.height || 900) } });
try {
  let target;
  if (args.standalone) {
    target = await openStudioTab(ctx);
  } else {
    const page = await openGrok(ctx.page, args.path || '/imagine');
    const frame = await openStudio(page);
    if (args.dock) await setDockMode(frame, args.dock);
    target = frame;
    if (args.tab) await frame.locator('.app-tabs .tab', { hasText: new RegExp(args.tab, 'i') }).click();
    await page.waitForTimeout(Number(args.wait || 800));
    await page.screenshot({ path: out });
  }
  if (args.standalone) {
    if (args.tab) await target.locator('.app-tabs .tab', { hasText: new RegExp(args.tab, 'i') }).click();
    await target.waitForTimeout(Number(args.wait || 800));
    await target.screenshot({ path: out });
  }
  if (ctx.consoleErrors.length) console.log('console errors:\n' + ctx.consoleErrors.join('\n'));
  console.log('saved', out);
} finally {
  await ctx.close();
}
