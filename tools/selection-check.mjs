// 选区查词与添加到对话（selection-chat-actions spec）受控浏览器验收。
// 三部分：
//   A. 真实扩展 + 合成网页（路由拦截，无外部依赖）：分类浮条、有效表达、
//      候选持久化、三入口附加、附件区 UI、重复/替换/移除、导航失效、失败反馈保留、零 LLM。
//   B. 注入构建产物到模拟视频页：播放器字幕选区分类、查词有效表达、
//      添加到对话消息形状、拖选不触发单词点击。
//   C. 真实 YouTube（可选，--no-video 跳过）：侧栏字幕列表跨项选择 → 附加。
// 用法：node tools/selection-check.mjs [--no-video]
import { chromium } from 'playwright-core';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { createServer } from 'node:http';

const extension = resolve('.output/chrome-mv3');
const profile = mkdtempSync(join(tmpdir(), 'blc-sel-'));
const output = resolve('.upstream/selection-check');
mkdirSync(output, { recursive: true });
const noVideo = process.argv.includes('--no-video');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ''}`);
  writeFileSync(join(output, 'results.json'), JSON.stringify(results, null, 2));
};

const ARTICLE_HTML = `<!doctype html><html><head><title>Selection Article</title></head><body>
<div class="wrap"><h1>Synthetic body</h1>
<p id="p1">They are learning English together at a steady pace. The method works well.</p>
<p id="p2">Take off your shoes before you enter the room. Well-known rules apply to every guest.</p>
<p>Readers have argued about deliberate practice for years, and the debate keeps producing useful distinctions.</p>
<p>A beginner benefits most from short daily sessions rather than long irregular efforts that invite fatigue.</p>
<p>Consistency compounds quietly: a page a day becomes a library before the calendar notices what happened.</p>
<p>Review matters more than volume, because unretrieved knowledge is indistinguishable from knowledge never gained.</p>
</div></body></html>`;
const OTHER_HTML = `<!doctype html><html><head><title>Other Page</title></head><body>
<p id="q1">A different page entirely, with different text about mountains and rivers.</p>
</body></html>`;
// X 形态页：推文正文是 div[dir=auto]（无语义标签）， hashtag 为 span ——
// 标签清单式块检测在此类页面取不到块（历史根因），通用内联链检测应生效
const X_HTML = `<!doctype html><html><head><title>Teslaconomics on X</title></head><body>
<main>
<article data-testid="tweet">
  <div dir="auto" data-testid="tweetText">Seriously.... what is going on?! It's gotten ridiculously good... <span>#learning</span></div>
