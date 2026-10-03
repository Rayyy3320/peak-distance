import assert from 'node:assert/strict';
import { AI_PRESETS, aiCacheScope, defaultAiProfile, normalizeAiBaseUrl, readAiServices, validateAiProfile, type AiConfig, type AiProvider } from '../shared/aiConfig';
import { buildAiRequest, parseAiResponse, parseAiStreamEvent } from '../lib/aiTransport';
import { chatCompletionStream, lookupExpression, translateSentences } from '../lib/aiClient';

const config = (provider: AiProvider): AiConfig => ({...defaultAiProfile(provider),provider,apiKey:'fixture-key'});
const legacy = readAiServices({deepseekApiKey:' legacy-fixture '});
assert.equal(legacy.profiles.deepseek?.apiKey,'legacy-fixture');
assert.equal(readAiServices({aiServices:{active:'deepseek',profiles:{deepseek:defaultAiProfile('deepseek')}},deepseekApiKey:'old'}).profiles.deepseek?.apiKey,'');
for(const url of ['http://example.com/v1','https://user:secret@example.com','https://example.com/?key=secret','https://example.com/#key']) assert.throws(()=>normalizeAiBaseUrl(url));
assert.equal(normalizeAiBaseUrl('https://example.com/v1/chat/completions/'),'https://example.com/v1');
assert.notEqual(aiCacheScope(config('deepseek')),aiCacheScope(config('kimi')));
assert.notEqual(aiCacheScope(config('openai')),aiCacheScope({...config('openai'),model:'another'}));
assert.ok(!aiCacheScope(config('openai')).includes('fixture-key'));
let allowed=true;
(globalThis as any).browser={permissions:{contains:async()=>allowed}};
const originalFetch=globalThis.fetch;
try {
  for(const provider of Object.keys(AI_PRESETS).filter(p=>p!=='custom') as AiProvider[]) {
    const c=config(provider);
    assert.equal(validateAiProfile(c),null);
    const messages=[{role:'system' as const,content:'system'},{role:'user' as const,content:'hello'},{role:'assistant' as const,content:'answer'},{role:'user' as const,content:'again'}];
    const request=buildAiRequest(c,messages,false,100);
    assert.ok(!request.url.includes(c.apiKey));
    if(c.protocol==='anthropic'){assert.equal(request.headers['x-api-key'],c.apiKey);assert.equal(request.body.system,'system');assert.equal(request.body.messages?.length,3);}
    if(c.protocol==='gemini'){assert.equal(request.headers['x-goog-api-key'],c.apiKey);assert.equal(request.body.contents?.[1]?.role,'model');assert.equal(request.body.systemInstruction?.parts[0]?.text,'system');}
    if(c.protocol==='openai') assert.equal(request.headers.Authorization,`Bearer ${c.apiKey}`);
    let sent=0;
    globalThis.fetch=async(url,init)=>{
      sent++;assert.ok(String(url).startsWith(c.baseUrl));assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');
      const body=JSON.parse(String(init?.body));
      if(c.protocol!=='gemini') assert.equal(body.model,c.model);
      const text=JSON.stringify(body).includes('JSON 数组')?'["一","","三"]':'释义：一起\n语境：在当前语境中表示陪伴';
      return Response.json(c.protocol==='openai'?{choices:[{message:{content:text},finish_reason:'stop'}]}:c.protocol==='anthropic'?{content:[{type:'thinking',thinking:'private'},{type:'text',text}],stop_reason:'end_turn'}:{candidates:[{content:{parts:[{thought:true,text:'private'},{text}]},finishReason:'STOP'}]});
    };
    const lookup=await lookupExpression(c,{expression:'with',sentence:'Stay with me.'});
    assert.ok(lookup.ok);if(lookup.ok){assert.equal(lookup.provider,provider);assert.equal(lookup.model,c.model);assert.equal(lookup.definition,'一起');}
    const translated=await translateSentences(c,['one','two','three']);
    assert.ok(translated.ok);if(translated.ok)assert.deepEqual(translated.translations,[{id:0,text:'一'},{id:2,text:'三'}]);
    allowed=false;const denied=await lookupExpression(c,{expression:'with',sentence:'Stay.'});assert.ok(!denied.ok&&denied.error==='permission');assert.equal(sent,2);allowed=true;
    const events=c.protocol==='openai'?[{choices:[{delta:{reasoning_content:'private'}}]},{choices:[{delta:{content:'你好'}}]},'[DONE]']:c.protocol==='anthropic'?[{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'private'}},{type:'content_block_delta',delta:{type:'text_delta',text:'你好'}},{type:'message_stop'}]:[{candidates:[{content:{parts:[{thought:true,text:'private'}]}}]},{candidates:[{content:{parts:[{text:'你好'}]},finishReason:'STOP'}]}];
    const bytes=new TextEncoder().encode(events.map(e=>'data: '+(typeof e==='string'?e:JSON.stringify(e))+'\n\n').join(''));
    globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=7)controller.enqueue(bytes.slice(i,i+7));controller.close();}}));
    let streamed='';const stream=await chatCompletionStream(c,messages,{signal:new AbortController().signal,onText:t=>streamed=t});assert.ok(stream.ok);assert.equal(streamed,'你好');
    globalThis.fetch=async()=>new Response('data: {"error":{"message":"failed"}}\n\n');
    const failed=await chatCompletionStream(c,messages,{signal:new AbortController().signal});assert.ok(!failed.ok&&failed.error==='bad-response');
    globalThis.fetch=async()=>new Response('',{status:401});
    const auth=await lookupExpression(c,{expression:'with',sentence:'Stay.'});assert.ok(!auth.ok&&auth.error==='auth');
    console.log(`PASS ${provider}: 请求、释义、字幕、流式、错误与权限`);
  }
  assert.equal(parseAiResponse('gemini',{candidates:[{content:{parts:[{thought:true,text:'private'}]}}]}).content,null);
  assert.equal(['Hello',' ','world','\n','Next'].map(text=>parseAiStreamEvent('gemini',JSON.stringify({candidates:[{content:{parts:[{text}]}}]})).content).join(''),'Hello world\nNext');
  assert.equal(parseAiStreamEvent('anthropic','{"type":"ping"}').content,null);
  console.log('PASS 旧 Key 兼容、清除不回退、地址校验与缓存隔离');
} finally {globalThis.fetch=originalFetch;}
