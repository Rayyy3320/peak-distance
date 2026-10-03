// M6 产品扩展验收；隔离 profile。BLC_SETTINGS_PATH 可指定本扩展已有设置目录。
// 网络记录不含请求头或 key；测试材料均为本文件中的公开/合成文本。
import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';

const extension = resolve('.output/chrome-mv3');
const profile = mkdtempSync(join(tmpdir(), 'blc-m6-'));
const output = resolve(process.argv.includes('--m10') ? '.upstream/m10' : '.upstream/m6');
mkdirSync(output, { recursive: true });
const settingsPath = process.env.BLC_SETTINGS_PATH;
if (settingsPath) {
  const dest = join(profile, 'Default', 'Local Extension Settings', basename(settingsPath));
  mkdirSync(dest, { recursive: true });
  cpSync(settingsPath, dest, { recursive: true, filter: p => basename(p) !== 'LOCK' });
}
const m10Only = process.argv.includes('--m10');
const results = [];
const networkEvents = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  writeFileSync(join(output, 'results.json'), JSON.stringify(results, null, 2));
}
const options = {
  executablePath: process.env.BLC_CHROME || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true, proxy: { server: process.env.BLC_PROXY || 'http://127.0.0.1:7890' },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required'],
  viewport: { width: 440, height: 850 },
};
let browser;
let sw;
let panel;
let extId;
async function launch() {
  browser = await chromium.launchPersistentContext(profile, options);
  browser.on('request', r => { if (/dict.youdao.com|dictionary.cambridge.org|translate.googleapis.com|api.deepseek.com/.test(r.url())) networkEvents.push({ url: r.url(), method: r.method(), at: Date.now() }); });
  sw = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  extId = new URL(sw.url()).host;
  panel = await browser.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  panel.on('dialog', d => d.accept());
  await panel.waitForFunction(() => !!document.querySelector('[data-view="chat"]'));
}
async function send(message) { return panel.evaluate(async m => chrome.runtime.sendMessage({windowId:(await chrome.windows.getCurrent()).id,...m}), message); }
const snapshot = (expression, sentence = 'I went to the bank.') => ({ source: 'web', expression, sentence, title: 'M6 acceptance', url: 'https://example.com/m6' });
async function instrument() {
  await sw.evaluate(() => {
    globalThis.__network = []; globalThis.__mode = 'real';
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const address = String(url);
      const llm = address.includes('api.deepseek.com');
      globalThis.__network.push({ url: address, llm, body: llm ? JSON.parse(init.body || '{}') : undefined, mode: globalThis.__mode });
      if (globalThis.__mode === 'fail' && !llm) throw new TypeError('M6 controlled failure');
      if (globalThis.__mode === 'chat-stub' && llm) {
        if (!JSON.parse(init.body || '{}').stream) return Response.json({ choices: [{ message: { content: '["受控字幕译文"]' }, finish_reason: 'stop' }] });
        if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({ start(controller) {
          const first = setTimeout(() => controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"受控回答 [p1]"}}]}\n\n')), 800);
          const last = setTimeout(() => { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); }, 4000);
          init.signal?.addEventListener('abort', () => { clearTimeout(first); clearTimeout(last); controller.error(new DOMException('aborted', 'AbortError')); }, { once: true });
        } }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return original(url, init);
    };
  });
}
async function waitChat(id, state = 'done') {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const chat = (await send({ type: 'chatGet', chatId: id })).chat;
    if (chat?.messages.at(-1)?.state === state) return chat;
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`chat ${id} did not reach ${state}: ${JSON.stringify((await send({ type: 'chatGet', chatId: id })).chat?.messages.at(-1))}`);
}
async function uiSend(question, accepted = true) {
  await panel.locator('#chat-input').fill(question);
  await panel.locator('#chat-send').click();
  if (accepted) await panel.waitForFunction(q => document.querySelector('#chat-list .msg.user:last-of-type .q')?.textContent === q || [...document.querySelectorAll('#chat-list .msg.user .q')].at(-1)?.textContent === q, question);
}

