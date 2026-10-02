// Run from any directory: node assets/readme/source/render.mjs
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const browser = await chromium.launch({
  executablePath: process.env.BLC_CHROME || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 520 }, deviceScaleFactor: 2 });
  await page.goto(new URL('./hero-layout.svg', import.meta.url).href);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: fileURLToPath(new URL('../hero.png', import.meta.url)) });
} finally {
  await browser.close();
}