</article>
</main></body></html>`;

const browser = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.BLC_CHROME || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
await browser.route('https://example.com/article', r => r.fulfill({ contentType: 'text/html', body: ARTICLE_HTML }));
await browser.route('https://example.com/other', r => r.fulfill({ contentType: 'text/html', body: OTHER_HTML }));
await browser.route('https://x.com/example/status/9999', r => r.fulfill({ contentType: 'text/html', body: X_HTML }));
const sw = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
await sw.evaluate(() => {
  globalThis.__llm = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const address = String(url);
    if (/api\.|\/chat\/completions|deepseek|openai|anthropic|generativelanguage|dashscope/.test(address)) globalThis.__llm.push(address);
    return original(url, init);
  };
});
const llmCount = () => sw.evaluate(() => globalThis.__llm.length);

// ============================== A. 真实扩展 + 网页 ==============================

const page = await browser.newPage();
await page.goto('https://example.com/article');
await page.waitForFunction(() => document.documentElement.getAttribute('data-blc-web') === '1', null, { timeout: 10000 });

const selectText = async (selector, start, end) => page.evaluate(([sel, s, e]) => {
  const p = document.querySelector(sel);
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let acc = 0, node;
  while ((node = walker.nextNode())) {
    if (acc + node.length > s) {
      const range = document.createRange();
      range.setStart(node, s - acc);
      range.setEnd(node, Math.min(e - acc, node.length));
      const sel2 = document.getSelection();
      sel2.removeAllRanges();
      sel2.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return range.toString();
    }
    acc += node.length;
  }
  return null;
}, [selector, start, end]);
const pillButtons = () => page.evaluate(() => {
  const root = document.getElementById('blc-lookup-pill')?.shadowRoot;
  if (!root) return null;
  return {
    lookup: root.querySelector('#lookup')?.hidden,
    translate: root.querySelector('#translate')?.hidden,
    chat: root.querySelector('#chat')?.hidden,
    chatLabel: root.querySelector('#chat')?.getAttribute('aria-label'),
  };
});
const waitForPill = () => page.waitForSelector('#blc-lookup-pill', { timeout: 5000 });

// A1 单词（残缺 learnin）：查词+添加到对话，无翻译
const p1Text = await page.evaluate(() => document.getElementById('p1').textContent);
const learnAt = p1Text.indexOf('learnin');
await selectText('#p1', learnAt, learnAt + 7);
await waitForPill();
check('A1 单词分类：查词+添加到对话（无翻译）', await page.waitForFunction(() => {
  const root = document.getElementById('blc-lookup-pill')?.shadowRoot;
  return root && root.querySelector('#lookup')?.hidden === false && root.querySelector('#translate')?.hidden === true && root.querySelector('#chat')?.hidden === false;
}, null, { timeout: 4000 }).then(() => true, () => false));
check('A1 图标可访问名称', await page.evaluate(() => document.getElementById('blc-lookup-pill')?.shadowRoot?.querySelector('#chat')?.getAttribute('aria-label') === '添加到对话'));

// A2 查词用有效表达（learnin → learning），词卡标题即查询表达
await page.click('#lookup');
await page.waitForSelector('#blc-lookup-popup .expr');
check('A2 查词有效表达：learnin → learning', await page.evaluate(() => document.getElementById('blc-lookup-popup')?.shadowRoot?.querySelector('.expr')?.textContent.startsWith('learning')));
await page.evaluate(() => {
  const card = document.getElementById('blc-lookup-popup')?.shadowRoot?.querySelector('.card');
  [...card.querySelectorAll('button')].find((b) => b.textContent === '关闭')?.click();
});
await page.waitForFunction(() => !document.getElementById('blc-lookup-popup'));

// A3 短语：查词+翻译+添加到对话
const p2Text = await page.evaluate(() => document.getElementById('p2').textContent);
const takeAt = p2Text.indexOf('Take off');
await selectText('#p2', takeAt, takeAt + 8);
await page.waitForFunction(() => document.getElementById('blc-lookup-pill')?.shadowRoot?.querySelector('#lookup')?.hidden === false);
check('A3 短语分类：三入口齐全', await page.waitForFunction(() => {
  const root = document.getElementById('blc-lookup-pill')?.shadowRoot;
  return root && root.querySelector('#lookup')?.hidden === false && root.querySelector('#translate')?.hidden === false && root.querySelector('#chat')?.hidden === false;
}, null, { timeout: 4000 }).then(() => true, () => false));

// A4 句段（>5 词）：无查词
await page.evaluate(() => {
  const paras = document.querySelectorAll('.wrap p');
  const p = paras[2];
  const range = document.createRange();
  range.selectNodeContents(p);
  const s = document.getSelection();
  s.removeAllRanges();
  s.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
});
await page.waitForFunction(() => document.getElementById('blc-lookup-pill')?.shadowRoot?.querySelector('#lookup')?.hidden === true, null, { timeout: 4000 });
check('A4 句段分类：隐藏查词，保留翻译与添加', await page.evaluate(() => {
  const root = document.getElementById('blc-lookup-pill').shadowRoot;
  return root.querySelector('#translate').hidden === false && root.querySelector('#chat').hidden === false;
}));

// A4b 词/短语翻译卡片使用补全+清洗后的正常表达（残缺词补齐、去词外标点）
await selectText('#p1', p1Text.indexOf('teady'), p1Text.indexOf('pace.') + 5); // teady pace.
await page.waitForFunction(() => document.getElementById('blc-lookup-pill')?.shadowRoot?.querySelector('#translate')?.hidden === false, null, { timeout: 4000 });
await page.click('#translate');
await page.waitForSelector('#pd-translation #original');
check('A4b 翻译卡片展示补全/清洗后的表达：teady pace. → steady pace',
  await page.evaluate(() => document.getElementById('pd-translation')?.shadowRoot?.querySelector('#original')?.textContent === 'steady pace'),
  await page.evaluate(() => document.getElementById('pd-translation')?.shadowRoot?.querySelector('#original')?.textContent));
await page.getByRole('button', { name: '关闭翻译' }).click();
await page.waitForFunction(() => !document.getElementById('pd-translation'));

// A4c 句段选区（含内部句界）：翻译卡同样清洗首尾（残缺词补齐；内部保持原文）
await selectText('#p1', p1Text.indexOf('teady'), p1Text.indexOf('. The') + 4); // teady pace. Th
await page.waitForFunction(() => document.getElementById('blc-lookup-pill')?.shadowRoot?.querySelector('#lookup')?.hidden === true, null, { timeout: 4000 });
await page.click('#translate');
await page.waitForSelector('#pd-translation #original');
check('A4c 句段翻译卡清洗首尾：teady pace. Th → steady pace. The（内部句号保留）',
  await page.evaluate(() => document.getElementById('pd-translation')?.shadowRoot?.querySelector('#original')?.textContent === 'steady pace. The'),
  await page.evaluate(() => document.getElementById('pd-translation')?.shadowRoot?.querySelector('#original')?.textContent));
await page.getByRole('button', { name: '关闭翻译' }).click();
await page.waitForFunction(() => !document.getElementById('pd-translation'));

// X1/X2 X 形态页（推文正文 div[dir=auto]、hashtag span，无语义标签）：
// 历史根因复现——标签清单式块检测在此取不到块，所有选区被当作句段、
// 残缺词原样上翻译卡。通用内联链检测后应与语义页同规则。
const xpage = await browser.newPage();
await xpage.goto('https://x.com/example/status/9999');
await xpage.waitForFunction(() => document.documentElement.getAttribute('data-blc-web') === '1', null, { timeout: 10000 });
const xSelect = (from, to) => xpage.evaluate(([f, t]) => {
  const node = document.querySelector('[data-testid="tweetText"]').firstChild;
  const range = document.createRange();
  range.setStart(node, Math.max(0, f));
  range.setEnd(node, Math.min(t, node.length));
  const s = document.getSelection();
  s.removeAllRanges();
  s.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  return range.toString();
}, [from, to]);

// X1 单词（残缺 Seriousl）：word 分类生效，查词+添加（无翻译）；词内补全
await xSelect(0, 8);
await xpage.waitForSelector('#blc-lookup-pill', { timeout: 5000 });
check('X1 X 推文单词分类：查词+添加到对话（无翻译）', await xpage.waitForFunction(() => {
  const root = document.getElementById('blc-lookup-pill')?.shadowRoot;
  return root && root.querySelector('#lookup')?.hidden === false && root.querySelector('#translate')?.hidden === true && root.querySelector('#chat')?.hidden === false;
}, null, { timeout: 4000 }).then(() => true, () => false));
await xpage.click('#lookup');
check('X1 X 推文词内补全：Seriousl → Seriously', await xpage.waitForFunction(() =>
  document.getElementById('blc-lookup-popup')?.shadowRoot?.querySelector('.expr')?.textContent === 'Seriously',
  null, { timeout: 5000 }).then(() => true, () => false));
await xpage.evaluate(() => {
  const card = document.getElementById('blc-lookup-popup')?.shadowRoot?.querySelector('.card');
  [...card.querySelectorAll('button')].find((b) => b.textContent === '关闭')?.click();
});
await xpage.waitForFunction(() => !document.getElementById('blc-lookup-popup'));

// X2 跨省略号句段（用户报障场景）：翻译卡清洗首尾
await xSelect(0, 16); // Seriously.... wh
await xpage.waitForFunction(() => {
  const root = document.getElementById('blc-lookup-pill')?.shadowRoot;
  return root && root.querySelector('#lookup')?.hidden === true && root.querySelector('#translate')?.hidden === false;
}, null, { timeout: 4000 });
await xpage.click('#translate');
await xpage.waitForSelector('#pd-translation #original');
check('X2 X 句段翻译卡清洗首尾：Seriousl.... wh → Seriously.... what',
  await xpage.evaluate(() => document.getElementById('pd-translation')?.shadowRoot?.querySelector('#original')?.textContent === 'Seriously.... what'),
  await xpage.evaluate(() => document.getElementById('pd-translation')?.shadowRoot?.querySelector('#original')?.textContent));
await xpage.getByRole('button', { name: '关闭翻译' }).click();
await xpage.close();

// 面板：以 iframe 注入页面（复刻浮动模式——页面与面板同可见、同活动标签页）；
// 页面导航会销毁 iframe，用 mountPanel 重挂（临时编辑状态经 storage.session 恢复）
let panel = null;
const mountPanel = async () => {
  await page.evaluate((src) => {
    document.getElementById('test-panel')?.remove();
    const iframe = document.createElement('iframe');
    iframe.id = 'test-panel';
    iframe.src = src;
    iframe.style.cssText = 'position:fixed;right:0;top:0;width:430px;height:660px;z-index:2147483647;border:0;background:#fff';
    document.body.appendChild(iframe);
  }, `chrome-extension://${extId}/sidepanel.html`);
  let frame = null;
  for (let i = 0; i < 50 && !frame; i++) {
    frame = page.frames().find((f) => f.url().startsWith(`chrome-extension://${extId}/sidepanel.html`)) ?? null;
    if (!frame) await page.waitForTimeout(200);
  }
  if (!frame) throw new Error('sidepanel iframe not loaded');
  panel = {
    click: (sel) => frame.locator(sel).first().click(),
    fill: (sel, v) => frame.locator(sel).fill(v),
    inputValue: (sel) => frame.locator(sel).inputValue(),
    waitForFunction: (fn, arg, opt) => frame.waitForFunction(fn, arg, opt),
    waitForTimeout: (ms) => frame.waitForTimeout(ms),
    evaluate: (fn, arg) => frame.evaluate(fn, arg),
  };
  await panel.waitForFunction(() => !!document.querySelector('[data-view="chat"]'), null, { timeout: 10000 });
  await panel.click('[data-view="chat"]');
  await panel.waitForTimeout(400);
};
const panelSend = (msg) => panel.evaluate(async m => {
  const w = await chrome.windows.getCurrent();
  return chrome.runtime.sendMessage({ windowId: w.id, ...m });
}, msg);
const attachViaMenu = async (kind) => {
  await panel.click('#chat-attachments summary');
  await panel.waitForTimeout(500);
  await panel.click(`#chat-attach-${kind}`);
  await panel.waitForTimeout(800);
};
const chatState = () => panelSend({ type: 'chatActive' });

