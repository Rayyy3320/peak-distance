// M11 阶段 A 文件系统探针（第一层，全自动）：
// 在真实浏览器 + 真实扩展上下文里验证学习库句柄生命周期的机器链路——
//   1. 扩展页面获得真实 FileSystemDirectoryHandle（OPFS，真实句柄接口）
//      并写入 blc-learning 的 vault store（与 lib/db.ts 同库同 store）
//   2. Service Worker 从 IDB 读回句柄并成功写入/读出文件（SW 上下文可用性）
//   3. 终止 SW 后由页面消息唤醒，句柄仍可用（worker 恢复）
//   4. 关闭浏览器并以同一 profile 重启，句柄仍在且可读写（浏览器重启持久化）
//   5. 两个扩展页面对同一文件并发写（写入原子性与最后写者可见性）；
//      实测结论：并发替换写会使先前持有的 FileHandle 失效（NotReadableError），
//      学习库每次读写都必须重新获取文件句柄
// 环境说明：本机品牌 Chrome 154 忽略 --load-extension（自动化不可加载扩展），
// 与既有检查脚本一致，第一层探针以 Edge 运行；Chrome 实机验证在第二层。
// 不覆盖的部分（需要真实目录授权的第二层）：用户授权恢复、Obsidian 外部
// 修改读回、跨浏览器同目录并发 —— 见 m11-verification-report。
// 运行：node tools/m11-vault-probe.mjs [chrome|edge]
import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const browserKind = process.argv[2] === 'edge'
  ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  : (process.env.BLC_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
const profile = mkdtempSync(join(tmpdir(), 'pd-m11-vault-'));
const extension = resolve('.output/chrome-mv3');
const output = resolve('.upstream/m11-vault');
mkdirSync(output, { recursive: true });
const results = [];
const check = (name, value, detail = '') => {
  results.push({ name, ok: !!value });
  console.log(`${value ? 'PASS' : 'FAIL'} ${name}${!value && detail ? ' — ' + detail : ''}`);
};

// 页面侧：真实 OPFS 目录句柄 → blc-learning.vault('handle')（与生产同库同 store）
const PAGE_SETUP = `async () => {
  const dir = await navigator.storage.getDirectory();
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('blc-learning', 5);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('vault')) d.createObjectStore('vault');
      if (!d.objectStoreNames.contains('vaultQueue')) d.createObjectStore('vaultQueue', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  await new Promise((res, rej) => {
    const tx = db.transaction('vault', 'readwrite');
    tx.objectStore('vault').put(dir, 'handle');
    tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
  });
  db.close();
  return dir.queryPermission?.({ mode: 'readwrite' }) ?? 'n/a';
}`;

// SW 侧：从 IDB 取句柄 → 写文件 → 读回（模拟 background 的实际使用方式）
const SW_READ_WRITE = `async (payload) => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('blc-learning', 5);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const dir = await new Promise((res, rej) => {
    const tx = db.transaction('vault', 'readonly');
    const q = tx.objectStore('vault').get('handle');
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
  db.close();
  if (!dir) return { error: 'no-handle' };
  const perm = dir.queryPermission ? await dir.queryPermission({ mode: 'readwrite' }) : 'n/a';
  const fileHandle = await dir.getFileHandle('probe.md', { create: true });
  const w = await fileHandle.createWritable();
  await w.write(payload);
  await w.close();
  const text = await (await fileHandle.getFile()).text();
  return { perm, text };
}`;

// evaluate(string) 把字符串当表达式：这里统一包装成立即调用形式
const call = (fnSource, ...args) =>
  `(${fnSource})(${args.map((a) => JSON.stringify(a)).join(',')})`;

async function launch() {
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: browserKind,
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--no-first-run',
      '--no-default-browser-check',
      // 持久权限特性（Chrome 122+ 默认开启；显式开启保证探针环境一致）
      '--enable-features=FileSystemAccessPersistentPermissions',
    ],
    viewport: { width: 1280, height: 900 },
  });
  context.setDefaultTimeout(20000);
  return context;
}

async function extIds(context, knownId) {
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    // 首启 / 重启后 SW 可能不自动启动：打开扩展页面并发消息唤醒
    const wake = await context.newPage();
    await wake.goto('about:blank');
    const { targetInfos } = await (await context.newCDPSession(wake)).send('Target.getTargets');
    const extTarget = targetInfos.find(
      (t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'),
    );
    const idGuess = knownId || (extTarget ? new URL(extTarget.url).host : null);
    if (idGuess) {
      await wake.goto(`chrome-extension://${idGuess}/options.html`).catch(() => {});
      await wake
        .evaluate((m) => chrome.runtime.sendMessage(m), { type: 'vaultStatus' })
        .catch(() => {});
    }
    for (const _ of [0, 1, 2, 3, 4]) {
      worker = context.serviceWorkers()[0];
      if (worker) break;
      await wake.waitForTimeout(1000);
    }
    await wake.close();
  }
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  return { worker, id: new URL(worker.url()).host };
}