try {
  await launch();
  const keyExists = await sw.evaluate(async () => !!(await chrome.storage.local.get('deepseekApiKey')).deepseekApiKey);
  check('隔离配置加载已有 key（不显示凭据）', keyExists || !settingsPath);
  await instrument();
  // 旧 schema 迁移在另一个空测试数据库里准备；绝不接触用户数据库。
  await panel.close();
  await sw.evaluate(async () => {
    await new Promise((resolve, reject) => { const r = indexedDB.deleteDatabase('blc-learning'); r.onsuccess = resolve; r.onerror = reject; });
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('blc-learning', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('entries', { keyPath: 'key' }).put({ key: 'go', expression: 'go', kind: 'word', status: 'learning', forms: ['went'], createdAt: 1, updatedAt: 1 });
        const contexts = db.createObjectStore('contexts', { keyPath: 'id', autoIncrement: true }); contexts.createIndex('entryKey', 'entryKey');
        contexts.put({ id: 7, entryKey: 'go', sentence: 'He went home.', definition: '他回家了', sourceType: 'web', url: 'https://example.com/legacy', title: 'Legacy', createdAt: 1 });
        const source = { sourceType: 'article', sourceKey: 'web:legacy', title: 'Legacy', url: 'https://example.com/legacy' };
        db.createObjectStore('chats', { keyPath: 'sourceKey' }).put({ sourceKey: source.sourceKey, source, snapshots: [{ version: 1, label: '旧材料', createdAt: 1, blocks: [{ id: 'p1', text: 'Old sentence.' }] }], messages: [
          { id: 'u1', role: 'user', turnId: 't1', text: '旧问题', at: 1, snapshotVersion: 1, quote: { blockIds: ['p1'] } },
          { id: 'a1', role: 'assistant', turnId: 't1', text: '旧回答 [p1]', at: 2, state: 'done', retained: true },
        ], draft: '旧草稿', pendingQuote: { blockIds: ['p1'] }, updatedAt: 2 });
      };
      request.onsuccess = () => { request.result.close(); resolve(); }; request.onerror = reject;
    });
  });
  panel = await browser.newPage(); await panel.goto(`chrome-extension://${extId}/sidepanel.html`); panel.on('dialog', d => d.accept());
  const legacy = (await send({ type: 'chatGet', chatId: 'legacy:web:legacy' })).chat;
  check('迁移保留正文、草稿、引用、保留标记及快照来源', legacy?.draft === '旧草稿' && legacy.messages[1].retained && legacy.snapshots[0].source.sourceKey === 'web:legacy' && legacy.pendingQuote.blockIds[0] === 'p1');
  const oldEntry = (await send({ type: 'getEntry', key: 'went' })).entry;
  check('迁移保留词条键、上下文 ID 与旧词形', oldEntry?.key === 'go' && oldEntry.contexts[0].id === 7 && oldEntry.contexts[0].definition === '他回家了');

  if (!m10Only) {
  const originalKey = await sw.evaluate(async () => (await chrome.storage.local.get('deepseekApiKey')).deepseekApiKey);
  await sw.evaluate(() => chrome.storage.local.remove('deepseekApiKey'));
  const keyless = await send({ type: 'lookup', snapshot: snapshot('book'), requestId: 'keyless' });
  const keylessTranslation = await send({ type: 'translateCues', mode: 'regular', videoId: 'test', trackId: 'test', items: [{ id: 88, text: 'It is sunny today.' }] });
  check('冷缓存无 key 的真实查词和字幕翻译', keyless.ok && keylessTranslation.ok && keylessTranslation.translations[0]?.id === 88);
  if (originalKey) await sw.evaluate(key => chrome.storage.local.set({ deepseekApiKey: key }), originalKey);
  for (const expression of ['run', 'bank', 'went', 'take off', 'in spite of', 'a surprisingly good result', 'zzzxxyynotaword']) {
    const r = await send({ type: 'lookup', snapshot: snapshot(expression), requestId: expression });
    const expected = expression === 'zzzxxyynotaword' ? !r.ok && r.error === 'not-found' : r.ok && r.result.kind === (expression === 'a surprisingly good result' ? 'translation' : 'dictionary');
    check(`真实在线查询 ${expression}`, expected, r.ok ? JSON.stringify(r.result.kind === 'dictionary' ? { source: r.result.entry.source, head: r.result.entry.headword, sense: r.result.entry.senses[0].definition } : r.result) : r.error);
  }
  const before = await sw.evaluate(() => __network.length);
  await send({ type: 'lookup', snapshot: snapshot('run'), requestId: 'run-cache' });
  check('重复查询命中会话缓存', await sw.evaluate(() => __network.length) === before);
  const explicit = await send({ type: 'lookup', snapshot: snapshot('take off'), source: 'cambridge', requestId: 'explicit' });
  check('显式换词典得到剑桥完整短语', explicit.ok && explicit.result.entry.source === 'cambridge' && explicit.result.entry.headword.includes('take'));
  const translated = await send({ type: 'translateCues', mode: 'regular', videoId: 'test', trackId: 'track', items: [{ id: 37, text: 'The plane took off.' }] });
  check('常规字幕保留稳定 ID', translated.ok && translated.translations[0]?.id === 37, JSON.stringify(translated));
  await sw.evaluate(() => { __mode = 'fail'; });
  await send({ type: 'lookup', snapshot: snapshot('controllednetworkfailure'), requestId: 'fail' });
  await send({ type: 'translateCues', mode: 'regular', videoId: 'test', trackId: 'track', items: [{ id: 99, text: 'Controlled unavailable subtitle.' }] });
  check('已配 key 的常规成功/无词条/网络失败均零 LLM', await sw.evaluate(() => __network.filter(n => n.llm).length) === 0 && networkEvents.every(n => !n.url.includes('api.deepseek.com')));
  await sw.evaluate(() => { __mode = 'real'; });

  }
  const emptySaved = await send({ type: 'save', snapshot: snapshot('late', 'Original sentence.') });
  await send({ type: 'backfillResult', contextId: emptySaved.contextId, result: { kind: 'translation', source: 'google-gtx', text: '原句译文' } });
  await send({ type: 'save', snapshot: snapshot('late', 'Another sentence.') });
  let entry = (await send({ type: 'getEntry', key: 'late' })).entry;
  check('结果只补写原保存上下文', entry.contexts.find(c => c.sentence === 'Original sentence.').result?.text === '原句译文' && !entry.contexts.find(c => c.sentence === 'Another sentence.').result);
  await send({ type: 'deleteEntry', key: 'late' });
  const late = await send({ type: 'backfillResult', contextId: emptySaved.contextId, result: { kind: 'translation', source: 'google-gtx', text: '迟到' } });
  check('删除后迟到补写不复活记录', late.filled === false && !(await send({ type: 'getEntry', key: 'late' })).entry);

  await panel.locator('[data-view="chat"]').click();
  await panel.waitForFunction(() => document.querySelector('#chat-head .chat-title'));
  let active = await send({ type: 'chatActive', windowId: await panel.evaluate(async () => (await chrome.windows.getCurrent()).id) });
  let id = active.chat.id;
  const historyBefore = (await send({type:"chatRecent"})).chats.length;
  for (let i=0;i<3;i++) await panel.getByRole("button",{name:"新对话",exact:true}).click();
  await panel.waitForTimeout(3200);
  check("连续新建和轮询不新增历史", (await send({type:"chatRecent"})).chats.length===historyBefore);
  const windowId = await panel.evaluate(async () => (await chrome.windows.getCurrent()).id);
  const storedKey = await sw.evaluate(async () => (await chrome.storage.local.get('deepseekApiKey')).deepseekApiKey || null);
  await sw.evaluate(() => chrome.storage.local.remove('deepseekApiKey'));
  await uiSend('无 key 草稿', false);
  await panel.waitForFunction(() => document.getElementById('chat-meta-error').textContent.includes('key'));
  check('无 key 保留草稿与设置入口', await panel.locator('#chat-input').inputValue() === '无 key 草稿' && await panel.locator('#chat-settings').isVisible());
  await sw.evaluate(key => chrome.storage.local.set({ deepseekApiKey: key || 'm6-controlled-key' }), storedKey);
  await sw.evaluate(() => { __mode = 'chat-stub'; });
  await panel.locator('#chat-input').fill('x'.repeat(4001));await panel.locator('#chat-send').click();
  check('超长问题不新增历史且保留输入',(await send({type:'chatRecent'})).chats.length===historyBefore&&(await panel.locator('#chat-input').inputValue()).length===4001);
  check('未配置首次发送不写空记录',(await send({type:'chatRecent'})).chats.length===historyBefore);
  await sw.evaluate(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='conversations'){IDBObjectStore.prototype.put=put;throw new Error('M10 controlled commit failure');}return put.apply(this,args);};});
  await uiSend('提交失败临时问题',false);
  await panel.waitForFunction(()=>document.getElementById('chat-meta-error').textContent.includes('保存失败'));
  check('本地提交失败保留输入且历史不变',await panel.locator('#chat-input').inputValue()==='提交失败临时问题'&&(await send({type:'chatRecent'})).chats.length===historyBefore);
  await uiSend('普通问题');
  id=(await send({type:'chatActive',windowId})).chat.id;
  check('首次发送只新增一个带首问会话',(await send({type:'chatRecent'})).chats.length===historyBefore+1 && (await send({type:'chatGet',chatId:id})).chat.messages[0].text==='普通问题');
  await panel.waitForFunction(() => document.getElementById('chat-list').innerText.includes('正在准备回答'));
  check('首次发送不误报中断', !(await panel.locator('#chat-list').innerText()).includes('已中断'));
  await panel.locator('#views [data-view="list"]').click();
  await waitChat(id);
  check('切侧栏视图不中止生成', (await send({ type: 'chatGet', chatId: id })).chat.messages.at(-1).state === 'done');
  await panel.locator('[data-view="chat"]').click();
  const blank = await browser.newPage(); await blank.goto('about:blank');
  await panel.waitForTimeout(1700);
  check('切浏览器标签页不切会话', (await send({ type: 'chatActive', windowId })).chat.id === id);
  await uiSend('空白标签页问题'); await waitChat(id);
  let lastFree = await sw.evaluate(() => __network.filter(n => n.llm).at(-1).body.messages.at(-1).content);
  check('空白标签页可发送普通问题', lastFree === '空白标签页问题');
  await browser.route('https://example.com/m6-chinese', route => route.fulfill({ contentType: 'text/html', body: '<html lang="zh"><body><main><p>这是一段用于验收的中文网页。</p></main></body></html>' }));
  await blank.goto('https://example.com/m6-chinese');
  await uiSend('中文页面普通问题'); await waitChat(id);
  lastFree = await sw.evaluate(() => __network.filter(n => n.llm).at(-1).body.messages.at(-1).content);
  check('中文页面直接问答且不自动附加页面', lastFree === '中文页面普通问题');
  await blank.goto('chrome://version');
  await uiSend('不可注入页面问题'); await waitChat(id);
  check('不可注入页面可发送普通问题', await sw.evaluate(() => __network.filter(n => n.llm).at(-1).body.messages.at(-1).content) === '不可注入页面问题');
  const materialA = { sourceType: 'article', sourceKey: 'web:a', title: 'Material A', url: 'https://example.com/a' };
  await send({ type: 'chatEnsure', chatId: id, windowId, source: materialA, material: { label: 'A', blocks: [{ id: 'p1', text: 'MATERIAL_A_SECRET_TEST' }] }, quote: { blockIds: ['p1'] } });
  await panel.waitForFunction(() => document.getElementById('chat-head').innerText.includes('Material A'));
  await uiSend('材料 A 问题'); await waitChat(id);
  await panel.getByRole('button', { name: '移除材料', exact: true }).click();
  await uiSend('移除后问题'); await waitChat(id);
  let lastBody = await sw.evaluate(() => __network.filter(n => n.llm).at(-1).body);
  check('移除材料后实际请求没有原文、引用和材料问答', !JSON.stringify(lastBody).includes('MATERIAL_A_SECRET_TEST') && !JSON.stringify(lastBody).includes('材料 A 问题') && !lastBody.messages.at(-1).content.includes('材料：'));
  await send({ type: 'chatEnsure', chatId: id, windowId, source: { ...materialA, sourceKey: 'web:b', title: 'Material B' }, material: { label: 'B', blocks: [{ id: 'p1', text: 'MATERIAL_B_TEXT' }] }, quote: { blockIds: ['p1'] } });
  await panel.waitForFunction(() => document.getElementById('chat-head').innerText.includes('Material B'));
  await uiSend('材料 B 问题'); await waitChat(id);
  await panel.locator('.cite').first().click();
  check('同名引用块按原消息快照解析', (await panel.locator('#chat-cite-panel').innerText()).includes('MATERIAL_A_SECRET_TEST'));
  await panel.screenshot({ path: join(output, 'chat.png') });
  await panel.getByRole('button', { name: '新对话', exact: true }).click();
  await panel.waitForFunction(() => document.querySelector('#chat-list').innerText.includes('从一句话'));
  let second = (await send({ type: 'chatActive', windowId })).chat;
  check('新会话身份独立且引用面板清空', second.id !== id && await panel.locator('#chat-cite-panel').isHidden());
  await send({ type: 'chatEnsure', chatId: second.id, windowId, source: materialA, material: { label: 'A', blocks: [{ id: 'p1', text: 'MATERIAL_A_SECRET_TEST' }] }, quote: { blockIds: ['p1'] } });
  await panel.waitForTimeout(1700);
  check('附加材料与引用不持久化',second.id===''&&(await send({type:'chatRecent'})).chats.length===historyBefore+1);
  await panel.locator('#chat-input').fill('临时编辑');
  await panel.getByRole('button',{name:'历史',exact:true}).click();
  await panel.waitForFunction(()=>document.querySelector('.chat-recent-row'));
  const originalRow=panel.locator('.chat-recent-row').filter({hasText:'普通问题'});
  await originalRow.getByRole('button',{name:'Delete',exact:true}).click();
  await panel.waitForTimeout(3200);
  check('轮询保留行内确认与输入',await originalRow.getByRole('button',{name:'Confirm',exact:true}).isVisible()&&await panel.locator('#chat-input').inputValue()==='临时编辑');
  await originalRow.getByRole('button',{name:'Cancel delete'}).click();
  await originalRow.locator('.chat-tool').click();
  await panel.waitForFunction(()=>document.getElementById('chat-input').value==='');
  check('成功换会话丢弃未发送材料引用并恢复已提交材料', !(await panel.locator('#chat-head').innerText()).includes('引用：') && (await send({type:'chatActive',windowId})).chat.source.title==='Material B');
  await panel.getByRole('button',{name:'新对话',exact:true}).click();
  await panel.waitForFunction(()=>document.querySelector('#chat-list').innerText.includes('从一句话'));
  await send({type:'chatEnsure',windowId,source:materialA,material:{label:'A',blocks:[{id:'p1',text:'MATERIAL_A_SECRET_TEST'}]},quote:{blockIds:['p1']}});
  await panel.waitForTimeout(1600);
  await uiSend('停止测试');
  second=(await send({type:'chatActive',windowId})).chat;
  check('同一材料首次发送产生独立会话',second.id!==id&&second.id!==''&&(await send({type:'chatGet',chatId:id})).chat.messages.length>0);
  await panel.waitForFunction(() => document.getElementById('chat-stop').hidden === false);
  await panel.locator('#chat-stop').click();
  await waitChat(second.id, 'stopped'); await panel.waitForTimeout(2600);
  check('停止后迟到结果不写回', (await send({ type: 'chatGet', chatId: second.id })).chat.messages.at(-1).state === 'stopped');
  await panel.getByRole('button', { name: '重试', exact: true }).click();
  const retried = await waitChat(second.id);
  check('停止后重试使用新尝试且不重复用户问题', retried.messages.filter(m => m.role === 'user').length === 1);
  await uiSend('删除中生成');
  await panel.waitForFunction(() => !document.getElementById('chat-stop').hidden);
  await panel.getByRole('button',{name:'清空',exact:true}).click();
  await panel.getByRole('button',{name:'Confirm',exact:true}).click();
  await panel.waitForTimeout(4500);
  check('清空后迟到结果不能恢复旧消息', (await send({ type: 'chatGet', chatId: second.id })).chat === null && (await send({type:'chatActive',windowId})).chat.id==='');
  await uiSend('保留停止记录');
  second=(await send({type:'chatActive',windowId})).chat;
  await panel.waitForFunction(() => !document.getElementById('chat-stop').hidden);
  await panel.locator('#chat-stop').click();
  await waitChat(second.id, 'stopped');
  await panel.locator('#chat-input').fill('重启草稿'); await panel.waitForTimeout(700);
  // 真 AI：只发送公开、最小测试文本，不发送用户页面/历史。
  if (storedKey && !m10Only) {
    await sw.evaluate(() => { __mode = 'real'; });
    const ai = await send({ type: 'explainContext', snapshot: snapshot('bank', 'I went to the bank to deposit money.'), requestId: 'real-ai' });
    check('显式 AI 解释真实请求', ai.ok && !!(ai.definition || ai.note), ai.ok ? [ai.definition, ai.note].join(' ').slice(0, 180) : ai.error);
  } else if (!m10Only) check('显式 AI 解释真实请求', false, '未找到已配置 key');
  // 受控 YouTube 页面，运行完整 MV3 消息路由；不作为真实视频观看证据。
  await browser.route('https://www.youtube.com/watch?v=m6test*', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="movie_player"><video></video></div></body></html>' }));
  if (!m10Only) {
  const controlled = await browser.newPage();
  await controlled.addInitScript(() => {
    window.addEventListener('message', event => {
      const d = event.data;
      if (d?.source === 'blc-content' && d.type === 'config') window.__nonce = d.nonce;
      if (d?.source === 'blc-content' && d.type === 'translation-request') window.postMessage({ ...d, source: 'blc-inject', type: 'translation', nonce: window.__nonce, cues: [] }, '*');
    });
  });
  async function controlledCues(videoId) {
    await controlled.goto(`https://www.youtube.com/watch?v=${videoId}`);
    await controlled.waitForFunction(() => typeof window.__nonce === 'number');
    await controlled.evaluate(videoId => {
      window.postMessage({ source: 'blc-inject', type: 'cues', videoId, nonce: window.__nonce, trackKind: 'manual', trackLang: 'en', trackId: 'https://www.youtube.com/api/timedtext?lang=en&name=m6', cues: [{ start: 0, dur: 10000, lastOff: 1, text: 'Controlled missing subtitle for explicit mode.' }] }, '*');
      document.querySelector('video').currentTime = 1;
    }, videoId);
  }
  await sw.evaluate(() => { __mode = 'fail'; });
  const initialAI = await sw.evaluate(() => __network.filter(n => n.llm).length);
  await controlledCues('m6test01');
  await controlled.getByRole('button', { name: '用 AI 翻译', exact: true }).waitFor();
  check('字幕常规失败出现显式 AI 操作且无自动 LLM', await sw.evaluate(() => __network.filter(n => n.llm).length) === initialAI);
  await sw.evaluate(() => { __mode = 'chat-stub'; });
  await controlled.getByRole('button', { name: '用 AI 翻译', exact: true }).click();
  await controlled.locator('#blc-subs .zh').waitFor();
  check('点击一次 AI 后才发出请求且不改变默认', await sw.evaluate(() => __network.filter(n => n.llm).length) === initialAI + 1 && (await send({ type: 'getSettings' })).settings.translationMode === 'regular');
  await sw.evaluate(() => { __mode = 'fail'; });
  await controlledCues('m6test02');
  await controlled.getByRole('button', { name: '用 AI 翻译', exact: true }).waitFor();
  check('换视频后临时 AI 选择失效', await sw.evaluate(() => __network.filter(n => n.llm).length) === initialAI + 1);
  await controlled.close();
  await sw.evaluate(() => { __mode = 'real'; });
  // 真实网页上的保存标记回归，包括刷新与开关还原。
  const article = await browser.newPage();
  try {
    await article.goto('https://en.wikipedia.org/wiki/Procrastination', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await article.waitForSelector('html[data-blc-web="1"]', { timeout: 15000 });
    await send({ type: 'save', snapshot: { ...snapshot('procrastination'), sentence: 'Procrastination is the act of delaying.', url: article.url() } });
    await article.waitForFunction(() => [...document.querySelectorAll('#mw-content-text [data-blc-key]')].some(n => /procrastination/i.test(n.textContent)), null, { timeout: 15000 });
    check('真实网页收藏后正文出现标记', await article.locator('#mw-content-text [data-blc-key]').filter({ hasText: /procrastination/i }).count() > 0);
    await article.reload({ waitUntil: 'domcontentloaded' });
    await article.waitForFunction(() => [...document.querySelectorAll('#mw-content-text [data-blc-key]')].some(n => /procrastination/i.test(n.textContent)));
    check('真实网页刷新后标记恢复', true);
    await send({ type: 'setSetting', name: 'markingEnabled', value: false });
    await article.waitForFunction(() => !document.querySelector('[data-blc-key]'));
    check('真实网页关闭标记恢复原文', (await article.locator('body').innerText()).includes('Procrastination'));
    await send({ type: 'setSetting', name: 'markingEnabled', value: true });
  } catch (error) { check('真实网页标记回归', false, String(error).slice(0, 200)); }
  await article.close();
  const opts = await browser.newPage();
  await opts.goto(`chrome-extension://${extId}/options.html`);
  await opts.locator('#translationMode').selectOption('ai');
  await opts.reload();
  await opts.waitForFunction(() => document.getElementById('translationMode').value === 'ai');
  check('设置默认 AI 方式持久化', (await send({ type: 'getSettings' })).settings.translationMode === 'ai');
  await opts.locator('#translationMode').selectOption('regular');
  await opts.locator('#cacheLimit').fill('20'); await opts.locator('#cacheLimit').dispatchEvent('change');
  await opts.waitForFunction(async () => (await chrome.storage.local.get('cacheLimit')).cacheLimit === 20);
  check('缓存容量设置保存', (await send({ type: 'getSettings' })).settings.cacheLimit === 20);
  await opts.close();
  }
  const network = await sw.evaluate(() => __network.map(n => ({ url: n.url, llm: n.llm, mode: n.mode })));
  writeFileSync(join(output, 'network.json'), JSON.stringify({ attempts: network, observed: networkEvents }, null, 2));
  await browser.close();
  await launch();
  const restored = (await send({ type: 'chatGet', chatId: second.id })).chat;
  check('重启丢弃未发送输入并保留停止记录与 key', restored.draft === '' && restored.messages.at(-1).state === 'stopped' && await sw.evaluate(async () => !!(await chrome.storage.local.get('deepseekApiKey')).deepseekApiKey));
  const recent = await send({ type: 'chatRecent' });
  check('重复打开不重复迁移', recent.chats.filter(c => c.chatId === 'legacy:web:legacy').length === 1);
  if (m10Only) {
    await panel.getByRole('button',{name:'AI 问答',exact:true}).click();
    await send({type:'chatSelect',chatId:second.id});await panel.waitForFunction(()=>document.querySelector('#chat-head').innerText.includes('保留停止记录'));
    await panel.locator('#chat-input').fill('Keep current edit while deleting another chat.');
    await panel.getByRole('button',{name:'历史',exact:true}).click();
    await panel.locator('.chat-recent-row').first().waitFor();
    const nonCurrent=panel.locator('.chat-recent-row').filter({hasText:'普通问题'});
    await nonCurrent.getByRole('button',{name:'Delete',exact:true}).click();await nonCurrent.getByRole('button',{name:'Confirm',exact:true}).click();await nonCurrent.waitFor({state:'detached'});
    check('删除非当前会话保留当前输入和会话',await panel.locator('#chat-input').inputValue()==='Keep current edit while deleting another chat.'&&(await send({type:'chatActive'})).chat.id===second.id);
    const current=panel.locator('.chat-recent-row').filter({hasText:'保留停止记录'});
    const transportErrors=[];panel.on('pageerror',e=>transportErrors.push(e.message));
    await panel.evaluate(()=>{const original=chrome.runtime.sendMessage.bind(chrome.runtime);chrome.runtime.sendMessage=(message,callback)=>{if(message.type==='chatDelete'){chrome.runtime.sendMessage=original;throw Error('Controlled transport: Extension context invalidated');}return original(message,callback);};});
    await current.getByRole('button',{name:'Delete',exact:true}).click();await current.getByRole('button',{name:'Confirm',exact:true}).click();await current.getByText('删除失败，请重试').waitFor();
    check('通信抛错失败收尾保留记录、恢复按钮且无未处理 rejection',await current.getByRole('button',{name:'Delete',exact:true}).isEnabled()&&(await send({type:'chatGet',chatId:second.id})).chat!==null&&transportErrors.length===0);

    await sw.evaluate(()=>{const remove=IDBObjectStore.prototype.delete;IDBObjectStore.prototype.delete=function(...args){if(this.name==='conversations'){IDBObjectStore.prototype.delete=remove;throw Error('M10 controlled delete failure');}return remove.apply(this,args);};});
    await current.getByRole('button',{name:'Delete',exact:true}).click();await current.getByRole('button',{name:'Confirm',exact:true}).click();await current.getByText('删除失败，请重试').waitFor();
    check('删除失败保留原记录和未发送输入',(await send({type:'chatGet',chatId:second.id})).chat!==null&&await panel.locator('#chat-input').inputValue()==='Keep current edit while deleting another chat.');
    await panel.waitForTimeout(360);
    for (const width of [320,600]) { await panel.setViewportSize({width,height:850});await panel.screenshot({path:join(output,`delete-default-${width}.png`)}); }
    await current.getByRole('button',{name:'Delete',exact:true}).click();await panel.waitForTimeout(360);await panel.screenshot({path:join(output,'delete-confirm-600.png')});
    await current.getByRole('button',{name:'Confirm',exact:true}).click();await current.waitFor({state:'detached'});await panel.waitForTimeout(3200);
    check('删除当前会话后多个轮询保持空态和历史列表',(await send({type:'chatActive'})).chat.id===''&&await panel.locator('#chat-input').inputValue()===''&&await panel.locator('.chat-recent-list').isVisible());
    for (const c of (await send({type:'chatRecent'})).chats) await send({type:'chatDelete',chatId:c.chatId});
    await panel.waitForTimeout(1700);check('删除最后一条显示历史空态且不补建',(await send({type:'chatRecent'})).chats.length===0&&(await panel.locator('.chat-recent-list').innerText()).includes('还没有历史对话'));

    await panel.evaluate(async()=>{await new Promise((done,fail)=>{const r=indexedDB.open('blc-learning',4);r.onsuccess=()=>{const db=r.result,tx=db.transaction('conversations','readwrite');for(let i=0;i<20;i++)tx.objectStore('conversations').put({id:`m10-old-empty-${i}`,title:'新对话',sourceKey:null,source:null,activeSnapshotVersion:null,snapshots:[],pendingQuote:null,draft:'',messages:[],updatedAt:i+1});tx.oncomplete=()=>{db.close();done();};tx.onerror=fail;};r.onerror=fail;});});
    await panel.waitForFunction(()=>document.querySelector('.chat-history-meta').textContent.includes('20 个对话'));
    await panel.locator('.chat-recent-row').first().getByRole('button',{name:'Delete',exact:true}).click();await panel.locator('.chat-recent-row').first().getByRole('button',{name:'Confirm',exact:true}).click();
    await panel.waitForFunction(()=>document.querySelector('.chat-history-meta').textContent.includes('19 个对话')&&document.querySelector('.chat-history-meta').textContent.includes('已删除'));
    await panel.waitForTimeout(3200);check('同名旧空记录删除反馈明确且数据库恰好减少一条',(await send({type:'chatRecent'})).chats.length===19&&await panel.locator('.chat-recent-row').count()===19);
    for(const record of (await send({type:'chatRecent'})).chats)await send({type:'chatDelete',chatId:record.chatId});
    await sw.evaluate(()=>{__mode='chat-stub';});await uiSend('删除生成记录');const live=(await send({type:'chatActive'})).chat.id;
    await panel.locator('#chat-stop').waitFor({state:'visible'});await send({type:'chatDelete',chatId:live});await panel.waitForTimeout(4500);
    check('删除生成中的会话后迟到结果不能重建',(await send({type:'chatGet',chatId:live})).chat===null&&(await send({type:'chatRecent'})).chats.length===0);
  }
  if (process.argv.includes('--no-video')) console.log('SKIP 真实 YouTube 观看（本次只验收其余链路）');
  // 两条真实 YouTube 轨道：播放、取英文、常规中译；失败保留具体证据。
  await instrument();
  for (const [videoId, kind] of ((m10Only || process.argv.includes('--no-video')) ? [] : [['Yf6DJmUt1TA', 'asr'], ['arj7oStGLkU', 'manual']])) {
    const page = await browser.newPage();
    try {
      await page.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => Number(document.getElementById('blc-debug')?.getAttribute('data-blc-count')) > 0, null, { timeout: 50000 });
      await page.evaluate(async () => { const video = document.querySelector('video'); video.currentTime = 5; await video.play(); });
      await page.waitForFunction(() => document.getElementById('blc-subs')?.shadowRoot?.querySelector('.zh')?.textContent, null, { timeout: 55000 });
      const data = await page.evaluate(() => ({ kind: document.getElementById('blc-debug').getAttribute('data-blc-track'), en: document.getElementById('blc-subs').shadowRoot.querySelector('.en')?.textContent, zh: document.getElementById('blc-subs').shadowRoot.querySelector('.zh')?.textContent, time: document.querySelector('video').currentTime }));
      check(`真实视频 ${kind} 英中字幕与播放`, data.kind === kind && data.en && data.zh && data.time > 5, JSON.stringify(data));
      await page.screenshot({ path: join(output, `video-${kind}.png`) });
    } catch (error) { check(`真实视频 ${kind} 英中字幕与播放`, false, String(error).slice(0, 200) + ' ' + (await page.locator('body').innerText()).slice(0, 800)); await page.screenshot({ path: join(output, `video-${kind}-failure.png`) }); }
    await page.close();
  }
  if (!process.argv.includes('--no-video')) check('真实视频常规字幕零 LLM', await sw.evaluate(() => __network.filter(n => n.llm).length) === 0);
} catch (error) {
  check('验收执行', false, String(error));
  if (panel && !panel.isClosed()) await panel.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
} finally {
  await browser?.close();
  const target = resolve(profile);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('blc-m6-')) throw new Error('Unexpected test profile path');
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  console.log(`RESULT ${results.filter(r => r.ok).length}/${results.length}; evidence ${output}; isolated profile removed`);
  process.exitCode = results.some(r => !r.ok) ? 1 : 0;
}
