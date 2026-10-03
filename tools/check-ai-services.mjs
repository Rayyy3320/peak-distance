// Real MV3 storage, UI and background; controlled provider responses and permission decisions.
import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import assert from 'node:assert/strict';
const profile=mkdtempSync(join(tmpdir(),'pd-ai-'));
const output=resolve('.upstream/ai-services');mkdirSync(output,{recursive:true});
const extension=resolve('.output/chrome-mv3');
const context=await chromium.launchPersistentContext(profile,{executablePath:process.env.BLC_CHROME||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],viewport:{width:420,height:950}});
context.setDefaultTimeout(10000);
const results=[],errors=[];
context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
const check=(name,ok)=>{results.push({name,ok:!!ok});console.log(`${ok?'PASS':'FAIL'} ${name}`);assert.ok(ok,name);};
try {
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const id=new URL(worker.url()).host;
  await worker.evaluate(async()=>{
    await chrome.storage.local.set({deepseekApiKey:'fixture-legacy'});
    chrome.permissions.contains=async()=>true;
    globalThis.__requests=[];
    globalThis.fetch=async(url,init)=>{
      const body=JSON.parse(init.body);const protocol=String(url).includes('/messages')?'anthropic':String(url).includes(':generateContent')||String(url).includes(':streamGenerateContent')?'gemini':'openai';
      globalThis.__requests.push({url:String(url),body,headers:init.headers});
      const text=JSON.stringify(body).includes('JSON 数组')?'["译文"]':'释义：陪伴\n语境：用于当前原句';
      if(body.stream||String(url).includes(':streamGenerateContent')){
        const payload=protocol==='anthropic'?{type:'content_block_delta',delta:{type:'text_delta',text:'受控回答'}}:protocol==='gemini'?{candidates:[{content:{parts:[{text:'受控回答'}]},finishReason:'STOP'}]}:{choices:[{delta:{content:'受控回答'}}]};
        return new Response('data: '+JSON.stringify(payload)+'\n\n'+(protocol==='anthropic'?'data: {"type":"message_stop"}\n\n':protocol==='openai'?'data: [DONE]\n\n':''),{headers:{'content-type':'text/event-stream'}});
      }
      return Response.json(protocol==='anthropic'?{content:[{type:'text',text}],stop_reason:'end_turn'}:protocol==='gemini'?{candidates:[{content:{parts:[{text}]},finishReason:'STOP'}]}:{choices:[{message:{content:text},finish_reason:'stop'}]});
    };
  });
  const page=await context.newPage();
  await page.addInitScript(()=>{
    window.__allowPermission=true;window.__origins=[];
    chrome.permissions.request=async p=>{window.__origins.push(...p.origins);return window.__allowPermission;};
  });
  await page.goto(`chrome-extension://${id}/sidepanel.html#settings`);
  await page.waitForFunction(()=>document.body&&!document.body.inert);
  await page.locator('#state').filter({hasText:'已配置'}).waitFor();
  check('旧 DeepSeek Key 无需重填',await page.locator('#key').inputValue()===''&&(await page.locator('#key').getAttribute('placeholder')).includes('已保存'));
  const send=m=>page.evaluate(m=>chrome.runtime.sendMessage(m),m);
  const snap={source:'web',expression:'with',sentence:'Stay with me.',url:'https://example.com',title:'Fixture'};
  for(const provider of ['deepseek','openai','anthropic','gemini','glm','kimi']){
    await page.locator('#ai-provider').selectOption(provider);
    check(`${provider} 预设无需展开高级设置`,!await page.locator('#ai-model').isVisible());
    if(provider!=='deepseek')await page.locator('#key').fill('fixture-'+provider);
    await page.locator('#save').click();await page.locator('#state').filter({hasText:'已保存并启用'}).waitFor();
    const state=await worker.evaluate(async()=> (await chrome.storage.local.get('aiServices')).aiServices);
    check(`${provider} 选择加 Key 完成持久化`,state.active===provider&&!!state.profiles[provider].baseUrl&&!!state.profiles[provider].model&&!!state.profiles[provider].apiKey);
    const explanation=await send({type:'explainContext',snapshot:snap,requestId:provider});
    check(`${provider} 解释使用对应服务与来源`,explanation.ok&&explanation.provider===provider&&explanation.model===state.profiles[provider].model);
    const translated=await send({type:'translateCues',mode:'ai',videoId:'fixture',trackId:'en',items:[{id:9,text:'Stay with me.'}],requestId:provider+'-translation'});
    check(`${provider} AI 翻译保留字幕 ID`,translated.ok&&translated.translations[0]?.id===9);
    await page.getByRole('button',{name:'AI 问答',exact:true}).click();
    await page.locator('#chat-input').fill('hello '+provider);await page.locator('#chat-send').click();
    await page.locator('#chat-list .msg.user').last().filter({hasText:'hello '+provider}).waitFor();
    await page.waitForFunction(()=>{const m=document.querySelectorAll('#chat-list .msg.assistant');return m.length&&m[m.length-1].querySelector('.state.done');});
    check(`${provider} 流式回答完成`,await page.locator('#chat-list .a-text').last().innerText()==='受控回答');
    await page.locator('#open-settings').click();
  }
  const requestChecks=await worker.evaluate(()=>globalThis.__requests.every(r=>{
    const expected=r.url.includes('moonshot')?'kimi':r.url.includes('bigmodel')?'glm':r.url.includes('anthropic')?'anthropic':r.url.includes('googleapis')?'gemini':r.url.includes('openai')?'openai':'legacy';
    const key=r.headers.Authorization?.replace('Bearer ','')??r.headers['x-api-key']??r.headers['x-goog-api-key'];
    return key==='fixture-'+expected;
  }));check('服务切换不会串用其他服务的 Key',requestChecks);
  await page.locator('#ai-provider').selectOption('custom');
  await page.locator('#ai-url').fill('https://compatible.example/v1');await page.locator('#ai-model').fill('custom-model');await page.locator('#key').fill('fixture-custom');
  await page.evaluate(()=>window.__allowPermission=false);await page.locator('#save').click();await page.locator('#state').filter({hasText:'配置未更改'}).waitFor();
  check('拒绝权限保留旧服务和输入',await page.locator('#key').inputValue()==='fixture-custom'&&await worker.evaluate(async()=> (await chrome.storage.local.get('aiServices')).aiServices.active)==='kimi');
  await page.evaluate(()=>window.__allowPermission=true);await page.locator('#save').click();await page.locator('#state').filter({hasText:'已保存并启用'}).waitFor();
  check('自定义服务按所选域请求权限',await page.evaluate(()=>window.__origins.at(-1)==='https://compatible.example/*'));
  await page.locator('#ai-advanced summary').click(); // custom stays expanded after save; collapse for default view
  for(const width of [400,800]){await page.setViewportSize({width,height:1000});await page.locator('#ai-provider').selectOption('glm');await page.locator('#ai-provider').scrollIntoViewIfNeeded();await page.screenshot({path:join(output,`settings-${width}.png`)});}
  await page.locator('#ai-provider').selectOption('custom');await page.locator('#ai-url').fill('https://different.example/v1');await page.locator('#save').click();
  await page.locator('#state').filter({hasText:'API Key'}).waitFor();check('更改地址必须重新填写对应 Key',true);
  await page.locator('#ai-provider').selectOption('deepseek');await page.locator('#clear').click();await page.locator('#state').filter({hasText:'已清除'}).waitFor();
  check('清除旧服务 Key 不从 legacy 字段复活',await worker.evaluate(async()=> (await chrome.storage.local.get('aiServices')).aiServices.profiles.deepseek.apiKey===''));
  check('普通设置不向内容脚本返回任何服务凭据',!JSON.stringify(await send({type:'getSettings'})).includes('fixture-'));
  check('无页面脚本异常',!errors.length);
} finally {
  writeFileSync(join(output,'results.json'),JSON.stringify({results,errors},null,2));
  await context.close();const safe=resolve(profile);if(safe.startsWith(resolve(tmpdir())+sep)&&safe.includes('pd-ai-'))rmSync(safe,{recursive:true,force:true});
}