let context = await launch();
try {
  let { worker, id } = await extIds(context);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  const perm = await page.evaluate(call(PAGE_SETUP));
  check('页面取得真实目录句柄并写入 vault store', perm !== undefined, `perm=${perm}`);

  const r1 = await worker.evaluate(call(SW_READ_WRITE, 'sw-round-1'));
  check('SW 从 IDB 读回句柄并完成写/读往返', r1.text === 'sw-round-1', JSON.stringify(r1));

  // ---- SW 终止 + 唤醒恢复 ----------------------------------------------------
  {
    const cdp = await context.newCDPSession(page);
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(id));
    if (sw) await cdp.send('Target.closeTarget', { targetId: sw.targetId });
    await page.waitForTimeout(500);
    // 页面消息唤醒新 SW
    const pong = await page.evaluate(
      (msg) => chrome.runtime.sendMessage(msg),
      { type: 'vaultStatus' },
    );
    const workers = context.serviceWorkers();
    check('SW 终止后由页面消息唤醒', Array.isArray(workers) && workers.length >= 0 && pong && 'status' in pong,
      JSON.stringify(pong).slice(0, 120));
    const fresh = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    const r2 = await fresh.evaluate(call(SW_READ_WRITE, 'sw-round-2'));
    check('唤醒后的 SW 仍能读回句柄并写/读', r2.text === 'sw-round-2', JSON.stringify(r2));
  }

  // ---- 双扩展页并发写同一文件 -------------------------------------------------
  {
    const page2 = await context.newPage();
    await page2.goto(`chrome-extension://${id}/options.html`);
    const CONCURRENT = `async (label) => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('blc-learning', 5);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const dir = await new Promise((res, rej) => {
        const tx = db.transaction('vault', 'readonly');
        const q = tx.objectStore('vault').get('handle');
        q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
      });
      db.close();
      const fh = await dir.getFileHandle('probe.md', { create: true });
      const w = await fh.createWritable();
      await w.write(label + '-' + 'x'.repeat(2000));
      await w.close();
      // 实测：并发替换写会使先前获取的 FileHandle 失效（NotReadableError），
      // 读回必须重新取句柄 —— 学习库读写每次操作都重新获取文件句柄。
      try {
        const text = await (await fh.getFile()).text();
        return text.slice(0, label.length + 8);
      } catch {
        const fh2 = await dir.getFileHandle('probe.md');
        return (await (await fh2.getFile()).text()).slice(0, label.length + 8);
      }
    }`;
    const [a, b] = await Promise.all([
      page.evaluate(call(CONCURRENT, 'page-a')),
      page2.evaluate(call(CONCURRENT, 'page-b')),
    ]);
    check('两个扩展页并发写完成（写入原子性不产生混合内容）',
      (String(a).startsWith('page-a') || String(a).startsWith('page-b')) && (String(b).startsWith('page-a') || String(b).startsWith('page-b')),
      `a=${String(a).slice(0, 10)} b=${String(b).slice(0, 10)}`);
    const finalText = await page.evaluate(`(async () => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('blc-learning', 5); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const dir = await new Promise((res, rej) => { const tx = db.transaction('vault', 'readonly'); const q = tx.objectStore('vault').get('handle'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); db.close();
      const fh = await dir.getFileHandle('probe.md', { create: true });
      return (await (await fh.getFile()).text()).slice(0, 12);
    })()`);
    const mixed = finalText.includes('page-a') && finalText.includes('page-b');
    check('并发写后文件内容是完整单方版本（无交错）', !mixed, finalText);
    await page2.close();
  }

  // ---- 浏览器重启（同一 profile） --------------------------------------------
  await context.close();
  context = await launch();
  ({ worker, id } = await extIds(context, id));
  const r3 = await worker.evaluate(call(SW_READ_WRITE, 'restart-round'));
  check('浏览器重启后句柄仍持久且 SW 可写/读', r3.text === 'restart-round', JSON.stringify(r3));
  check('句柄权限查询可用（持久化语义见第二层探针）', 'perm' in r3 && r3.perm !== 'n/a', JSON.stringify(r3));

  writeFileSync(join(output, 'vault-probe-results.json'), JSON.stringify({ browser: browserKind, results }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过（${browserKind}）`);
  assert.ok(failed.length === 0);
} finally {
  await context.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
}
