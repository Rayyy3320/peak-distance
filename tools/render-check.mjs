import { renderM6 } from './render-m6.mjs';
// 最小可重复渲染检查（spec §5：扩展现有检查，不新建测试平台）。
// 用 playwright-core + 本机 Chrome 无头实例注入【构建产物】content script：
//   A. 网页：选区 → 查词入口 → 弹窗（置顶 / 拖动 / 无 key / 保存反馈），
//      加上 M3 标记（词边界 / 状态样式 / 词形 / 短语最长优先 / 开关拆除）。
//   B. YouTube 模拟页：字幕栏随 currentTime 定位、ASR 合并、中文预取对齐、
//      徽标默认隐藏、点击查词暂停 / 关闭恢复、拖选短语、双语开关、
//      非英文轨道丢弃。
// 不连 DeepSeek、不碰用户浏览器；runtime 消息以 stub 应答。
// 用法：node tools/render-check.mjs（需先 npm run build）

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const webScript = readFileSync(
  join(here, '..', '.output', 'chrome-mv3', 'content-scripts', 'web.js'),
  'utf8',
);
const ytScript = readFileSync(
  join(here, '..', '.output', 'chrome-mv3', 'content-scripts', 'youtube.js'),
  'utf8',
);
const shotDir = join(here, '..', '.upstream');

const CHROME =
  process.env.BLC_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ---- 本地 HTTP 服务：YouTube 模拟页需要 ?v= 形式的地址 ------------------------

const ytHtml = `<!doctype html><html><head><title>Render Check Video</title></head>
<body style="margin:0;text-shadow:0 0 2px #000,0 1px 2px #000;font-weight:bold">
<div id="movie_player" style="position:relative;width:640px;height:360px;background:#111">
  <video></video>
  <button class="ytp-subtitles-button" aria-pressed="false" onclick="this.setAttribute('aria-pressed', String(this.getAttribute('aria-pressed') !== 'true'))">CC</button>
</div>
</body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(ytHtml);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ytPort = server.address().port;

// 页面侧可复用的 runtime stub 安装器
function installStub() {
  window.__saved = [];
  window.__lookups = [];
  window.__chat = [];
  window.__listeners = [];
  window.__marking = true;
  window.__items = [];
  window.browser = {
    runtime: {
      id: 'render-check',
      getURL: () => 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
      sendMessage: (msg, cb) => {
        if (msg.type === 'lookup') {
          window.__lookups.push(msg);
          cb({ ok: true, result: { kind: 'dictionary', entry: { source: 'youdao', expression: msg.snapshot.expression, headword: msg.snapshot.expression, url: 'https://dict.youdao.com/', senses: [{ definition: '去；离开' }], forms: ['go'] } } });
        } else if (msg.type === 'subtitleMode') { window.__videoSession = { mode:'regular', autoPause:false, ...window.__videoSession, ...msg }; cb({ ok:true, ...window.__videoSession }); }
        else if (msg.type === 'listSentences') cb({ ok:true, sentences:[] });
        else if (msg.type === 'listEntries') cb({ ok:true, entries:[] });
        else if (msg.type === 'getEntry') cb({ ok: true, entry: null });
        else if (msg.type === 'save') {
          window.__saved.push(msg);
          cb({ ok: true, status: 'saved', contextId: 1, appended: true, key: 'x' });
        } else if (msg.type === 'chatEnsure') {
          window.__chat.push(msg);
          cb({ ok: true, chat: null, panelOpened: true });
        } else if (msg.type === 'vocabIndex') {
          cb({ ok: true, items: window.__items });
        } else if (msg.type === 'getSettings') {
          cb({ ok: true, settings: { markingEnabled: window.__marking, translationMode: 'regular' } });
        } else if (msg.type === 'captionCache') cb({ ok: true, cues: [{ start: 0, dur: 1, text: 'unused' }] });
        else if (msg.type === 'translateCues') {
          cb({
            ok: true,
            translations: msg.items.map((i) => ({ id: i.id, text: `译${i.id}` })),
          });
        } else cb({ ok: true });
      },
      onMessage: {
        addListener: (fn) => {
          window.__listeners.push(fn);
        },
      },
    },
  };
  window.__broadcast = (msg) => {
    for (const fn of window.__listeners) fn(msg, {}, () => {});
  };
  // 模拟 tabs.sendMessage：串行调用监听器，取第一个 sendResponse 的结果
  window.__callTab = (msg) =>
    new Promise((resolve) => {
      let settled = false;
      const done = (r) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      const tryListener = (i) => {
        if (i >= window.__listeners.length) {
          done(undefined);
          return;
        }
        let responded = false;
        const ret = window.__listeners[i](msg, {}, (resp) => {
          responded = true;
          done(resp);
        });
        if (responded || ret === true) return;
        tryListener(i + 1);
      };
      tryListener(0);
      setTimeout(() => done(undefined), 2000);
    });
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  // ============================ A. 网页（M1 + M3 标记） ==========================

  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(
    `<!doctype html><html><head><title>render check</title></head>
