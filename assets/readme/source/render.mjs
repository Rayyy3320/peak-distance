// Run from any directory: node assets/readme/source/render.mjs
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const targets = [
  ['hero-layout.svg', 'hero.png'],
  ['hero-en-layout.svg', 'hero-en.png'],
];

const browser = await chromium.launch({
  executablePath: process.env.BLC_CHROME || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
});
try {
  for (const [svg, out] of targets) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 520 }, deviceScaleFactor: 2 });
    await page.goto(new URL(`./${svg}`, import.meta.url).href);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: fileURLToPath(new URL(`../${out}`, import.meta.url)) });
    await page.close();
  }
} finally {
  await browser.close();
}
