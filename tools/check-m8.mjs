// Real MV3 contexts and browser UI; controlled page/media and service responses.
// --live-translation additionally checks the actual regular translation endpoint.
import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import assert from 'node:assert/strict';

const profile=mkdtempSync(join(tmpdir(),'pd-m8-'));
const output=resolve('.upstream/m8');mkdirSync(output,{recursive:true});
const extension=resolve('.output/chrome-mv3');
const context=await chromium.launchPersistentContext(profile,{
  executablePath:process.env.BLC_CHROME||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true,
  proxy:{server:process.env.BLC_PROXY||'http://127.0.0.1:7890'},
  args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--autoplay-policy=no-user-gesture-required'],viewport:{width:1280,height:900},
});
context.setDefaultTimeout(12000);
const results=[],errors=[];
context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
const check=(name,value)=>{results.push({name,ok:!!value});console.log(`${value?'PASS':'FAIL'} ${name}`);assert.ok(value,name);};
const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
const id=new URL(worker.url()).host;
const panelUrl=`chrome-extension://${id}/sidepanel.html`;
const control=await context.newPage();await control.goto(`chrome-extension://${id}/options.html`);
const send=m=>control.evaluate(m=>chrome.runtime.sendMessage(m),m);
const paragraph='Learning a language helps us understand the world. '.repeat(8)+'\nKeep the Original Case and the final sentence.';
const article=`<!doctype html><html><head><title>Language and the world</title></head><body><h1>Language and the world</h1><p id="text" style="white-space:pre-wrap;max-width:680px">${paragraph}</p><p id="short">A different sentence.</p><p id="fail">FAIL translating this sentence.</p></body></html>`;
const videoHtml=`<!doctype html><html><head><title>Learning in context</title></head><body style="margin:24px;background:#13181e;color:white;font-family:system-ui"><ytd-watch-flexy><div id="player-container-outer" style="aspect-ratio:16/9"><div id="movie_player" style="position:relative;width:100%;height:100%;background:linear-gradient(90deg,#f1e8ce,#163343)"><video style="width:100%;height:100%"></video><div class="ytp-chrome-bottom" style="position:absolute;bottom:0;right:0;height:40px"><div class="ytp-right-controls" style="height:100%"></div></div></div></div></ytd-watch-flexy><script>
const v=document.querySelector('video'),bytes=new Uint8Array(44+8000*2*30),d=new DataView(bytes.buffer);const str=(at,s)=>[...s].forEach((c,i)=>bytes[at+i]=c.charCodeAt(0));str(0,'RIFF');d.setUint32(4,bytes.length-8,true);str(8,'WAVE');str(12,'fmt ');d.setUint32(16,16,true);d.setUint16(20,1,true);d.setUint16(22,1,true);d.setUint32(24,8000,true);d.setUint32(28,16000,true);d.setUint16(32,2,true);d.setUint16(34,16,true);str(36,'data');d.setUint32(40,bytes.length-44,true);v.src=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));
window.addEventListener('message',e=>{const m=e.data;if(m?.source!=='blc-content')return;if(m.type==='config'){window.__nonce=m.nonce;window.postMessage({source:'blc-inject',type:'cues',nonce:m.nonce,videoId:'m8test01',trackId:'https://www.youtube.com/api/timedtext?v=m8test01&lang=en',trackLang:'en',trackKind:'manual',seen:1,cues:[{start:0,dur:3000,lastOff:0,text:'Run, run home.'},{start:3000,dur:3000,lastOff:0,text:'Home is a good place to learn.'}]},'*');}if(m.type==='translation-request')window.postMessage({...m,source:'blc-inject',type:'translation',nonce:window.__nonce,cues:[]},'*');});
</script></body></html>`;
async function select(page,selector){await page.locator(selector).evaluate(el=>{const r=document.createRange();r.selectNodeContents(el);const s=getSelection();s.removeAllRanges();s.addRange(r);document.dispatchEvent(new Event('selectionchange'));});}
try {
  if(process.argv.includes('--live-translation')){
    const live=await send({type:'translateSelection',text:'Learning a language opens a window to the world.',requestId:'live-check'});
    check('真实常规翻译返回中文',live.ok&&/[\u4e00-\u9fff]/.test(live.text));
  }
  await worker.evaluate(()=>{
    const fetchOriginal=globalThis.fetch.bind(globalThis);globalThis.__requests=[];
    globalThis.fetch=async(input,init)=>{
      const url=String(input);globalThis.__requests.push(url);
      if(url.includes('translate.googleapis.com')){
        const text=new URL(url).searchParams.get('q')??'';
        if(text.startsWith('FAIL')&&!globalThis.__retryOK)return new Response('',{status:503});
        if(text.startsWith('SLOW'))await new Promise(r=>setTimeout(r,600));
        return new Response(JSON.stringify([[['学习语言让我们理解世界。'+(text.includes('different')?'另一句话。':''),text]]]),{status:200,headers:{'content-type':'application/json'}});
      }
      if(url.includes('dict.youdao')||url.includes('dictionary.cambridge'))return new Response('',{status:503});
      if(url.includes('api.deepseek.com'))return new Response(new ReadableStream({start(controller){const encoder=new TextEncoder();setTimeout(()=>controller.enqueue(encoder.encode('data: '+JSON.stringify({choices:[{delta:{content:'受控回答：学习语言。'.repeat(200)}}]})+'\n\n')),200);setTimeout(()=>{controller.enqueue(encoder.encode('data: [DONE]\n\n'));controller.close();},1200);}}),{headers:{'content-type':'text/event-stream'}});
      return fetchOriginal(input,init);
    };
  });
  await context.route('https://example.com/*',r=>r.fulfill({contentType:'text/html',body:article}));
  await context.route('https://x.com/example/status/123',r=>r.fulfill({contentType:'text/html',body:article}));
  const page=await context.newPage();await page.goto('https://example.com/article');await page.locator('html[data-blc-web]').waitFor();
  await select(page,'#text');await page.getByRole('button',{name:'翻译',exact:true}).click();
  await page.locator('#pd-translation #result').filter({hasText:'学习语言'}).waitFor();
  check('长段落保留大小写、换行和结尾',await page.locator('#pd-translation #original').innerText()===paragraph);
  const request=await worker.evaluate(()=>globalThis.__requests.find(u=>u.includes('translate.googleapis.com')));
  check('完整选区直接发给翻译服务',new URL(request).searchParams.get('q')===paragraph);
  check('翻译未请求词典或 AI',!(await worker.evaluate(()=>globalThis.__requests)).some(u=>/deepseek|dict.youdao|dictionary.cambridge/.test(u)));
  await page.screenshot({path:join(output,'translation.png')});
  await page.getByRole('button',{name:'关闭翻译'}).click();
  await select(page,'#fail');await page.getByRole('button',{name:'翻译',exact:true}).click();
  await page.locator('#pd-translation #result').filter({hasText:'限制访问'}).waitFor();
  check('失败保留原文与重试',await page.locator('#pd-translation #retry').isEnabled());
  await worker.evaluate(()=>globalThis.__retryOK=true);await page.locator('#pd-translation #retry').click();await page.locator('#pd-translation #result').filter({hasText:'学习语言'}).waitFor();check('失败后可重试成功',true);
  await page.getByRole('button',{name:'关闭翻译'}).click();
  await page.locator('#text').evaluate(el=>el.textContent='Long text '.repeat(600));await select(page,'#text');await page.getByRole('button',{name:'翻译',exact:true}).click();
  await page.locator('#pd-translation #result').filter({hasText:'缩小选区'}).waitFor();check('超限明确提示而不消失或截断',true);await page.getByRole('button',{name:'关闭翻译'}).click();
  await page.locator('#short').evaluate(el=>el.textContent='SLOW translating this sentence.');await select(page,'#short');await page.getByRole('button',{name:'翻译',exact:true}).click();await page.evaluate(()=>history.pushState({},'','/next'));await page.locator('#pd-translation').waitFor({state:'detached'});check('SPA 导航取消旧翻译浮层',true);

  // M10: old selection stays suppressed; outside clicks continue their original action.
  await page.evaluate(()=>{const b=document.createElement('button');b.id='outside';b.textContent='Outside action';b.onclick=()=>{globalThis.__outside=(globalThis.__outside??0)+1;};document.body.append(b);const input=document.createElement('input');input.id='outside-input';document.body.append(input);});
  const selectWord=async()=>page.locator('#short').evaluate(el=>{el.textContent='different';const r=document.createRange();r.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(r);document.dispatchEvent(new Event('selectionchange'));});
  await selectWord();await page.getByRole('button',{name:'查词',exact:true}).click();await page.locator('#blc-lookup-popup .card').waitFor();
  await control.evaluate(()=>chrome.runtime.sendMessage({type:'panelOutsideClick',at:0}));check('迟到的跨框关闭不关掉新词卡',await page.locator('#blc-lookup-popup').count()===1);
  await page.waitForTimeout(650);check('打开词卡后旧选区入口不重现',await page.locator('#blc-lookup-pill').count()===0);
  const wordHead=await page.locator('#blc-lookup-popup .expr').boundingBox();await page.mouse.move(wordHead.x+20,wordHead.y+10);await page.mouse.down();await page.mouse.move(20,20,{steps:5});await page.mouse.up();check('卡内开始并结束在卡外的拖动不误关',await page.locator('#blc-lookup-popup').count()===1);
  await page.locator('#outside').click();check('词卡外部点击关闭且原按钮执行一次',await page.locator('#blc-lookup-popup').count()===0&&await page.evaluate(()=>__outside)===1);
  await page.locator('#short').evaluate(el=>el.textContent='A new selected sentence.');await select(page,'#short');await page.getByRole('button',{name:'翻译',exact:true}).click();await page.locator('#pd-translation').waitFor();await page.locator('#outside-input').click();check('翻译卡外部点击关闭并保留输入框焦点',await page.locator('#pd-translation').count()===0&&await page.evaluate(()=>document.activeElement.id)==='outside-input');
  const tabId=await control.evaluate(async()=> (await chrome.tabs.query({active:true,currentWindow:true}))[0].id);
  check('浮动扩展工作区加载完成',(await control.evaluate(id=>chrome.tabs.sendMessage(id,{type:'pd-panel-show'},{frameId:0}),tabId)).ok);
  const frame=page.frames().find(f=>f.url().includes('/sidepanel.html'));
  await frame.getByRole('button',{name:'设置',exact:true}).click();
  const pageCount=context.pages().length;
  await frame.locator('#key').fill('m8-disposable-test-key');await frame.locator('#save').click();await frame.locator('#state').filter({hasText:'已保存'}).waitFor();
  check('面板内设置不创建标签页',context.pages().length===pageCount);
  check('key 输入保存后清空',await frame.locator('#key').inputValue()==='');
  check('宿主无法读取扩展 iframe',await page.locator('#pd-floating-panel iframe').evaluate(el=>el.contentDocument===null));
  check('普通设置快照不含 key',!JSON.stringify(await send({type:'getSettings'})).includes('m8-disposable-test-key'));
  await frame.locator('#markingEnabled').uncheck();await frame.locator('#online-state').filter({hasText:'已保存'}).waitFor();
  check('设置写入实际存储',(await send({type:'getSettings'})).settings.markingEnabled===false);
  await frame.locator('#settings-back').click();
  await frame.getByRole('button',{name:'AI 问答',exact:true}).click();
  await frame.locator('#chat-input').fill('Preserve this draft across both panel modes.');
  const cdp=await context.newCDPSession(page);
  await frame.getByRole('button',{name:'切换为固定侧栏'}).click();
  let target;for(let i=0;i<40&&!target;i++){target=(await cdp.send('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&t.url===panelUrl);if(!target)await new Promise(r=>setTimeout(r,100));}
  assert.ok(target,'native panel target');
  let {sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});let nextId=1;const pending=new Map();
  cdp.on('Target.receivedMessageFromTarget',e=>{if(e.sessionId!==sessionId)return;const m=JSON.parse(e.message);const cb=pending.get(m.id);if(cb){pending.delete(m.id);cb(m);}});
  const nativeCommand=(method,params={})=>new Promise((resolve,reject)=>{const n=nextId++;pending.set(n,m=>m.error?reject(Error(m.error.message)):resolve(m.result));void cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:n,method,params})}).catch(reject);});
  const nativeEval=async expression=>{const r=await nativeCommand('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
  for(let i=0;i<40;i++){if(await nativeEval('document.body&&!document.body.inert&&document.querySelector("#chat-input")?.value.includes("Preserve this draft")'))break;await new Promise(r=>setTimeout(r,100));}
  check('固定模式恢复草稿',await nativeEval('document.querySelector("#chat-input")?.value.includes("Preserve this draft")'));
  check('原生侧栏真实打开且恢复草稿',await page.locator('#pd-floating-panel').isHidden());
  const shot=await nativeCommand('Page.captureScreenshot',{format:'png'});writeFileSync(join(output,'native-panel.png'),Buffer.from(shot.data,'base64'));
  await nativeEval('document.querySelector("#chat-input").value="Updated draft in native panel.";document.querySelector("#chat-input").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#open-settings").click();document.querySelector("#panel-mode").click();');
  await page.locator('#pd-floating-panel').waitFor({state:'visible'});
  await frame.locator('#view-settings').waitFor({state:'visible'});
  await frame.locator('#settings-back').click();
  await frame.waitForFunction(()=>document.querySelector('#chat-input').value==='Updated draft in native panel.');
  check('回到浮动模式保留最新草稿',(await frame.locator('#chat-input').inputValue())==='Updated draft in native panel.');
  const oldDocument=(await frame.evaluate(()=>chrome.runtime.sendMessage({type:'panelContext'}))).documentId;
  await page.locator('#pd-floating-panel iframe').evaluate(el=>el.src='about:blank');
  await page.locator('#pd-floating-panel .retry').waitFor({state:'visible'});await page.waitForTimeout(300);
  check('旧 ready 随文档失效且无自动重载',page.frames().some(f=>f.url()==='about:blank'));
  let releaseStall;await context.route('https://example.com/stalled-workspace',async route=>{await new Promise(done=>{releaseStall=done;});await route.abort().catch(()=>{});});
  await page.locator('#pd-floating-panel iframe').evaluate(el=>{const observer=new MutationObserver(()=>{if(el.src.includes('/sidepanel.html')){observer.disconnect();el.src='https://example.com/stalled-workspace';}});observer.observe(el,{attributes:true,attributeFilter:['src']});});
  await page.locator('#pd-floating-panel .retry').click();await page.locator('#pd-floating-panel .status-text').filter({hasText:'未能就绪'}).waitFor();check('重试加载再次失败后仍能继续重试',await page.locator('#pd-floating-panel .retry').isVisible());releaseStall?.();
  await page.locator('#pd-floating-panel .retry').click();await page.frameLocator('#pd-floating-panel iframe').locator('#chat-input').waitFor();
  await frame.waitForFunction(()=>document.querySelector('#chat-input').value==='Updated draft in native panel.');
  const recoveredDocument=(await frame.evaluate(()=>chrome.runtime.sendMessage({type:'panelContext'}))).documentId;
  check('手动恢复新 iframe 文档并保留未发送输入',!!recoveredDocument&&oldDocument!==recoveredDocument);
  const diagnostic=await worker.evaluate(tabId=>chrome.storage.session.get(`panel-diagnostics:${tabId}`),tabId);
  check('浮动诊断记录真实文档失效且不包含输入正文',JSON.stringify(diagnostic).includes('document-missing')&&!JSON.stringify(diagnostic).includes('Updated draft'));

  await frame.getByRole('button',{name:'设置',exact:true}).click();await frame.locator('#clear').click();
  await frame.locator('#state').filter({hasText:'已清除'}).waitFor();await frame.locator('#settings-back').click();

  for(const [i,word]of ['journey','understand'].entries())await send({type:'save',snapshot:{source:'web',expression:word,sentence:`Every ${word} begins with a single step.`,url:'https://example.com/article',title:'A journey'},definition:'从语境中理解新的表达'});
  await frame.getByRole('button',{name:'生词本',exact:true}).click();await frame.locator('.entry').first().waitFor();await page.waitForTimeout(200);await page.screenshot({path:join(output,'vocabulary.png')});
  await frame.getByRole('button',{name:'原句复习 →'}).click();await frame.getByRole('button',{name:'揭示',exact:true}).click();
  await frame.getByRole('button',{name:'设置',exact:true}).click();await frame.locator('#settings-back').click();
  check('设置往返保留复习揭示状态',await frame.getByRole('button',{name:'下一条',exact:true}).isVisible());
  await page.screenshot({path:join(output,'review.png')});
  await page.goto('https://x.com/example/status/123');await page.locator('html[data-blc-web]').waitFor();
  const hostWindow=await control.evaluate(async()=>(await chrome.windows.getCurrent()).id);await control.waitForFunction(async w=>(await chrome.runtime.sendMessage({type:'chatActive',windowId:w})).chat.draft==='',hostWindow);check('承载网页关闭丢弃未发送输入',true);await select(page,'#short');await page.getByRole('button',{name:'翻译',exact:true}).click();await page.locator('#pd-translation #result').filter({hasText:'另一句话'}).waitFor();check('X 选区翻译',true);

  await context.route('https://www.youtube.com/watch?v=m8test01',r=>r.fulfill({contentType:'text/html',body:videoHtml}));
  await page.goto('https://www.youtube.com/watch?v=m8test01');await page.locator('#blc-subs .en').waitFor();await page.locator('#blc-subs .zh').waitFor();
  check('普通模式字幕在视频下方',await page.locator('#blc-subs').evaluate(el=>el.getBoundingClientRect().top>=document.getElementById('movie_player').getBoundingClientRect().bottom));
  await page.locator('#blc-subs-switch #learning').click();await page.locator('#blc-subs-switch #panel').click();await page.locator('#pd-floating-panel').waitFor({state:'visible'});
  await page.frameLocator('#pd-floating-panel iframe').locator('.brand-name').waitFor();
  const videoFrame=page.frames().find(f=>f.url().includes('/sidepanel.html'));await videoFrame.locator('#blc-learning-panel .row').first().waitFor();
  // 非全屏：浮动面板可向下移动到播放器以下（不被钳在播放器上方）。
  // 受控 headless 中指针捕获跨扩展 iframe 派发不全，用产品自带的方向键移动验证同一钳制路径。
  {
    const panelBox=page.locator('#pd-floating-panel');
    const handle=page.locator('#pd-floating-panel .drag');
    const before=await panelBox.evaluate(el=>el.getBoundingClientRect().top);
    await handle.click();
    for(let i=0;i<14;i++) await handle.press('ArrowDown');
    const after=await panelBox.evaluate(el=>el.getBoundingClientRect().top);
    check('浮动面板非全屏可向下移动到播放器下方',after>before+80&&after>100,`before=${before} after=${after}`);
    for(let i=0;i<12;i++) await handle.press('ArrowLeft');
  }
  const sentenceBounds=await videoFrame.locator('#blc-learning-panel .row').nth(1).locator('.en').boundingBox();
  await page.mouse.move(sentenceBounds.x+1,sentenceBounds.y+sentenceBounds.height/2);await page.mouse.down();await page.mouse.move(sentenceBounds.x+sentenceBounds.width-2,sentenceBounds.y+sentenceBounds.height/2,{steps:15});await page.mouse.up();
  await videoFrame.locator('#panel-selection-actions').getByRole('button',{name:'翻译',exact:true}).click();await videoFrame.locator('#pd-translation #result').filter({hasText:'学习语言'}).waitFor();check('面板字幕选区绑定所选句时间',(await videoFrame.locator('#pd-translation #source').getAttribute('href')).includes('t=3'));
  await videoFrame.getByRole('button',{name:'关闭翻译'}).click();await videoFrame.evaluate(()=>getSelection().removeAllRanges());
  await page.mouse.move(10,10);await page.evaluate(()=>document.querySelector('video').play());await videoFrame.locator('#blc-learning-panel .w').first().hover();await videoFrame.locator('#blc-lookup-popup .compact').waitFor();check('面板字幕悬停就地查词并暂停',await page.evaluate(()=>document.querySelector('video').paused));
  await videoFrame.locator('#blc-learning-panel .w').first().click();await page.mouse.click(10,10);await videoFrame.locator('#blc-lookup-popup').waitFor({state:'detached'});check('网页点击关闭自有 iframe 内词卡',true);await page.waitForFunction(()=>!document.querySelector('video').paused);check('关闭面板词卡恢复插件造成的暂停',true);await page.evaluate(()=>{document.querySelector('video').pause();document.querySelector('video').currentTime=0;});
  await videoFrame.getByRole('button',{name:'词语',exact:true}).click();await videoFrame.getByRole('button',{name:'Run · 2 次',exact:true}).waitFor();check('视频全部词汇与词次仍可用',true);
  await videoFrame.getByRole('button',{name:'字幕',exact:true}).click();await videoFrame.getByRole('button',{name:'收藏整句',exact:true}).first().click();
  await videoFrame.getByRole('button',{name:'问 AI',exact:true}).first().click();const quoteRow=videoFrame.locator('#chat-attachment-focus').filter({hasText:'焦点：'});await quoteRow.waitFor();const quoteText=await quoteRow.textContent();await videoFrame.locator('#chat-input').fill('Temporary input with material and quote.');await videoFrame.getByRole('button',{name:'生词本',exact:true}).click();await videoFrame.getByRole('button',{name:'AI 问答',exact:true}).click();check('模块往返保留输入材料与引用',await videoFrame.locator('#chat-input').inputValue()==='Temporary input with material and quote.'&&await quoteRow.textContent()===quoteText);
  await videoFrame.getByRole('button',{name:'切换为固定侧栏'}).click();
  let quoteTarget;for(let i=0;i<40&&!quoteTarget;i++){quoteTarget=(await cdp.send('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&t.url===panelUrl);if(!quoteTarget)await new Promise(r=>setTimeout(r,100));}
  assert.ok(quoteTarget);sessionId=(await cdp.send('Target.attachToTarget',{targetId:quoteTarget.targetId,flatten:false})).sessionId;
  for(let i=0;i<40;i++){if(await nativeEval('document.body&&!document.body.inert&&[...document.querySelectorAll("#chat-attachment-focus")].some(n=>n.textContent.includes("焦点："))'))break;await new Promise(r=>setTimeout(r,100));}
  const nativeQuote=await nativeEval('[...document.querySelectorAll("#chat-attachment-focus")].find(n=>n.textContent.includes("焦点："))?.textContent');

  check('输入材料引用一起跨模式保留',nativeQuote===quoteText&&await nativeEval('document.querySelector("#chat-input").value')==='Temporary input with material and quote.');
  await nativeEval('document.querySelector("#panel-mode").click()');await page.locator('#pd-floating-panel').waitFor({state:'visible'});await videoFrame.getByRole('button',{name:'当前内容',exact:true}).click();
  await videoFrame.getByRole('button',{name:'已保存',exact:true}).click();await videoFrame.getByText('Run, run home.',{exact:true}).waitFor();check('整句收藏进入同一学习库',(await send({type:'listSentences'})).sentences.length===1);
  await page.screenshot({path:join(output,'youtube-workspace.png')});
  await page.evaluate(()=>document.querySelector('video').play());await page.locator('#blc-subs .w').first().hover();await page.locator('#blc-lookup-popup .compact').waitFor();check('字幕悬停暂停仍有效',await page.evaluate(()=>document.querySelector('video').paused));
  await page.locator('#blc-subs .w').first().click();await videoFrame.getByRole('button',{name:'设置',exact:true}).click();await page.locator('#blc-lookup-popup').waitFor({state:'detached'});check('自有 iframe 点击关闭网页词卡',true);await videoFrame.locator('#settings-back').click();check('外部关闭恢复播放',!await page.evaluate(()=>document.querySelector('video').paused));
  await page.locator('#blc-subs-switch #learning').click();check('AP 默认关闭',!await page.locator('#blc-subs-switch #ap').isChecked());await page.locator('#blc-subs-switch #ap').check();
  await page.evaluate(()=>{const v=document.querySelector('video');v.currentTime=2.7;v.play();});await page.waitForFunction(()=>document.querySelector('video').paused);
  check('AP 在句末暂停',await page.evaluate(()=>document.querySelector('video').currentTime>=3&&document.querySelector('video').currentTime<3.5));
  await page.evaluate(()=>document.querySelector('video').play());await page.waitForTimeout(150);check('AP 继续播放不重复暂停',!await page.evaluate(()=>document.querySelector('video').paused));await page.locator('#blc-subs-switch #ap').uncheck();await page.locator('#blc-subs-switch #learning').click();
  await page.evaluate(()=>document.querySelector('video').pause());
  await page.locator('#movie_player').evaluate(el=>el.requestFullscreen());await page.waitForFunction(()=>!!document.fullscreenElement);
  check('进入全屏面板默认收起',await page.locator('#pd-floating-panel').isHidden());
  check('全屏无大面积实色底板',await page.locator('#blc-subs .wrap').evaluate(el=>getComputedStyle(el).backgroundColor==='rgba(0, 0, 0, 0)'));
  await page.screenshot({path:join(output,'fullscreen.png')});
  await page.locator('#blc-subs-switch #learning').click();await page.locator('#blc-subs-switch #panel').click();await page.locator('#pd-floating-panel').waitFor({state:'visible'});
  check('全屏移交保留未发送输入',await page.frameLocator('#pd-floating-panel iframe').locator('#chat-input').inputValue()==='Temporary input with material and quote.');
  check('全屏面板挂载在可见全屏节点',await page.locator('#pd-floating-panel').evaluate(el=>document.fullscreenElement.contains(el)));
  await page.frameLocator('#pd-floating-panel iframe').locator('.brand-name').waitFor();
  const fullFrame=page.frames().find(f=>f.url().includes('/sidepanel.html'));await fullFrame.getByRole('button',{name:'切换为固定侧栏'}).click();check('全屏固定入口不退出全屏',await page.evaluate(()=>!!document.fullscreenElement));
  await page.locator('#blc-subs .en').evaluate(el=>el.textContent='A long sentence that requires additional space in the subtitle area. '.repeat(5));
  await page.waitForTimeout(150);check('字幕增高后面板仍避让',await page.locator('#pd-floating-panel').evaluate(el=>el.getBoundingClientRect().bottom<=document.getElementById('blc-subs').getBoundingClientRect().top));
  await fullFrame.getByRole('button',{name:'关闭面板'}).click();check('关闭面板保留视频全屏',await page.evaluate(()=>!!document.fullscreenElement));
  await page.evaluate(()=>document.exitFullscreen());
  await control.goto(panelUrl);for(const width of [320,400,600]){await control.setViewportSize({width,height:820});await control.getByRole('button',{name:'设置',exact:true}).click();await control.screenshot({path:join(output,`settings-${width}.png`)});check(`设置 ${width}px 无横向溢出`,await control.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  check('运行无页面异常',errors.length===0);
  check('常规学习流程未调用 AI',!(await worker.evaluate(()=>globalThis.__requests)).some(u=>u.includes('api.deepseek.com')));
  await worker.evaluate(async()=>{const {aiServices}=await chrome.storage.local.get('aiServices');aiServices.profiles[aiServices.active].apiKey='m8-disposable-stream-key';await chrome.storage.local.set({aiServices});});
  await control.getByRole('button',{name:'AI 问答',exact:true}).click();await control.locator('#chat-input').fill('解释这句英文');await control.locator('#chat-send').click();await control.locator('#chat-list .msg.user').last().waitFor();
  await control.locator('#views [data-view="list"]').click();
  const windowId=await control.evaluate(async()=>(await chrome.windows.getCurrent()).id);
  let active;for(let i=0;i<40;i++){active=await send({type:'chatActive',windowId});if(active.chat?.messages.at(-1)?.state==='done')break;await new Promise(r=>setTimeout(r,100));}
  check('离开问答视图不中断后台生成',active.chat?.messages.at(-1)?.state==='done'&&active.chat.messages.at(-1).text.includes('受控回答'));
  check('发送后清除待发送引用',active.chat.pendingQuote===null);
  await control.getByRole('button',{name:'AI 问答',exact:true}).click();await control.locator('#chat-list').evaluate(el=>el.scrollTop=120);await control.waitForTimeout(100);const messageTop=await control.locator('#chat-list').evaluate(el=>el.scrollTop);
  await control.getByRole('button',{name:'设置',exact:true}).click();await control.locator('#settings-back').click();check('设置往返保留问答阅读位置',messageTop>0&&Math.abs(await control.locator('#chat-list').evaluate(el=>el.scrollTop)-messageTop)<2);
  await control.locator('#chat-input').fill('Discard this edit on native close.');
  await control.evaluate(async()=>{const windowId=(await chrome.windows.getCurrent()).id;await chrome.storage.session.set({[`panel-host:${windowId}`]:{mode:'fixed'}});await chrome.sidePanel.open({windowId});});
  await control.evaluate(async()=>chrome.sidePanel.close({windowId:(await chrome.windows.getCurrent()).id}));
  await control.waitForFunction(async()=>{const w=(await chrome.windows.getCurrent()).id;return (await chrome.runtime.sendMessage({type:'chatActive',windowId:w})).chat.draft==='';});
  check('原生侧栏关闭事件丢弃未发送内容并保留已提交问题',(await send({type:'chatActive',windowId})).chat.messages.length>0);
  await worker.evaluate(()=>chrome.storage.local.remove(['aiServices','deepseekApiKey']));
} catch(error) {
  console.log('PAGE ERRORS',errors);
  const failedPage=context.pages().find(p=>p.url().includes('youtube.com'))??context.pages().at(-1);
  await failedPage?.screenshot({path:join(output,'failure.png')}).catch(()=>{});
  if(failedPage)console.log('FRAME STATES',await Promise.all(failedPage.frames().filter(f=>f.url().includes('/sidepanel')).map(f=>f.evaluate(async()=>({draft:document.querySelector('#chat-input').value,record:(await chrome.runtime.sendMessage({type:'chatActive',windowId:(await chrome.windows.getCurrent()).id})).chat?.draft,visible:document.visibilityState})))));
  throw error;
} finally {
  writeFileSync(join(output,'results.json'),JSON.stringify({results,errors},null,2));
  await context.close();
  const target=resolve(profile),tempRoot=resolve(tmpdir())+sep;
  if(target.startsWith(tempRoot)&&target.includes('pd-m8-'))rmSync(target,{recursive:true,force:true,maxRetries:3});
}