<body style="margin:40px; font:16px/1.6 serif; max-width:640px">
<p id="para">Procrastination is the act of unnecessarily and voluntarily delaying
or postponing something despite knowing that there will be negative consequences
of doing so. In ancient Egypt, procrastination was considered a virtue.</p>
<p id="para2">The committee decided to abandon the probe. They went home and give up eventually.</p>
<input id="editor" value="committee abandon went give up"/>
<pre id="code">committee abandon went give up</pre>
<!-- 高 z-index 全屏覆盖层：弹窗必须盖在它上面 -->
<div id="overlay" style="position:fixed;inset:0;z-index:999999;background:rgba(120,0,0,.03);pointer-events:auto"></div>
</body></html>`,
  );
  await page.evaluate(installStub);
  await page.evaluate(() => {
    window.__items = [
      { key: 'abandon', expression: 'abandon', status: 'saved', forms: [] },
      { key: 'probe', expression: 'probe', status: 'known', forms: [] },
      { key: 'committee', expression: 'committee', status: 'learning', forms: [] },
      { key: 'go', expression: 'go', status: 'saved', forms: ['went'] },
      { key: 'give', expression: 'give', status: 'saved', forms: [] },
      { key: 'give up', expression: 'give up', status: 'learning', forms: [] },
    ];
    // 缺陷 2 回归：正文前放 600 个非匹配文本节点。分片扫描若从头回卷，
    // 标记窗口永远推进不到后面的段落（维基 / X 页头即此形态）。
    const noise = document.createElement('div');
    noise.id = 'noise';
    for (let i = 0; i < 600; i++) {
      noise.appendChild(document.createTextNode(`填充内容 ${i} filler text`));
      noise.appendChild(document.createElement('br'));
    }
    document.body.prepend(noise);
  });
  await page.addScriptTag({ content: webScript });
  await page.waitForSelector('html[data-blc-web="1"]');
  await page.waitForTimeout(1200); // 等分片标记推进过噪声区

  // ---- M3 标记 -----------------------------------------------------------------
  const marks = await page.evaluate(() => {
    const out = [];
    for (const span of document.querySelectorAll('#para2 span[data-blc-key]')) {
      out.push({
        text: span.textContent,
        status: span.getAttribute('data-blc-key'),
        cls: span.className,
      });
    }
    return out;
  });
  const byText = new Map(marks.map((m) => [m.text, m]));
  check(
    '标记：词形 went 呈现 go 的 saved 状态',
    byText.get('went')?.status === 'saved',
    JSON.stringify(marks),
  );
  check('标记：saved 样式', byText.get('abandon')?.cls === 'blc-mark saved');
  check('标记：known 低强调样式', byText.get('probe')?.cls === 'blc-mark known');
  check('标记：learning 样式', byText.get('committee')?.cls === 'blc-mark learning');
  check(
    '标记：短语最长优先（give up 整体，give 不单独拆）',
    byText.get('give up')?.status === 'learning' && !byText.has('give'),
    JSON.stringify([...byText.keys()]),
  );
  const skipped = await page.evaluate(
    () =>
      document.querySelector('#editor')?.querySelector('span[data-blc-key]') !== null ||
      document.querySelector('#code')?.querySelector('span[data-blc-key]') !== null,
  );
  check('标记：跳过输入框与代码区', skipped === false);
  const paraClean = await page.evaluate(
    () => document.querySelector('#para')?.querySelectorAll('span[data-blc-key]').length ?? -1,
  );
  check('标记：未收藏正文不受影响', paraClean === 0);

  // 标记拆除：设置关闭 → settings-changed → 全部还原
  await page.evaluate(() => {
    window.__marking = false;
    window.__broadcast({ type: 'settings-changed' });
  });
  await page.waitForTimeout(400);
  const afterOff = await page.evaluate(() => {
    const p2 = document.getElementById('para2');
    return {
      marks: p2.querySelectorAll('span[data-blc-key]').length,
      styleGone: !document.getElementById('blc-mark-style'),
      text: p2.textContent,
    };
  });
  check(
    '标记：关闭开关后完整还原',
    afterOff.marks === 0 &&
      afterOff.styleGone &&
      afterOff.text.includes('They went home and give up eventually.'),
    JSON.stringify(afterOff),
  );

  // 状态同步：重新开启 + vocab-changed 改状态
  await page.evaluate(() => {
    window.__marking = true;
    window.__items = window.__items.map((it) =>
      it.key === 'abandon' ? { ...it, status: 'known' } : it,
    );
    window.__broadcast({ type: 'settings-changed' });
  });
  await page.waitForTimeout(400);
  const abandonCls = await page.evaluate(
    () =>
      document.querySelector('#para2 span[data-blc-key="known"]')?.textContent ?? null,
  );
  check('标记：vocab 状态变化后重刷（abandon → known）', abandonCls === 'abandon');

  // 动态新增正文（X 时间线形态）：观察器应标记新增节点
  await page.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'para-dyn';
    p.textContent = 'The committee met again later.';
    document.getElementById('para2').after(p);
  });
  await page.waitForFunction(
    () => !!document.querySelector('#para-dyn span[data-blc-key]'),
    null,
    { timeout: 5000 },
  );
  check('动态新增正文可识别（MutationObserver）', true);

  // ---- 弹窗（M1 行为回归） -------------------------------------------------------
  await page.evaluate(() => {
    window.__items = []; // 避免选区文本被拆分影响
    const p = document.getElementById('para2');
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const idx = node.nodeValue.indexOf('eventually');
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + 'eventually'.length);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(range);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        break;
      }
    }
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    document
      .getElementById('blc-lookup-pill')
      ?.shadowRoot?.querySelector('button')
      ?.click();
  });
  await page.waitForTimeout(300);
  const popup = await page.evaluate(() => {
    const host = document.getElementById('blc-lookup-popup');
    const card = host?.shadowRoot?.querySelector('.card');
    if (!card) return null;
    const r = card.getBoundingClientRect();
    return {
      rect: { w: Math.round(r.width), h: Math.round(r.height) },
      text: card.innerText,
      buttons: [...card.querySelectorAll('button')].map((b) => b.textContent),
    };
  });
  check('弹窗打开', !!popup && popup.rect.w > 100, popup ? JSON.stringify(popup.rect) : 'null');
  check(
    '弹窗含表达与词形（释义来自 stub）',
    !!popup &&
      popup.text.includes('eventually') &&
      popup.text.includes('去；离开') &&
      popup.text.includes('go'),
    popup ? popup.text.slice(0, 100) : '',
  );
  check(
    '操作按钮齐全',
    !!popup &&
      popup.buttons.includes('保存') &&
      popup.buttons.includes('已掌握') &&
      popup.buttons.includes('关闭'),
    '',
  );

  // 置顶 + 拖动（覆盖层之上）
  const topmost = await page.evaluate(() => {
    const card = document
      .getElementById('blc-lookup-popup')
      ?.shadowRoot?.querySelector('.card');
    if (!card) return null;
    const r = card.getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + 40);
    return { hit: el?.id ?? el?.tagName ?? null };
  });
  check('弹窗位于页面覆盖层之上', topmost?.hit === 'blc-lookup-popup', JSON.stringify(topmost));

  const before = await page.evaluate(() => {
    const r = document
      .getElementById('blc-lookup-popup')
      .shadowRoot.querySelector('.card')
      .getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const headerPt = await page.evaluate(() => {
    const h = document
      .getElementById('blc-lookup-popup')
      .shadowRoot.querySelector('.expr');
    const r = h.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(headerPt.x, headerPt.y);
  await page.mouse.down();
  await page.mouse.move(headerPt.x - 120, headerPt.y + 80, { steps: 5 });
  await page.mouse.up();
  const after = await page.evaluate(() => {
    const r = document
      .getElementById('blc-lookup-popup')
      .shadowRoot.querySelector('.card')
      .getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  check(
    '拖动标题行移动弹窗',
    Math.abs(after.x - (before.x - 120)) < 4 && Math.abs(after.y - (before.y + 80)) < 4,
    JSON.stringify({ before, after }),
  );

  // 保存：快照（网页来源）+ 反馈
  await page.evaluate(() => {
    const card = document.getElementById('blc-lookup-popup')?.shadowRoot?.querySelector('.card');
    [...card.querySelectorAll('button')].find((b) => b.textContent === '保存')?.click();
  });
  await page.waitForTimeout(300);
  const feedback = await page.evaluate(
    () =>
      document
        .getElementById('blc-lookup-popup')
        ?.shadowRoot?.querySelector('#blc-feedback')?.textContent ?? null,
  );
  const savedMsgs = await page.evaluate(() => window.__saved);
  check(
    '保存发送网页快照（source=web + 词形）',
    savedMsgs.length === 1 &&
      savedMsgs[0].type === 'save' &&
      savedMsgs[0].snapshot?.source === 'web' &&
      savedMsgs[0].snapshot?.expression === 'eventually' &&
      JSON.stringify(savedMsgs[0].result?.entry?.forms) === '["go"]' && savedMsgs[0].forms === undefined,
    JSON.stringify(savedMsgs[0] ?? null).slice(0, 160),
  );
  check('保存成功反馈', feedback === '已保存 ✓', JSON.stringify(feedback));

  // ---- M5 继续问：弹窗转入问答（chatEnsure 带材料与引用） -------------------------
  await page.evaluate(() => {
    const card = document.getElementById('blc-lookup-popup')?.shadowRoot?.querySelector('.card');
    [...card.querySelectorAll('button')].find((b) => b.textContent === '继续问')?.click();
  });
  await page.waitForFunction(() => window.__chat.length === 1);
  const chatAsk = await page.evaluate(() => {
    const m = window.__chat[0];
    return {
      sourceType: m.source?.sourceType,
      sourceKey: m.source?.sourceKey,
      label: m.material?.label,
      blocks: m.material?.blocks?.length ?? 0,
      quoteExpr: m.quote?.expression,
      quoteBlocks: m.quote?.blockIds,
      quoteDef: m.quote?.definition,
      openPanel: m.openPanel,
    };
  });
  check(
    '继续问：chatEnsure 带文章来源 + 材料 + 引用 + 打开面板',
    chatAsk.sourceType === 'article' &&
      chatAsk.sourceKey?.startsWith('web:') &&
      chatAsk.blocks >= 1 &&
      chatAsk.quoteExpr === 'eventually' &&
      chatAsk.quoteDef === '去；离开' &&
      chatAsk.openPanel === true,
    JSON.stringify(chatAsk),
  );
  const askClosed = await page.evaluate(() => !document.getElementById('blc-lookup-popup'));
  check('继续问后弹窗关闭', askClosed === true);

  // 标签页直达：来源描述 / 按需材料 / 引用定位
  const srcInfo = await page.evaluate(() => window.__callTab({ type: 'blc-chat-source' }));
  check(
    'chat-source：文章来源描述',
    srcInfo?.type === 'blc-chat-source-info' &&
      srcInfo.source?.sourceType === 'article' &&
      srcInfo.canMaterial === true,
    JSON.stringify(srcInfo)?.slice(0, 120),
  );
  const matInfo = await page.evaluate(() =>
    window.__callTab({ type: 'blc-chat-material' }),
  );
  check(
    'chat-material：段落块带 p 编号',
    matInfo?.material?.blocks?.length >= 1 && /^p1$/.test(matInfo.material.blocks[0]?.id ?? ''),
    JSON.stringify(matInfo?.material?.label),
  );
  const located = await page.evaluate(() =>
    window.__callTab({ type: 'blc-chat-locate', text: 'give up eventually' }),
  );
  const locatedMiss = await page.evaluate(() =>
    window.__callTab({ type: 'blc-chat-locate', text: '这句话不存在于页面 zz' }),
  );
  check(
    '引用定位：命中滚动 / 未命中返回 false',
    located?.found === true && locatedMiss?.found === false,
    JSON.stringify({ located, locatedMiss }),
  );

  await page.screenshot({ path: join(shotDir, 'render-popup.png') });
  await page.close();

  // ============================ B. YouTube 模拟页（M2） ==========================

  const yt = await browser.newPage({ viewport: { width: 720, height: 420 } });
  await yt.goto(`http://127.0.0.1:${ytPort}/watch?v=testvid1&foo=bar`);
  await yt.evaluate(installStub);
  await yt.evaluate(() => {
    window.__items = [
      { key: 'constrain', expression: 'constrain', status: 'saved', forms: [] },
      { key: 'go', expression: 'go', status: 'saved', forms: ['went'] },
    ];
    // 伪 video：可控 paused / currentTime
    const v = document.querySelector('video');
    v.__fakePaused = true;
    Object.defineProperty(v, 'paused', { get() { return this.__fakePaused; } });
    v.play = function () { this.__fakePaused = false; return Promise.resolve(); };
    v.pause = function () { this.__fakePaused = true; };
    // 捕获 content script 的 config，取其 nonce
    window.__cfgNonce = null;
    window.__msgs = [];
    window.addEventListener('message', (e) => {
      if (e.data?.source === 'blc-content') {
        window.__msgs.push(e.data);
        if (e.data.type === 'config') window.__cfgNonce = e.data.nonce;
      }
    });
  });
  await yt.addScriptTag({ content: ytScript });
  await yt.waitForFunction(() => window.__cfgNonce !== null);
  const nonce = await yt.evaluate(() => window.__cfgNonce);

  const postMsg = (data) =>
    yt.evaluate((d) => window.postMessage(d, '*'), {
      source: 'blc-inject',
      videoId: 'testvid1',
      nonce,
      seen: 2,
      ...data,
    });

  // 轨道表 + ASR 英文轨（带滚动重复）
  await postMsg({ type: 'tracklist', tracks: [{ lang: 'en', kind: 'manual' }] });
  await postMsg({
    type: 'cues',
    trackKind: 'asr',
    trackLang: 'en',
    trackId: 'https://t/tt-en',
    cues: [
      { start: 0, dur: 3000, text: 'the sounds of', lastOff: 2800 },
      { start: 1400, dur: 2000, text: 'the sounds of silence', lastOff: 3300 },
      { start: 5000, dur: 2000, text: 'one went home', lastOff: 6800 },
      { start: 9000, dur: 2000, text: 'give it up', lastOff: 10800 },
    ],
  });
  await yt.waitForFunction(() => document.getElementById('blc-debug')?.getAttribute('data-blc-count') === '3');

  // 徽标默认隐藏 + 属性诊断
  const badge = await yt.evaluate(() => {
    const host = document.getElementById('blc-debug');
    const box = host.shadowRoot.querySelector('.box');
    return {
      hidden: box.hasAttribute('hidden'),
      state: host.getAttribute('data-blc-state'),
      video: host.getAttribute('data-blc-video'),
      trackLang: host.getAttribute('data-blc-track-lang'),
    };
  });
  check('M2 徽标默认隐藏（属性诊断仍在）', badge.hidden && badge.state === 'cues' && badge.video === 'testvid1' && badge.trackLang === 'en', JSON.stringify(badge));

  // currentTime 定位：0.5s → 合并后的第一句；中文预取对齐
  await yt.evaluate(() => {
    document.querySelector('video').currentTime = 0.5;
  });
  await yt.waitForFunction(() => {
    const en = document.getElementById('blc-subs')?.shadowRoot?.querySelector('.en');
    return en && en.textContent === 'the sounds of silence';
  });
  await yt.waitForFunction(() => {
    const zh = document.getElementById('blc-subs')?.shadowRoot?.querySelector('.zh');
    return zh && zh.textContent === '译0';
  });
  check('currentTime 定位当前句（ASR 滚动合并）+ 译文按 ID 对齐', true);

  // 5.5s → 第二句；词形标记
  await yt.evaluate(() => {
    document.querySelector('video').currentTime = 5.5;
  });
  await yt.waitForFunction(() => {
    const en = document.getElementById('blc-subs')?.shadowRoot?.querySelector('.en');
    return en && en.textContent === 'one went home';
  });
  const wordMark = await yt.evaluate(() => {
    const w = [...document.getElementById('blc-subs').shadowRoot.querySelectorAll('.w')].find(
      (n) => n.className === 'w saved',
    );
    return w?.textContent ?? null;
  });
  check('字幕词形标记（went → go saved）', wordMark === 'went', JSON.stringify(wordMark));

  // ---- M5 问答：视频来源与材料（trackId 透出、块带起止毫秒） -----------------------
  const ytSrc = await yt.evaluate(() => window.__callTab({ type: 'blc-chat-source' }));
  check(
    'chat-source：视频来源带轨道身份',
    ytSrc?.source?.sourceType === 'youtube' &&
      ytSrc.source.sourceKey === 'yt:testvid1' &&
      ytSrc.source.video?.trackId === 'https://t/tt-en' &&
      ytSrc.canMaterial === true,
    JSON.stringify(ytSrc)?.slice(0, 140),
  );
  const ytMat = await yt.evaluate(() =>
    window.__callTab({ type: 'blc-chat-material' }),
  );
  check(
    'chat-material：完整字幕块（合并后）带时间',
    ytMat?.material?.label === '当前轨道完整字幕' &&
      ytMat.material.blocks.length === 3 &&
      ytMat.material.blocks[1]?.id === 'p2' &&
      ytMat.material.blocks[1]?.startMs === 5000 &&
      ytMat.material.blocks[1]?.endMs === 7000,
    JSON.stringify(ytMat?.material?.blocks?.[1]),
  );
  await yt.evaluate(() => {
    const w = [...document.getElementById('blc-subs').shadowRoot.querySelectorAll('.w')].find(
      (n) => n.className === 'w saved',
    );
    w.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
  });
  await yt.waitForFunction(() => !!document.getElementById('blc-lookup-popup'));
  await yt.evaluate(() => {
    const card = document.getElementById('blc-lookup-popup')?.shadowRoot?.querySelector('.card');
    [...card.querySelectorAll('button')].find((b) => b.textContent === '继续问')?.click();
  });
  await yt.waitForFunction(() => window.__chat.length === 1);
  const ytAsk = await yt.evaluate(() => {
    const m = window.__chat[0];
    return {
      sourceKey: m.source?.sourceKey,
      blocks: m.material?.blocks?.length ?? 0,
      quoteBlocks: m.quote?.blockIds,
      note: m.quote?.note,
    };
  });
  check(
    '视频继续问：引用固定当前句（p2 + 时间备注）',
    ytAsk.sourceKey === 'yt:testvid1' &&
      ytAsk.blocks === 3 &&
      JSON.stringify(ytAsk.quoteBlocks) === '["p2"]' &&
      ytAsk.note?.startsWith('0:05'),
    JSON.stringify(ytAsk),
  );
  await yt.waitForFunction(() => !document.getElementById('blc-lookup-popup'));

  // 点击查词：暂停 + 弹窗 + 视频快照
  await yt.evaluate(() => {
    document.querySelector('video').__fakePaused = false; // 播放中
  });
  const clickMarkedWord = () => {
    const w = [...document.getElementById('blc-subs').shadowRoot.querySelectorAll('.w')].find(
      (n) => n.className === 'w saved',
    );
    w.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
  };
  await yt.evaluate(clickMarkedWord);
  await yt.waitForFunction(() => !!document.getElementById('blc-lookup-popup'));
  const lookupState = await yt.evaluate(() => {
    const card = document.getElementById('blc-lookup-popup')?.shadowRoot?.querySelector('.card');
    return {
      paused: document.querySelector('video').paused,
      text: card?.innerText ?? '',
    };
  });
  check('查词暂停播放', lookupState.paused === true);
  check(
    '弹窗：表达 + 当前句 + 时间行',
    lookupState.text.includes('went') &&
      lookupState.text.includes('one went home') &&
      lookupState.text.includes('0:05'),
    lookupState.text.slice(0, 120),
  );
  // 保存 → 视频快照（videoId/轨道/起始毫秒/词形）
  await yt.evaluate(() => {
    const card = document.getElementById('blc-lookup-popup')?.shadowRoot?.querySelector('.card');
    [...card.querySelectorAll('button')].find((b) => b.textContent === '保存')?.click();
  });
  await yt.waitForFunction(() => window.__saved.length === 1);
  const videoSnap = await yt.evaluate(() => {
    const m = window.__saved[0];
    return {
      source: m.snapshot?.source,
      videoId: m.snapshot?.video?.videoId,
      trackId: m.snapshot?.video?.trackId,
      startMs: m.snapshot?.video?.startMs,
      sentence: m.snapshot?.sentence,
      neighbors: m.snapshot?.neighbors,
      forms: m.result?.entry?.forms,
    };
  });
  check(
    '视频快照：videoId/轨道/起始毫秒/相邻字幕/词形',
    videoSnap.source === 'video' &&
      videoSnap.videoId === 'testvid1' &&
      videoSnap.trackId === 'https://t/tt-en' &&
      videoSnap.startMs === 5000 &&
      videoSnap.sentence === 'one went home' &&
      videoSnap.neighbors === 'the sounds of silence / give it up' &&
      JSON.stringify(videoSnap.forms) === '["go"]',
    JSON.stringify(videoSnap),
  );

  // 关闭弹窗 → 恢复播放（由本次查词暂停 + 同一视频）
  await yt.evaluate(() => {
    const card = document.getElementById('blc-lookup-popup')?.shadowRoot?.querySelector('.card');
    [...card.querySelectorAll('button')].find((b) => b.textContent === '关闭')?.click();
  });
  await yt.waitForFunction(() => !document.getElementById('blc-lookup-popup'));
  const resumed = await yt.evaluate(() => document.querySelector('video').paused);
  check('关闭弹窗恢复播放', resumed === false);

  // 手动恢复后不再代为恢复：暂停 → 打开弹窗（本次暂停）→ 用户手动播放 → 关闭不重复播放
  await yt.evaluate(() => {
    const v = document.querySelector('video');
    v.pause();
  });
  await yt.evaluate(clickMarkedWord);
  await yt.waitForFunction(() => !!document.getElementById('blc-lookup-popup'));
  await yt.evaluate(() => {
    // 用户主动播放（play 事件 → content script 取消恢复责任）
    const v = document.querySelector('video');
    v.play();
    v.dispatchEvent(new Event('play'));
  });
  await yt.evaluate(() => {
    const card = document.getElementById('blc-lookup-popup')?.shadowRoot?.querySelector('.card');
    [...card.querySelectorAll('button')].find((b) => b.textContent === '关闭')?.click();
  });
  await yt.waitForFunction(() => !document.getElementById('blc-lookup-popup'));
  const stillPlaying = await yt.evaluate(() => !document.querySelector('video').paused);
  check('用户主动恢复后关闭不再代播', stillPlaying === true);

  // 拖选短语查词（不误触单词）
  await yt.evaluate(() => {
    const en = document.getElementById('blc-subs').shadowRoot.querySelector('.en');
    const words = [...en.querySelectorAll('.w')];
    const range = document.createRange();
    range.setStartBefore(words[0]);
    range.setEndAfter(words[1]);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    // mouseup 落在 .en 内（真实拖选结束位置），经 composed 冒泡到宿主监听
    en.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
  });
  await yt.locator('#pd-phrase-actions').getByRole('button',{name:'查词',exact:true}).click();
  await yt.waitForFunction(() => !!document.getElementById('blc-lookup-popup'));
  check('词卡隔离宿主文字阴影', await yt.locator('#blc-lookup-popup .expr').evaluate(el => getComputedStyle(el).textShadow === 'none'));
  const phraseExpr = await yt.evaluate(
    () =>
      document
        .getElementById('blc-lookup-popup')
        ?.shadowRoot?.querySelector('.expr')?.textContent ?? null,
  );
  check('拖选短语按短语查词', phraseExpr === 'one went', JSON.stringify(phraseExpr));
  await yt.evaluate(() => {
    const card = document.getElementById('blc-lookup-popup')?.shadowRoot?.querySelector('.card');
    [...card.querySelectorAll('button')].find((b) => b.textContent === '关闭')?.click();
  });
  await yt.waitForFunction(() => !document.getElementById('blc-lookup-popup'));

  // 非英文轨道：内容丢弃 + 提示（不把其它语言当英文处理）
  await postMsg({
    type: 'cues',
    trackKind: 'asr',
    trackLang: 'fr',
    trackId: 'https://t/tt-fr',
    cues: [{ start: 0, dur: 2000, text: 'bonjour', lastOff: 1900 }],
  });
  await yt.waitForFunction(
    () => document.getElementById('blc-debug')?.getAttribute('data-blc-count') === '',
  );
  const frNotice = await yt.evaluate(() => {
    const host = document.getElementById('blc-debug');
    return {
      notice: host.getAttribute('data-blc-notice'),
      bar: document.getElementById('blc-subs')?.shadowRoot?.querySelector('.notice')?.textContent ?? null,
    };
  });
  check(
    '非英文轨道丢弃并提示',
    !!frNotice.notice && !!frNotice.bar,
    JSON.stringify(frNotice),
  );

  // 恢复英文轨道 → 字幕回来（旧结果不覆盖）
  await postMsg({
    type: 'cues',
    trackKind: 'manual',
    trackLang: 'en',
    trackId: 'https://t/tt-en2',
    cues: [
      { start: 0, dur: 4000, text: 'english is back', lastOff: 3900 },
    ],
  });
  await yt.evaluate(() => {
    document.querySelector('video').currentTime = 1.0;
  });
  await yt.waitForFunction(() => {
    const en = document.getElementById('blc-subs')?.shadowRoot?.querySelector('.en');
    return en && en.textContent === 'english is back';
  });
  check('换回英文轨道后字幕恢复', true);

  // 双语开关：右上常驻按钮关闭 → 移除字幕栏 + 清译文；再开 → 恢复
  await yt.evaluate(() => {
    document.getElementById('blc-subs-switch')?.shadowRoot?.querySelector('#bilingual')?.click();
  });
  await yt.waitForFunction(() => !document.getElementById('blc-subs'));
  const offState = await yt.evaluate(() => ({
    bilingual: document.getElementById('blc-debug')?.getAttribute('data-blc-bilingual'),
    zh: document.getElementById('blc-debug')?.getAttribute('data-blc-zh'),
    switchOff: !document.getElementById('blc-subs-switch')?.shadowRoot?.querySelector('#bilingual')?.checked,
    nativeVisible: !document.getElementById('blc-hide-native-captions'),
    originalCcRestored: document.querySelector('.ytp-subtitles-button').getAttribute('aria-pressed') === 'false',
  }));
  check(
    '关闭双语：移除字幕栏、保留译文缓存、恢复原生字幕显示',
    offState.bilingual === 'off' && Number(offState.zh) > 0 && offState.switchOff && offState.nativeVisible === true && offState.originalCcRestored,
    JSON.stringify(offState),
  );
  await yt.evaluate(() => {
    document.getElementById('blc-subs-switch')?.shadowRoot?.querySelector('#bilingual')?.click();
  });
  await yt.waitForFunction(() => !!document.getElementById('blc-subs'));
  check('重新开启双语恢复字幕栏', true);

  // 中文显隐：隐藏后不再预取（新句译文不再出现）
  await yt.evaluate(() => {
    document.querySelector('video').currentTime = 3.9;
  });
  await yt.waitForFunction(() => {
    const en = document.getElementById('blc-subs')?.shadowRoot?.querySelector('.en');
    return en && en.textContent === 'english is back';
  });
  await yt.evaluate(() => {
    document.getElementById('blc-subs-switch').shadowRoot.querySelector('#chinese').click();
  });
  await yt.waitForFunction(
    () =>
      document.getElementById('blc-debug')?.getAttribute('data-blc-chinese') === 'hidden',
  );
  const zhHidden = await yt.evaluate(
    () => !document.getElementById('blc-subs')?.shadowRoot?.querySelector('.zh'),
  );
  check('隐藏中文：不再显示译文', zhHidden === true);

  check('学习菜单隔离播放器文字阴影', await yt.locator('#blc-subs-switch label').first().evaluate(el => getComputedStyle(el).textShadow === 'none' && getComputedStyle(el).fontWeight === '400'));
  await yt.screenshot({ path: join(shotDir, 'render-youtube.png') });
  await yt.locator('#blc-subs-switch #learning').click();
  await yt.locator('#blc-subs-switch #menu').screenshot({ path: join(shotDir, 'render-video-menu.png') });
  await yt.close();

  await renderM6({ browser, port: ytPort, content: ytScript, inject: readFileSync(join(here, '..', '.output/chrome-mv3/content-scripts/youtube-inject.js'), 'utf8'), installStub, check });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n通过 ${results.length - failed}，失败 ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
} finally {
  await browser.close();
  server.close();
}
