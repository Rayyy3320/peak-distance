// M11 C 阶段纵向链路检查（真实扩展 + 真实消息，Edge 自动化）：
//   1. 页面把 OPFS 真实目录句柄写入 vault store → vaultConnect（首次导入/身份）
//   2. save 语言词条（ja）→ 自动排队写入学库 → 词汇/ja/*.md 出现且内容正确
//   3. 模拟 Obsidian 外部编辑（改 status + 添加“我的笔记”）→ vaultSync →
//      本地词条状态与笔记更新（不同字段合并，V2）
//   4. 本地改状态 + 外部再改同一状态 → vaultSync → 冲突保留双方、本地不丢（V3 部分）
//   5. vaultDisconnect → 文件保留、状态未连接；重连（vaultConnect）不重复导入
// 真实目录授权与跨浏览器并发为第二层（需用户），此处 OPFS 即真实目录句柄接口。
// 运行：node tools/m11-vault-e2e.mjs
import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import assert from 'node:assert/strict';

const profile = mkdtempSync(join(tmpdir(), 'pd-m11-e2e-'));
const extension = resolve('.output/chrome-mv3');
const output = resolve('.upstream/m11-vault');
mkdirSync(output, { recursive: true });
const results = [];
const check = (name, value, detail = '') => {
  results.push({ name, ok: !!value });
  console.log(`${value ? 'PASS' : 'FAIL'} ${name}${!value && detail ? ' — ' + detail : ''}`);
};
const call = (fnSource, ...args) =>
  `(${fnSource})(${args.map((a) => JSON.stringify(a)).join(',')})`;

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    '--no-first-run',
  ],
  viewport: { width: 1280, height: 900 },
});
ctx.setDefaultTimeout(20000);
try {
  // 唤醒 SW
  let worker = ctx.serviceWorkers()[0];
  const wake = await ctx.newPage();
  await wake.goto('about:blank');
  {
    const cdp = await ctx.newCDPSession(wake);
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
    const id = sw ? new URL(sw.url).host : null;
    if (id) {
      await wake.goto(`chrome-extension://${id}/options.html`);
      await wake.evaluate((m) => chrome.runtime.sendMessage(m), { type: 'vaultStatus' }).catch(() => {});
    }
    for (let i = 0; i < 5 && !worker; i++) {
      worker = ctx.serviceWorkers()[0];
      if (!worker) await wake.waitForTimeout(1000);
    }
  }
  const id = new URL(worker.url()).host;
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  const send = (m) => page.evaluate((msg) => chrome.runtime.sendMessage(msg), m);

  // 1. 句柄入库 + 连接
  const PAGE_SETUP = `async () => {
    const dir = await navigator.storage.getDirectory();
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('blc-learning', 5);
      r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('vault')) d.createObjectStore('vault'); if (!d.objectStoreNames.contains('vaultQueue')) d.createObjectStore('vaultQueue', { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => { const tx = db.transaction('vault', 'readwrite'); tx.objectStore('vault').put(dir, 'handle'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close(); return true;
  }`;
  check('页面句柄写入 vault store', await page.evaluate(call(PAGE_SETUP)));
  const conn = await send({ type: 'vaultConnect' });
  check('vaultConnect 成功并建立库身份', conn?.ok && conn?.vault?.vaultId, JSON.stringify(conn).slice(0, 120));

  // 2. 保存 ja 词条 → 自动写库
  const save = await send({
    type: 'save',
    snapshot: {
      source: 'web', expression: '学ぶ', sentence: '私は日本語を学ぶ。',
      url: 'https://example.com/ja', title: 'Japanese page', lang: 'ja',
    },
  });
  check('语言词条保存成功', save?.ok && save?.key === 'ja::学ぶ', JSON.stringify(save));
  // 等待异步排队提交完成
  let committed = false;
  for (let i = 0; i < 20; i++) {
    const st = await send({ type: 'vaultStatus' });
    if (st?.ok && st.status.pendingCount === 0 && st.status.lastCommitAt) { committed = true; break; }
    await page.waitForTimeout(300);
  }
  check('保存自动写入学习库（队列清空）', committed);

  const READ_VOCAB_FILE = `async () => {
    const dir = await navigator.storage.getDirectory();
    const handle = await dir.getFileHandle('生词本.md');
    return { name: '生词本.md', text: await (await handle.getFile()).text() };
  }`;
  const file1 = await page.evaluate(call(READ_VOCAB_FILE));
  check('词汇追加到 生词本.md 并含受管字段', !!file1 && file1.text.includes('language: ja') && file1.text.includes('expression: 学ぶ') && file1.text.includes('原句'), file1?.name);
  writeFileSync(join(output, 'e2e-file-after-save.md'), file1?.text ?? '');

  const video = { videoId: 'abcdefghijk', trackId: 'en-track', trackKind: 'manual', trackLang: 'en', startMs: 1000 };
  const sentenceSave = await send({ type: 'saveSentence', sentence: { video, language: 'en', text: 'A senior engineer.', zh: '资深工程师。', endMs: 3500, title: 'Video fixture' } });
  check('视频句子保存成功', sentenceSave?.ok);
  await send({ type: 'vaultFlush' });
  await page.evaluate(async () => {
    const request = indexedDB.open('blc-learning', 5);
    const db = await new Promise((done, fail) => { request.onsuccess = () => done(request.result); request.onerror = () => fail(request.error); });
    await new Promise((done, fail) => { const tx = db.transaction('sentences', 'readwrite'); tx.objectStore('sentences').clear(); tx.oncomplete = done; tx.onerror = () => fail(tx.error); });
    db.close();
  });
  await page.locator('#vault-flush').click();
  await page.waitForFunction(() => document.querySelector('#vault-state').textContent.includes('同步完成'));
  const restored = await send({ type: 'listSentences' });
  check('设置页立即同步读回句子与完整视频位置', restored?.sentences?.[0]?.video?.startMs === 1000 && restored.sentences[0].endMs === 3500 && restored.sentences[0].zh === '资深工程师。', JSON.stringify(restored));
  for (const width of [320, 1200]) {
    await page.setViewportSize({ width, height: 900 });
    check(`学习库设置 ${width}px 无横向溢出`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.locator('#vault-flush').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(output, `vault-settings-${width}.png`) });
  }
  await page.evaluate(() => {
    window.__queryPermission = FileSystemDirectoryHandle.prototype.queryPermission;
    window.__requestPermission = FileSystemDirectoryHandle.prototype.requestPermission;
    FileSystemDirectoryHandle.prototype.queryPermission = async () => 'denied';
    FileSystemDirectoryHandle.prototype.requestPermission = async () => 'denied';
  });
  await page.locator('#vault-flush').click();
  await page.waitForFunction(() => document.querySelector('#vault-state').textContent.includes('未获得文件夹读写权限'));
  check('权限未获得时设置页明确提示，按钮恢复可重试', await page.locator('#vault-flush').isEnabled());
  await page.evaluate(() => {
    FileSystemDirectoryHandle.prototype.queryPermission = window.__queryPermission;
    FileSystemDirectoryHandle.prototype.requestPermission = window.__requestPermission;
  });
  const intactBook = await page.evaluate(async () => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('生词本.md');
    const text = await (await handle.getFile()).text();
    const writable = await handle.createWritable(); await writable.write(text.replaceAll('<!-- peak-distance:vocab -->', '')); await writable.close();
    return text;
  });
  await page.locator('#vault-flush').click();
  await page.waitForFunction(() => document.querySelector('#vault-state').textContent.includes('学习文档格式有误'));
  check('格式损坏如实报错且本机词条不被清空', !!(await send({ type: 'getEntry', key: 'ja::学ぶ' }))?.entry);
  await page.evaluate(async text => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('生词本.md');
    const writable = await handle.createWritable(); await writable.write(text); await writable.close();
  }, intactBook);

  // 3. 外部编辑：status → learning + 我的笔记（不同字段，应自动合并）
  const EDIT_EXTERNAL = `async (mode) => {
    const dir = await navigator.storage.getDirectory();
    const handle = await dir.getFileHandle('生词本.md');
    const text = await (await handle.getFile()).text();
    const next = mode === 'note-learning'
      ? text.replace('status: saved', 'status: learning').replace('### 我的笔记', '### 我的笔记\\n复习时结合原句记忆。')
      : text.replace('status: learning', 'status: saved');
    const writable = await handle.createWritable(); await writable.write(next); await writable.close();
    return next;
  }`;
  const external1 = await page.evaluate(call(EDIT_EXTERNAL, 'note-learning'));
  check('外部编辑写入文件（Obsidian 模拟）', !!external1 && external1.includes('status: learning') && external1.includes('复习时结合原句记忆'), String(external1).slice(0, 80));
  const sync1 = await send({ type: 'vaultSync' });
  check('vaultSync 读回成功', sync1?.ok && sync1.updated >= 1, JSON.stringify(sync1));
  const entry1 = await send({ type: 'getEntry', key: 'ja::学ぶ' });
  check('外部状态与笔记合并进本地（不同字段合并）', entry1?.entry?.status === 'learning' && /复习时结合原句记忆/.test(entry1?.entry?.note ?? ''), JSON.stringify(entry1?.entry?.status) + ' note=' + JSON.stringify(entry1?.entry?.note ?? null).slice(0, 40));

  // 4. 冲突：外部先改 saved（相对 base），本地再改 known（同一字段双方不同改）
  const external2 = await page.evaluate(call(EDIT_EXTERNAL, 'saved'));
  check('外部同字段改 saved', !!external2 && external2.includes('status: saved'));
  const setStatus = await send({ type: 'setStatus', key: 'ja::学ぶ', status: 'known' });
  check('本地状态改 known', setStatus?.ok);
  // 等待本地写库尝试完成：写前检查应发现外部改动并拒绝覆盖（待办保留）
  let conflictQueued = false;
  for (let i = 0; i < 20; i++) {
    const st = await send({ type: 'vaultStatus' });
    if (st?.ok && st.status.lastError === 'conflict') { conflictQueued = true; break; }
    await page.waitForTimeout(300);
  }
  check('写前检查发现外部改动且未覆盖（待办保留）', conflictQueued);
  const sync2 = await send({ type: 'vaultSync' });
  check('同步报告冲突且不丢本地', sync2?.ok === false && sync2.error === 'conflict' && sync2.conflicts >= 1, JSON.stringify(sync2));
  const entry2 = await send({ type: 'getEntry', key: 'ja::学ぶ' });
  check('冲突时本地版本保留（known 不被覆盖）', entry2?.entry?.status === 'known', entry2?.entry?.status);
  const conflictRaw = await page.evaluate(`(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('blc-learning', 5); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const v = await new Promise((res, rej) => { const tx = db.transaction('vault', 'readonly'); const q = tx.objectStore('vault').get('conflict:ja::学ぶ'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); db.close();
    return v ? JSON.stringify(v).slice(0, 160) : null;
  })()`);
  check('冲突详情已记录（双方数据完整保留）', !!conflictRaw && conflictRaw.includes('status'), String(conflictRaw).slice(0, 80));

  // 5. 断开：文件保留、状态未连接；重连不重复导入
  const dis = await send({ type: 'vaultDisconnect' });
  const st1 = await send({ type: 'vaultStatus' });
  const FILE_STILL_THERE = `(async () => {
    const dir = await navigator.storage.getDirectory();
    return (await (await dir.getFileHandle('生词本.md')).getFile()).text().then(text => text.includes('ja::学ぶ'));
  })()`;
  check('断开后状态未连接且文件仍在磁盘', dis?.ok && st1?.ok && st1.status.connected === false && !!(await page.evaluate(FILE_STILL_THERE)));
  // 重连：模拟页面再次选择同一目录（句柄重新写入）
  await page.evaluate(call(PAGE_SETUP));
  const reconn = await send({ type: 'vaultConnect' });
  check('重连成功且不重复导入（幂等）', reconn?.ok && reconn.imported === false, JSON.stringify(reconn).slice(0, 100));

  writeFileSync(join(output, 'vault-e2e-results.json'), JSON.stringify({ results }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  assert.ok(failed.length === 0);
} finally {
  await ctx.close().catch(() => {});
  assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep) && profile.includes('pd-m11-e2e-'));
  rmSync(profile, { recursive: true, force: true });
}
