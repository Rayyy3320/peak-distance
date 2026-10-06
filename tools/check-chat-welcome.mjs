// Built extension: typing/deletion, caret, stable layout and reduced motion.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';

const profile = mkdtempSync(join(tmpdir(), 'pd-welcome-'));
const output = resolve('.upstream/chat-welcome');
mkdirSync(output, { recursive: true });
const extension = resolve('.output/chrome-mv3');
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.BLC_CHROME || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
  reducedMotion: 'no-preference',
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__heldChatReads = [];
    window.__holdChatReads = true;
    chrome.runtime.sendMessage = (message, ...args) => {
      if (message?.type === 'chatActive' && window.__holdChatReads) {
        window.__heldChatReads.push(() => send(message, ...args));
        return;
      }
      return send(message, ...args);
    };
  });
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html#chat`);
  const title = page.getByRole('heading', { name: '从一句话，读懂更多。', exact: true });
  await title.waitFor();
  await page.waitForFunction(() => window.__heldChatReads.length > 0);
  // A visibility round trip while boot awaits chat restoration must not freeze the visible title.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
    window.__holdChatReads = false;
    window.__heldChatReads.splice(0).forEach(release => release());
  });
  await page.waitForFunction(() => !document.body.inert);
  assert.equal(await page.locator('.chat-welcome-text').evaluate(element => getComputedStyle(element).animationPlayState), 'running', 'Visible title must animate after visibility changes during boot');
  assert.equal(await page.locator('.chat-welcome p').count(), 0);
  const natural = await page.evaluate(async () => {
    const samples = [];
    for (let i = 0; i < 30; i++) {
      const text = document.querySelector('.chat-welcome-text');
      samples.push({ clip: getComputedStyle(text).clipPath, time: text.getAnimations()[0]?.currentTime,
        state: getComputedStyle(text).animationPlayState });
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return samples;
  });
  assert.ok(natural.some(sample => sample.clip === 'inset(0px)'));
  assert.ok(natural.at(-1).time > 6500);
  assert.ok(natural.every(sample => sample.state === 'running'));
  assert.ok(natural.some(sample => sample.time > 6500 && sample.clip === 'inset(0px)'));
  console.log('PASS visibility round trip during boot; uninterrupted natural typing/deletion/retyping cycle');
  await page.waitForFunction(() => {
    const text = document.querySelector('.chat-welcome-text');
    return text?.getAnimations()[0]?.currentTime > 350;
  });

  // Seek the real CSS animations to inspect both directions without flaky sleeps.
  const sample = time => title.evaluate((element, time) => {
    for (const animation of element.getAnimations({ subtree: true })) {
      animation.pause(); animation.currentTime = time;
    }
    const text = element.querySelector('.chat-welcome-text');
    const prefix = element.querySelector('.chat-welcome-prefix');
    if (prefix.textContent !== '从一句话，' || getComputedStyle(prefix).clipPath !== 'none' || prefix.getAnimations().length) throw new Error('Welcome prefix must remain static');
    const copy = element.querySelector('.chat-welcome-copy');
    const caret = getComputedStyle(copy, '::after');
    return { clip: getComputedStyle(text).clipPath, caret: caret.transform, opacity: caret.opacity,
      bounds: [element.getBoundingClientRect().x, element.getBoundingClientRect().width],
      mark: element.querySelector('img').getBoundingClientRect().x };
  }, time);
  for (const width of [320, 762, 1200]) {
    await page.setViewportSize({ width, height: 700 });
    const empty = await sample(0);
    const typing = await sample(960);
    const full = await sample(2000);
    const deleting = await sample(4590);
    const end = await sample(5100);
    assert.equal(empty.clip, 'inset(0px 100% 0px 0px)');
    assert.equal(typing.clip, 'inset(0px 60% 0px 0px)');
    assert.equal(full.clip, 'inset(0px)');
    assert.equal(deleting.clip, typing.clip);
    assert.equal(deleting.caret, typing.caret);
    assert.equal(end.clip, empty.clip);
    for (const state of [typing, full, deleting, end]) {
      assert.deepEqual(state.bounds, empty.bounds);
      assert.equal(state.mark, empty.mark);
    }
    assert.ok(empty.bounds[0] >= 0 && empty.bounds[0] + empty.bounds[1] <= width);
    assert.equal((await sample(200)).opacity, '1');
    assert.equal((await sample(600)).opacity, '0');
    await sample(2000);
    await page.screenshot({ path: join(output, `full-${width}.png`) });
    console.log(`PASS ${width}px: typing, deletion, blinking and stable layout`);
  }
  await sample(960);
  await page.screenshot({ path: join(output, 'typing.png') });
  await title.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => animation.play()));
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await page.locator('.chat-welcome-text').evaluate(element => getComputedStyle(element).animationPlayState), 'paused');
  await page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await page.locator('.chat-welcome-text').evaluate(element => getComputedStyle(element).animationPlayState), 'running');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await title.evaluate(element => element.getAnimations({ subtree: true }).length), 0);
  assert.equal(await page.locator('.chat-welcome-text').evaluate(element => getComputedStyle(element).clipPath), 'none');
  assert.equal(await page.locator('.chat-welcome-copy').evaluate(element => getComputedStyle(element, '::after').content), 'none');
  assert.deepEqual(errors, []);
  console.log('PASS hidden panel pauses/resumes; reduced motion shows static accessible text; no script errors');
} finally {
  await context.close();
  const target = resolve(profile);
  assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('pd-welcome-'));
  rmSync(target, { recursive: true, force: true });
}