await mountPanel();
await panel.fill('#chat-input', '我的问题草稿');

await panel.click('[data-view="chat"]');
await panel.waitForTimeout(300); // 面板启动即为新会话编辑，直接使用
await panel.fill('#chat-input', '我的问题草稿');

// A5 候选持久化：选区折叠后仍可附加；草稿保留；聚焦输入框
await selectText('#p2', takeAt, takeAt + 8);
await page.waitForTimeout(450); // 候选固定
await page.evaluate(() => { document.getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
await page.waitForTimeout(300);
await attachViaMenu('selection');
await panel.waitForFunction(() => !document.getElementById('chat-attachment')?.hidden && document.getElementById('chat-attachment-summary')?.textContent, null, { timeout: 5000 });
let stateA = await chatState();
check('A5 折叠选区仍可附加（焦点+原句两块）', stateA.chat?.snapshots?.length === 1 &&
  stateA.chat.snapshots[0].blocks.length === 2 &&
  stateA.chat.snapshots[0].blocks[0].text === 'Take off' &&
  stateA.chat.activeSnapshotVersion === 1, JSON.stringify(stateA.chat?.snapshots?.map(s => [s.version, s.label, s.blocks.length])));
const draftKept = (await panel.inputValue('#chat-input')) === '我的问题草稿';
const inputFocused = await panel.evaluate(() => document.activeElement?.id === 'chat-input');
check('A5 附加成功保留草稿并聚焦输入框', draftKept && inputFocused, `draft=${draftKept} focused=${inputFocused} value=${await panel.inputValue('#chat-input')}`);

// A6 附加菜单：按来源显示入口 + 候选摘要
await panel.click('#chat-attachments summary');
await panel.waitForFunction(() => document.getElementById('chat-attach-selection-summary')?.textContent.includes('Take off'), null, { timeout: 5000 });
check('A6 菜单摘要显示候选', true);
check('A6 非视频页隐藏“附加视频字幕”', await panel.evaluate(() => document.getElementById('chat-attach-video').hidden === true && document.getElementById('chat-attach-page').hidden === false));
await panel.click('#chat-attachments summary');

// A7 附加页面（无 article/main 的页面也能识别已加载正文）
await attachViaMenu('page');
await panel.waitForFunction(() => document.getElementById('chat-attachment-summary')?.textContent === 'Selection Article', null, { timeout: 5000 });
stateA = await chatState();
check('A7 附加页面：div 正文可识别为已加载正文', stateA.chat?.snapshots?.length === 2 &&
  stateA.chat.snapshots[1].label === '已加载正文' &&
  stateA.chat.snapshots[1].blocks.length >= 5, JSON.stringify(stateA.chat?.snapshots?.map(s => [s.version, s.label, s.blocks.length])));

// A8 重复附加不叠加
await selectText('#p2', takeAt, takeAt + 8);
await page.waitForTimeout(450);
await page.evaluate(() => { document.getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
await attachViaMenu('selection');
await panel.waitForTimeout(400);
stateA = await chatState();
check('A8 重复附加同一选区不叠加版本', stateA.chat?.snapshots?.length === 3 &&
  stateA.chat.snapshots[2].label === '词句与原句', JSON.stringify(stateA.chat?.snapshots?.map(s => [s.version, s.label])));

// A9 连续 A→B：替换当前材料与焦点
const wellAt = p2Text.indexOf('Well-known');
await selectText('#p2', wellAt, wellAt + 11);
await page.waitForTimeout(450);
await page.evaluate(() => { document.getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
await attachViaMenu('selection');
await panel.waitForFunction(() => document.getElementById('chat-attachment-summary')?.textContent === 'Well-known', null, { timeout: 5000 });
stateA = await chatState();
check('A9 连续附加替换焦点（历史快照保留）', stateA.chat?.snapshots?.length === 4 &&
  stateA.chat.snapshots[3].blocks[0].text === 'Well-known' &&
  stateA.chat.snapshots[0].blocks[0].text === 'Take off', JSON.stringify(stateA.chat?.snapshots?.map(s => [s.version, s.blocks[0].text])));

// A10 × 移除材料保留问题
await panel.click('#chat-attachment-remove');
await panel.waitForFunction(() => document.getElementById('chat-attachment')?.hidden === true, null, { timeout: 5000 });
check('A10 × 移除材料保留问题', (await panel.inputValue('#chat-input')) === '我的问题草稿');

// A11 附件展开：详情有界滚动区 + 来源
await attachViaMenu('selection');
await panel.waitForFunction(() => !document.getElementById('chat-attachment')?.hidden, null, { timeout: 5000 });
await panel.click('#chat-attachment-chip');
await panel.waitForFunction(() => document.querySelector('#chat-attachment-detail .attach-blocks'), null, { timeout: 5000 });
check('A11 点击预览原位展开材料详情', await panel.evaluate(() => {
  const blocks = document.getElementById('chat-attachment-detail')?.querySelector('.attach-blocks');
  const style = blocks ? getComputedStyle(blocks) : null;
  return !!blocks && blocks.querySelectorAll('.attach-block').length >= 1 && style?.maxHeight && style.overflow === 'auto';
}));

// A12 导航后候选失效；失败反馈保留到下一次操作
await page.goto('https://example.com/other');
await page.waitForFunction(() => document.documentElement.getAttribute('data-blc-web') === '1', null, { timeout: 10000 });
await mountPanel(); // 导航销毁了 iframe；临时编辑与材料经 storage.session 恢复
await attachViaMenu('selection');
await panel.waitForFunction(() => !document.getElementById('chat-meta-error')?.hidden, null, { timeout: 5000 });
const staleMsg = await panel.evaluate(() => document.getElementById('chat-meta-error')?.textContent);
check('A12 导航后附加选区给出明确失效原因', (staleMsg ?? '').includes('不一致'), staleMsg);
await panel.waitForTimeout(3500);
check('A12 失败信息保留到下一次操作（不自动消失）', await panel.evaluate((m) => !document.getElementById('chat-meta-error')?.hidden && document.getElementById('chat-meta-error')?.textContent === m, staleMsg));

// A13 新页面新选区：附加成功清除错误
const q1 = await page.evaluate(() => document.getElementById('q1').textContent);
const diffAt = q1.indexOf('different page');
await selectText('#q1', diffAt, diffAt + 14);
await page.waitForTimeout(450);
await page.evaluate(() => { document.getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
await attachViaMenu('selection');
await panel.waitForFunction(() => document.getElementById('chat-attachment-summary')?.textContent === 'different page', null, { timeout: 5000 });
check('A13 换页新选区附加成功且清除错误', await panel.evaluate(() => document.getElementById('chat-meta-error')?.hidden === true));

check('A 零 LLM：附加与分类全程无 AI 请求', (await llmCount()) === 0, `llm=${await llmCount()}`);

// ============================== B. 模拟视频页（注入构建产物） ==============================

const ytScript = readFileSync(join(extension, 'content-scripts', 'youtube.js'), 'utf8');
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><body style="margin:0">
<div id="movie_player" style="position:relative;width:640px;height:360px;background:#111">
<video></video>
<button class="ytp-subtitles-button" aria-pressed="false" onclick="this.setAttribute('aria-pressed', String(this.getAttribute('aria-pressed') !== 'true'))">CC</button>
</div>
<div id="page-body" style="padding:12px">
<div id="desc" dir="auto">Learning a language takes daily practice and patient review.</div>
<p id="comment">The narrator finally decided to give up learning japanese because the grammar felt impossibly hard at first.</p>
</div></body></html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ytPort = server.address().port;

const yt = await browser.newPage({ viewport: { width: 720, height: 420 } });
await yt.goto(`http://127.0.0.1:${ytPort}/watch?v=testvid1`);
await yt.evaluate(() => {
  if (!crypto.randomUUID) crypto.randomUUID = () => `stub-${Math.random()}`;
  window.__chat = [];
  window.__candidates = [];
  window.__listeners = [];
  window.browser = {
    runtime: {
      id: 'sel-check',
      getURL: () => 'data:,',
      sendMessage: (msg, cb) => {
        if (msg.type === 'chatEnsure') { window.__chat.push(msg); cb({ ok: true, chat: null, panelOpened: true }); }
        else if (msg.type === 'selectionCandidateSet') { window.__candidates.push(msg.candidate); cb({ ok: true }); }
        else if (msg.type === 'subtitleMode') cb({ ok: true, mode: 'regular', autoPause: false });
        else if (msg.type === 'getSettings') cb({ ok: true, settings: { markingEnabled: false, translationMode: 'regular', chineseVisible: true, bilingualEnabled: true } });
        else if (msg.type === 'listSentences') cb({ ok: true, sentences: [] });
        else if (msg.type === 'listEntries') cb({ ok: true, entries: [] });
        else if (msg.type === 'vocabIndex') cb({ ok: true, items: [] });
        else if (msg.type === 'captionCache') cb({ ok: true, cues: [] });
        else if (msg.type === 'translateCues') cb({ ok: true, translations: msg.items.map((i) => ({ id: i.id, text: `译${i.id}` })) });
        else cb({ ok: true });
      },
      onMessage: { addListener: (fn) => window.__listeners.push(fn) },
    },
  };
  const v = document.querySelector('video');
  v.__fakePaused = true;
  Object.defineProperty(v, 'paused', { get() { return this.__fakePaused; } });
  v.play = function () { this.__fakePaused = false; return Promise.resolve(); };
  v.pause = function () { this.__fakePaused = true; };
  window.__cfgNonce = null;
  window.addEventListener('message', (e) => {
    if (e.data?.source === 'blc-content' && e.data.type === 'config') window.__cfgNonce = e.data.nonce;
  });
});
await yt.addScriptTag({ content: ytScript });
await yt.waitForFunction(() => window.__cfgNonce !== null);
const ytNonce = await yt.evaluate(() => window.__cfgNonce);
const postMsg = (data) => yt.evaluate((d) => window.postMessage(d, '*'), { source: 'blc-inject', videoId: 'testvid1', nonce: ytNonce, seen: 2, ...data });
await postMsg({ type: 'cues', trackKind: 'manual', trackLang: 'en', trackId: 'https://t/tt-en', cues: [
  { start: 0, dur: 3000, text: 'the sounds of silence', lastOff: 2800 },
  { start: 5000, dur: 3000, text: 'one went home', lastOff: 7800 },
  { start: 9000, dur: 3000, text: 'they finally decided to give it all up today', lastOff: 11800 },
] });
await yt.waitForFunction(() => document.getElementById('blc-debug')?.getAttribute('data-blc-count') === '3');
await yt.evaluate(() => { document.querySelector('video').currentTime = 5.5; });
await yt.waitForFunction(() => document.getElementById('blc-subs')?.shadowRoot?.querySelector('.en')?.textContent === 'one went home');

const barSelect = async (from, to) => yt.evaluate(([f, t]) => {
  const en = document.getElementById('blc-subs').shadowRoot.querySelector('.en');
  const walker = document.createTreeWalker(en, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  const total = nodes.reduce((sum, n) => sum + n.length, 0);
  const at = (offset) => {
    let cum = 0;
    for (const n of nodes) {
      if (cum + n.length >= offset) return { node: n, off: Math.max(0, offset - cum) };
      cum += n.length;
    }
    return { node: nodes.at(-1) ?? null, off: total };
  };
  if (!nodes.length || f >= total) return null;
  const a = at(f);
  const b = at(Math.min(t, total));
  if (!a || !b) return null;
  const range = document.createRange();
  range.setStart(a.node, a.off);
  range.setEnd(b.node, b.off);
  const s = document.getSelection();
  s.removeAllRanges();
  s.addRange(range);
  en.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
  return range.toString();
}, [from, to]);
const barButtons = () => yt.evaluate(() => {
  const host = document.getElementById('pd-phrase-actions');
  const root = host?.shadowRoot;
  if (!root) return null;
  return {
    lookup: root.querySelector('#lookup').hidden,
    translate: root.querySelector('#translate').hidden,
    chat: root.querySelector('#chat').hidden,
    chatLabel: root.querySelector('#chat').getAttribute('aria-label'),
  };
});

// B1 单词选区（went）：查词+添加到对话，无翻译；候选带视频轨道与时间
const cue2 = 'one went home';
const wentAt = cue2.indexOf('went');
await barSelect(wentAt, wentAt + 4);
await yt.waitForSelector('#pd-phrase-actions');
check('B1 播放器单词选区：查词+添加到对话（无翻译）', await yt.waitForFunction(() => {
  const root = document.getElementById('pd-phrase-actions')?.shadowRoot;
  return root && root.querySelector('#lookup').hidden === false && root.querySelector('#translate').hidden === true && root.querySelector('#chat').hidden === false;
}, null, { timeout: 4000 }).then(() => true, () => false));
check('B1 添加到对话可访问名称', (await barButtons())?.chatLabel === '添加到对话');
await yt.waitForFunction(() => window.__candidates.length >= 1, null, { timeout: 4000 });
check('B1 候选固定：视频轨道+字幕项+时间', await yt.evaluate(() => {
  const c = window.__candidates.at(-1);
  return c?.source?.sourceType === 'youtube' && c?.source?.video?.trackId === 'https://t/tt-en' &&
    c?.cue?.text === 'one went home' && c?.cue?.startMs === 5000 && c?.text === 'went' && c?.kind === 'word';
}));

// B2 拖选不触发单词点击查询
await yt.evaluate(() => {
  const w = [...document.getElementById('blc-subs').shadowRoot.querySelectorAll('.w')].find((n) => n.textContent === 'went');
  w.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
});
await yt.waitForTimeout(400);
check('B2 拖选后单词点击不误触词卡', await yt.evaluate(() => !document.getElementById('blc-lookup-popup')));

// B3 短语（one went → 残缺补齐 one we → one went）
await barSelect(0, 6);
await yt.waitForSelector('#pd-phrase-actions');
await yt.locator('#pd-phrase-actions').getByRole('button', { name: '查词', exact: true }).click();
await yt.waitForFunction(() => document.getElementById('blc-lookup-popup'));
check('B3 短语残缺补齐：one we → one went', await yt.evaluate(() => document.getElementById('blc-lookup-popup')?.shadowRoot?.querySelector('.expr')?.textContent === 'one went'));
await yt.evaluate(() => {
  const card = document.getElementById('blc-lookup-popup')?.shadowRoot?.querySelector('.card');
  [...card.querySelectorAll('button')].find((b) => b.textContent === '关闭')?.click();
});

// B3b 字幕短语翻译卡片同样使用补全后的表达（went ho → went home）
await barSelect(4, 11);
await yt.waitForSelector('#pd-phrase-actions');
await yt.locator('#pd-phrase-actions').getByRole('button', { name: '翻译', exact: true }).click();
await yt.waitForSelector('#pd-translation #original');
check('B3b 字幕翻译卡片展示补全表达：went ho → went home',
  await yt.evaluate(() => document.getElementById('pd-translation')?.shadowRoot?.querySelector('#original')?.textContent === 'went home'),
  await yt.evaluate(() => document.getElementById('pd-translation')?.shadowRoot?.querySelector('#original')?.textContent));
await yt.evaluate(() => document.getElementById('pd-translation')?.shadowRoot?.querySelector('#close')?.click());
await yt.waitForFunction(() => !document.getElementById('pd-translation'));

// B4 句段（整句 7 词）：无查词，翻译+添加
await yt.evaluate(() => { document.querySelector('video').currentTime = 9.5; });
await yt.waitForFunction(() => document.getElementById('blc-subs')?.shadowRoot?.querySelector('.en')?.textContent.startsWith('they finally'));
await barSelect(0, 100);
await yt.waitForSelector('#pd-phrase-actions');
check('B4 播放器句段：隐藏查词', await yt.evaluate(() => document.getElementById('pd-phrase-actions')?.shadowRoot?.querySelector('#lookup').hidden === true));

// B4b 句段残缺首尾：翻译卡补全首尾（hey…it al → they…all）
await barSelect(2, 33);
await yt.waitForSelector('#pd-phrase-actions');
await yt.locator('#pd-phrase-actions').getByRole('button', { name: '翻译', exact: true }).click();
await yt.waitForSelector('#pd-translation #original');
check('B4b 字幕句段翻译卡补全首尾：hey… it al → they … it all',
  await yt.evaluate(() => document.getElementById('pd-translation')?.shadowRoot?.querySelector('#original')?.textContent === 'they finally decided to give it all'),
  await yt.evaluate(() => document.getElementById('pd-translation')?.shadowRoot?.querySelector('#original')?.textContent));
await yt.evaluate(() => document.getElementById('pd-translation')?.shadowRoot?.querySelector('#close')?.click());
await yt.waitForFunction(() => !document.getElementById('pd-translation'));

// B5 添加到对话：焦点+字幕项背景带时间，openPanel
await yt.evaluate(() => { document.querySelector('video').currentTime = 5.5; });
await yt.waitForFunction(() => document.getElementById('blc-subs')?.shadowRoot?.querySelector('.en')?.textContent === 'one went home');
await barSelect(0, 8); // one wen → one went
await yt.waitForSelector('#pd-phrase-actions');
await yt.locator('#pd-phrase-actions').getByRole('button', { name: '添加到对话' }).click();
await yt.waitForFunction(() => window.__chat.length >= 1, null, { timeout: 5000 });
const ytAttach = await yt.evaluate(() => {
  const m = window.__chat.at(-1);
  return {
    sourceType: m.source?.sourceType,
    videoId: m.source?.video?.videoId,
    trackId: m.source?.video?.trackId,
    blocks: m.material?.blocks?.map((b) => [b.id, b.text, b.startMs]),
    quote: m.quote?.blockIds,
    expression: m.quote?.expression,
    note: m.quote?.note,
    openPanel: m.openPanel,
  };
});
check('B5 添加到对话：选区焦点+字幕项背景带时间+打开面板', ytAttach.sourceType === 'youtube' && ytAttach.videoId === 'testvid1' && ytAttach.trackId === 'https://t/tt-en' &&
  JSON.stringify(ytAttach.blocks) === JSON.stringify([['p1', 'one went', 5000], ['p2', 'one went home', 5000]]) &&
  ytAttach.quote.join() === 'p1' && ytAttach.expression === 'one went' && ytAttach.note?.startsWith('0:05') && ytAttach.openPanel === true,
  JSON.stringify(ytAttach));

// ---- 页面正文选区（描述 / 评论 / 标题）：共用浮条（shared/selectionPill） ----

const pageSelect = (id, from, to) => yt.evaluate(([sel, f, t]) => {
  const el = document.querySelector(sel);
  const node = el?.firstChild;
  if (!node || node.nodeType !== 3) return null;
  const range = document.createRange();
  range.setStart(node, Math.max(0, f));
  range.setEnd(node, Math.min(t, node.length));
  const s = document.getSelection();
  s.removeAllRanges();
  s.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  return range.toString();
}, [id, from, to]);
const ytPillButtons = () => yt.evaluate(() => {
  const root = document.getElementById('blc-lookup-pill')?.shadowRoot;
  if (!root) return null;
  return {
    lookup: root.querySelector('#lookup')?.hidden,
    translate: root.querySelector('#translate')?.hidden,
    chat: root.querySelector('#chat')?.hidden,
    chatLabel: root.querySelector('#chat')?.getAttribute('aria-label'),
  };
});

// B6 字幕栏（Shadow DOM）内选区只走字幕操作条，不出现页面正文浮条
check('B6 字幕栏选区不出现页面正文浮条', await yt.evaluate(() => !document.getElementById('blc-lookup-pill')));

// B7 页面正文单词：查词+添加到对话（无翻译）；候选为 article 源 + 当前地址
const descText = await yt.evaluate(() => document.getElementById('desc').textContent);
const practiceAt = descText.indexOf('practice');
await pageSelect('#desc', practiceAt, practiceAt + 8);
await yt.waitForSelector('#blc-lookup-pill');
check('B7 页面正文单词：查词+添加到对话（无翻译）', await yt.waitForFunction(() => {
  const root = document.getElementById('blc-lookup-pill')?.shadowRoot;
  return root && root.querySelector('#lookup')?.hidden === false && root.querySelector('#translate')?.hidden === true && root.querySelector('#chat')?.hidden === false;
}, null, { timeout: 4000 }).then(() => true, () => false));
check('B7 添加到对话可访问名称', (await ytPillButtons())?.chatLabel === '添加到对话');
await yt.waitForFunction(() => window.__candidates.some((c) => c?.text === 'practice'), null, { timeout: 4000 });
check('B7 页面正文候选：article 源 + 当前页面地址', await yt.evaluate(() => {
  const c = window.__candidates.filter((x) => x?.text === 'practice').at(-1);
  return c?.source?.sourceType === 'article' && c?.pageUrl?.includes('/watch?v=testvid1') && c?.kind === 'word' && c?.expression === 'practice';
}));

// B8 页面正文短语残缺补齐：查词打开词卡，表达按块文本补全
const dailyAt = descText.indexOf('daily');
await pageSelect('#desc', dailyAt, descText.indexOf('patien') + 6); // 尾词选中一半：…and patien
await yt.waitForFunction(() => {
  const root = document.getElementById('blc-lookup-pill')?.shadowRoot;
  return root && root.querySelector('#translate')?.hidden === false;
}, null, { timeout: 4000 });
await yt.locator('#blc-lookup-pill').getByRole('button', { name: '查词', exact: true }).click();
check('B8 页面正文短语残缺补齐：patien → patient', await yt.waitForFunction(() =>
  document.getElementById('blc-lookup-popup')?.shadowRoot?.querySelector('.expr')?.textContent === 'daily practice and patient',
  null, { timeout: 5000 }).then(() => true, () => false));
await yt.evaluate(() => {
  const card = document.getElementById('blc-lookup-popup')?.shadowRoot?.querySelector('.card');
  [...card.querySelectorAll('button')].find((b) => b.textContent === '关闭')?.click();
});

// B9 页面正文句段：无查词，翻译+添加到对话
await pageSelect('#comment', 0, (await yt.evaluate(() => document.getElementById('comment').textContent.length)));
check('B9 页面正文句段：翻译+添加到对话（无查词）', await yt.waitForFunction(() => {
  const root = document.getElementById('blc-lookup-pill')?.shadowRoot;
  return root && root.querySelector('#lookup')?.hidden === true && root.querySelector('#translate')?.hidden === false && root.querySelector('#chat')?.hidden === false;
}, null, { timeout: 4000 }).then(() => true, () => false));

// B10 页面正文添加到对话：article 源 + 「词句与原句」材料（焦点表达+原句背景）
await pageSelect('#desc', practiceAt, practiceAt + 8);
await yt.waitForSelector('#blc-lookup-pill');
await yt.locator('#blc-lookup-pill').getByRole('button', { name: '添加到对话' }).click();
await yt.waitForFunction(() => window.__chat.some((m) => m?.source?.sourceType === 'article'), null, { timeout: 5000 });
const bodyAttach = await yt.evaluate(() => {
  const m = window.__chat.filter((x) => x?.source?.sourceType === 'article').at(-1);
  return {
    label: m.material?.label,
    blocks: m.material?.blocks?.map((b) => b.text),
    focus: m.quote?.blockIds,
    expression: m.quote?.expression,
    openPanel: m.openPanel,
  };
});
check('B10 页面正文附加：article 源+词句与原句+焦点表达', bodyAttach.label === '词句与原句' &&
  bodyAttach.blocks?.[0] === 'practice' && typeof bodyAttach.blocks?.[1] === 'string' && bodyAttach.blocks[1].includes('daily practice') &&
  bodyAttach.focus?.join() === 'p1' && bodyAttach.expression === 'practice' && bodyAttach.openPanel === true,
  JSON.stringify(bodyAttach));

// 清理选区与浮条
await yt.evaluate(() => { document.getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
await yt.waitForFunction(() => !document.getElementById('blc-lookup-pill'), null, { timeout: 4000 });

check('B 零 LLM', (await llmCount()) === 0);

// ============================== C. 真实 YouTube 侧栏列表（可选） ==============================

if (!noVideo) {
  try {
    const real = await browser.newPage();
    real.on('dialog', (d) => d.accept());
    await real.goto('https://www.youtube.com/watch?v=Yf6DJmUt1TA', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await real.waitForFunction(() => Number(document.getElementById('blc-debug')?.getAttribute('data-blc-count')) > 0, null, { timeout: 50000 });
    // 面板以 iframe 注入真实视频页（浮动模式形态：面板与页面同标签页同可见）
    await real.evaluate((src) => {
      const iframe = document.createElement('iframe');
      iframe.id = 'test-panel';
      iframe.src = src;
      iframe.style.cssText = 'position:fixed;right:0;top:0;width:430px;height:660px;z-index:2147483647;border:0;background:#fff';
      document.body.appendChild(iframe);
    }, `chrome-extension://${extId}/sidepanel.html`);
    let realPanel = null;
    for (let i = 0; i < 50 && !realPanel; i++) {
      realPanel = real.frames().find((f) => f.url().startsWith(`chrome-extension://${extId}/sidepanel.html`)) ?? null;
      if (!realPanel) await real.waitForTimeout(200);
    }
    if (!realPanel) throw new Error('sidepanel iframe not loaded in real page');
    await realPanel.waitForFunction(() => !!document.querySelector('[data-view="subs"]'), null, { timeout: 10000 });
    await realPanel.evaluate(() => document.querySelector('[data-view="subs"]').click());
    await realPanel.waitForFunction(() => !document.getElementById('video-workspace')?.hidden, null, { timeout: 15000 });
    await realPanel.waitForFunction(() => document.getElementById('video-workspace')?.querySelector('aside')?.shadowRoot?.querySelectorAll('[data-cue]').length > 3, null, { timeout: 15000 });
    // 跨字幕项选择：第 2–3 行原文，从首行 .en 开头到次行 .en 中部
    const cross = await realPanel.evaluate(() => {
      const root = document.getElementById('video-workspace').querySelector('aside').shadowRoot;
      const rows = [...root.querySelectorAll('[data-cue]')];
      const enA = rows[1].querySelector('.en');
      const enB = rows[2].querySelector('.en');
      const startNode = enA.firstChild;
      const endNode = enB.childNodes[Math.min(2, enB.childNodes.length - 1)];
      const range = document.createRange();
      range.setStart(startNode, 0);
      range.setEnd(endNode, Math.max(1, Math.floor(endNode.length / 2)));
      const s = document.getSelection();
      s.removeAllRanges();
      s.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return { rows: rows.length, text: range.toString() };
    });
    await realPanel.waitForFunction(() => document.getElementById('panel-selection-actions'), null, { timeout: 5000 });
    const listButtons = await realPanel.evaluate(() => {
      const bar = document.getElementById('panel-selection-actions');
      return { first: bar.querySelector('button')?.textContent, count: bar.querySelectorAll('button').length, hasChat: !!bar.querySelector('.blc-chat-add') };
    });
    check('C 跨字幕项选择：无查词，翻译+添加到对话', listButtons.count >= 2 && listButtons.hasChat && listButtons.first !== '查词', JSON.stringify({ cross: cross?.text?.slice(0, 60), listButtons }));
    await realPanel.evaluate(() => { document.querySelector('#panel-selection-actions .blc-chat-add').click(); });
    await realPanel.waitForFunction(() => !document.getElementById('chat-attachment')?.hidden, null, { timeout: 8000 });
    const crossState = await realPanel.evaluate(async () => {
      const w = await chrome.windows.getCurrent();
      return chrome.runtime.sendMessage({ type: 'chatActive', windowId: w.id });
    });
    const snap = crossState.chat?.snapshots?.at(-1);
    check('C 跨项附加：实际原文+起始时间+视频来源', snap?.label === '跨字幕选段' && typeof snap?.blocks?.[0]?.startMs === 'number' &&
      snap?.source?.sourceType === 'youtube' && !!snap?.source?.video?.videoId &&
      snap.blocks[0].text.length >= 8, JSON.stringify({ label: snap?.label, startMs: snap?.blocks?.[0]?.startMs, text: snap?.blocks?.[0]?.text?.slice(0, 60) }));
    check('C 零 LLM（跨项全程）', (await llmCount()) === 0, `llm=${await llmCount()}`);
    await real.close();
  } catch (error) {
    check('C 真实 YouTube 侧栏列表', false, `SKIP/FAIL ${String(error).slice(0, 160)}`);
  }
} else {
  console.log('SKIP C 真实 YouTube（--no-video）');
}

// ============================== D. 扩展重载后旧标签页不再抛 invalidated ==============
// 复现用户报告：chrome://extensions 重新加载后，已开标签页里残留的旧 content
// script 仍响应选区/查词；事件期调用 runtime.getURL 抛
// "Extension context invalidated"。静态资源地址已在注入期解析（缓存字符串），
// 该路径应完整执行且不产生未捕获错误。

await page.goto('https://example.com/article'); // 先让旧脚本注入，再重载使其成为孤儿
await page.waitForFunction(() => document.documentElement.getAttribute('data-blc-web') === '1', null, { timeout: 10000 });
const orphanErrors = [];
page.on('pageerror', (e) => orphanErrors.push(String(e?.stack ?? e)));
await sw.evaluate(() => chrome.runtime.reload()).catch(() => {}); // 重载即销毁 SW，返回与否不影响
await page.waitForTimeout(1500);
await selectText('#p1', learnAt, learnAt + 7); // learnin（A1 同一选区）
await page.waitForSelector('#blc-lookup-pill', { timeout: 5000 }).catch(() => {});
await page.click('#lookup').catch(() => {});
const popupAfterReload = await page.waitForSelector('#blc-lookup-popup .expr', { timeout: 5000 }).then(() => true, () => false);
check('D 扩展重载后旧页查词路径完整执行', popupAfterReload);
// 词卡内关闭（closePopup → cancelOnline）与卡外点击（外关监听 + 浮动面板
// notify 上报）都是事件期扩展调用路径，孤儿状态下逐一走过
await page.click('#blc-lookup-popup .act.ghost', { timeout: 3000 }).catch(() => {});
await selectText('#p1', learnAt, learnAt + 7);
await page.waitForSelector('#blc-lookup-pill', { timeout: 5000 }).catch(() => {});
await page.click('#lookup').catch(() => {});
await page.waitForSelector('#blc-lookup-popup .expr', { timeout: 5000 }).catch(() => {});
await page.mouse.click(8, 420); // 卡外空白处：外关监听 + notify 上报
await page.waitForTimeout(600);
check('D 扩展重载后旧页无 Extension context invalidated 报错',
  orphanErrors.filter((e) => e.includes('Extension context invalidated')).length === 0,
  orphanErrors.join(' | ').slice(0, 400));

writeFileSync(join(output, 'results.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`RESULT ${results.length - failed}/${results.length}`);
if (!process.env.KEEP_PROFILE) { try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows 句柄延迟，留给系统清理 */ } }
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
