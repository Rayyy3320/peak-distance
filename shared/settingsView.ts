import { DEFAULT_SETTINGS, validSetting } from './settings';
import { AI_PRESETS, defaultAiProfile, normalizeAiBaseUrl, readAiServices, validateAiProfile, type AiProfile, type AiProvider, type AiServices, type AiProtocol } from './aiConfig';
import { TARGET_LANGUAGES, langDisplayName, primaryOfLang, type LanguageTag } from './languages';
import { authorizeVaultInPage, pickVaultDirectoryInPage } from '@/lib/vault/fs';
import type { VaultStatus } from './vault';

/** 理解语言候选：中文区分简繁，其余用主标签。 */
const COMPREHENSION_OPTIONS: LanguageTag[] = [
  'zh-Hans', 'zh-Hant', ...TARGET_LANGUAGES.filter((l) => l !== 'zh'),
];

export function mountSettings(root: HTMLElement) {
  root.innerHTML = `<section class="settings-section"><h2>通用设置</h2>
    <label class="settings-field">词汇标记<input id="markingEnabled" type="checkbox"></label>
    <p class="hint">在网页与字幕中识别已收藏、在学和已掌握的词语。</p>
    <label class="settings-field">会话缓存上限<input id="cacheLimit" type="number" min="20" max="500" step="1"></label>
    <p class="hint">只缓存成功查询，最多 500 条，并受 2 MB 文本总量限制。</p></section>
    <section class="settings-section"><h2>语言</h2>
    <label class="settings-field">默认理解语言<select id="defaultComprehensionLang"></select></label>
    <p class="hint">词语解释、句段与字幕译文的目标语言；可按源语言覆盖。界面保持中文。</p>
    <div id="lang-overrides" class="settings-status"></div>
    <div class="settings-actions"><select id="override-source" aria-label="覆盖的源语言"></select><span aria-hidden="true">→</span><select id="override-target" aria-label="该源语言的理解语言"></select><button id="override-add">添加覆盖</button></div>
    <label class="settings-field">无词典结果时自动使用 AI 查词<input id="aiLookupFallback" type="checkbox"></label>
    <p class="hint">仅主动点击查词、词典明确无结果且 AI 已配置时调用；悬停与预览不调用。开关只对本浏览器生效。</p><div id="lang-state" class="settings-status" role="status"></div></section>
    <section class="settings-section"><h2>学习库</h2>
    <p class="hint">Chrome 与 Edge 分别连接同一学习文件夹（可放在 Obsidian 仓库内）。生词本与句子各保存为一份 Markdown，对话按会话保存；同步会写入本机修改并读回共享内容。断开不删除文件。</p>
    <div class="settings-actions"><button id="vault-connect" class="primary">连接学习文件夹</button><button id="vault-disconnect">断开</button><button id="vault-flush">立即同步</button></div>
    <div id="vault-state" class="settings-status" role="status"></div></section>
    <section class="settings-section"><h2>翻译与显示</h2>
    <label class="settings-field">首选词典<select id="primaryDictionary"><option value="youdao">有道</option><option value="cambridge">剑桥英汉</option></select></label>
    <label class="settings-field">备用词典<select id="backupDictionary"><option value="cambridge">剑桥英汉</option><option value="youdao">有道</option></select></label>
    <label class="settings-field">常规翻译来源<select id="regularTranslation"><option value="google-gtx">Google 免费翻译</option></select></label>
    <label class="settings-field">默认翻译方式<select id="translationMode"><option value="regular">常规翻译</option><option value="ai">AI 翻译（LLM）</option></select></label>
    <label class="settings-field">开启双语字幕<input id="bilingualEnabled" type="checkbox"></label>
    <label class="settings-field">显示译文字幕<input id="chineseVisible" type="checkbox"></label>
    <label class="settings-field">字幕字号<select id="subtitleSize"><option value="small">小</option><option value="standard">标准</option><option value="large">大</option></select></label>
    <p class="hint">查词与常规翻译无需 key。配置 key 不会自动切换为 AI。</p><div id="online-state" class="settings-status" role="status"></div></section>
    <section class="settings-section"><h2>AI 服务</h2><p class="hint">选择服务商，填写 API Key 即可用于 AI 解释、翻译和问答。各服务配置仅保存在本机扩展中。</p>
    <fieldset id="ai-fields"><label class="settings-field">服务商<select id="ai-provider"></select></label><p id="ai-current" class="hint"></p>
    <label for="key">API Key</label><input id="key" class="settings-key" type="password" placeholder="输入所选服务的 API Key" autocomplete="off" spellcheck="false">
    <details id="ai-advanced"><summary>高级设置</summary>
      <label class="ai-field">接口格式<select id="ai-protocol"><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic Messages</option><option value="gemini">Gemini 原生</option></select></label>
      <label class="ai-field">API 地址（Base URL）<input id="ai-url" type="url" placeholder="https://api.example.com/v1" spellcheck="false"></label>
      <label class="ai-field">模型 ID<input id="ai-model" type="text" spellcheck="false"></label>
      <p class="hint">预设已包含地址与默认模型。其他兼容服务、不同地区或专属接口可在此修改；模型须在你的 API 账户中可用。</p>
    </details>
    <div class="settings-actions"><button id="save" class="primary">保存并使用</button><button id="clear">清除当前 Key</button></div></fieldset><div id="state" class="settings-status" role="status"></div></section><p id="version" class="hint"></p>`;
  const get = <T extends HTMLElement>(id:string) => root.querySelector<T>(`#${id}`)!;
  const report = (id:string,text:string,ok:boolean) => {const el=get(id);el.textContent=text;el.className=`settings-status ${ok?'ok':'err'}`;};
  let services: AiServices = {active:'deepseek',profiles:{}};
  let selected: AiProvider = 'deepseek';
  const provider = get<HTMLSelectElement>('ai-provider');
  for (const [value, preset] of Object.entries(AI_PRESETS)) {const option=document.createElement('option');option.value=value;option.textContent=preset.label;provider.appendChild(option);}
  const drafts = new Map<AiProvider, {profile:AiProfile;keyInput:string}>();
  function keyHint() {
    const saved=services.profiles[selected];let reusable=false;
    try{reusable=!!saved?.apiKey&&saved.protocol===get<HTMLSelectElement>('ai-protocol').value&&normalizeAiBaseUrl(saved.baseUrl)===normalizeAiBaseUrl(get<HTMLInputElement>('ai-url').value);}catch{/* incomplete URL */}
    get<HTMLInputElement>('key').placeholder=reusable?'已保存；留空保留当前 Key':saved?.apiKey?'地址或接口已变更，请填写对应 Key':'输入所选服务的 API Key';
  }
  function draft(): AiProfile {
    const baseUrl=get<HTMLInputElement>('ai-url').value.trim();
    const protocol=get<HTMLSelectElement>('ai-protocol').value as AiProtocol;
    const saved=services.profiles[selected];
    let reusable=false;
    try {reusable=!!saved&&saved.protocol===protocol&&normalizeAiBaseUrl(saved.baseUrl)===normalizeAiBaseUrl(baseUrl);} catch { /* incomplete URL */ }
    return {protocol,baseUrl,model:get<HTMLInputElement>('ai-model').value.trim(),apiKey:get<HTMLInputElement>('key').value.trim()||(reusable?saved!.apiKey:'')};
  }
  function showProvider() {
    const pending=drafts.get(selected);
    const p=pending?.profile??services.profiles[selected]??defaultAiProfile(selected);
    provider.value=selected;get<HTMLSelectElement>('ai-protocol').value=p.protocol;
    get<HTMLInputElement>('ai-url').value=p.baseUrl;get<HTMLInputElement>('ai-model').value=p.model;
    get<HTMLInputElement>('key').value=pending?.keyInput??'';
    keyHint();
    get<HTMLDetailsElement>('ai-advanced').open=selected==='custom';
    get('ai-current').textContent=`当前使用：${AI_PRESETS[services.active].label} · ${services.profiles[services.active]?.model||'尚未配置'}`;
    report('state',selected===services.active?(services.profiles[selected]?.apiKey?'已配置':'未配置'):'保存后切换至此服务',true);
  }
  provider.addEventListener('change',()=>{drafts.set(selected,{profile:draft(),keyInput:get<HTMLInputElement>('key').value});selected=provider.value as AiProvider;showProvider();});
  get('ai-url').addEventListener('input',keyHint);get('ai-protocol').addEventListener('change',keyHint);
  async function load() {
    try {
      const stored=await browser.storage.local.get([...Object.keys(DEFAULT_SETTINGS),'deepseekApiKey','aiServices']);
      for(const [name,fallback] of Object.entries(DEFAULT_SETTINGS)) {
        if(name==='comprehensionOverrides')continue; // 对象值由覆盖编辑器单独处理
        const control=get<HTMLInputElement|HTMLSelectElement>(name),value=validSetting(name,stored[name])?stored[name]:fallback;
        if(control instanceof HTMLInputElement && control.type==='checkbox')control.checked=!!value;else control.value=String(value);
      }
      renderOverrides(validSetting('comprehensionOverrides',stored.comprehensionOverrides)?(stored.comprehensionOverrides as Record<string,string>):{});
      services=readAiServices(stored);selected=services.active;drafts.clear();showProvider();
    } catch {report('state','设置读取失败，请重新打开设置重试',false);}
  }
  for(const name of Object.keys(DEFAULT_SETTINGS)) {
    if(name==='comprehensionOverrides')continue;
    const control=get<HTMLInputElement|HTMLSelectElement>(name);
    control.addEventListener('change',async()=>{
      const value=control instanceof HTMLInputElement&&control.type==='checkbox'?control.checked:name==='cacheLimit'?Number(control.value):control.value;
      if(!validSetting(name,value)){report('online-state','请检查输入范围',false);return;}
      try{await browser.storage.local.set({[name]:value});report(name==='aiLookupFallback'||name==='defaultComprehensionLang'?'lang-state':'online-state','已保存',true);}catch{report('online-state','保存失败，请重试',false);}
    });
  }

  // ---- 语言：理解语言与按源语言覆盖 ------------------------------------------------
  const fillLangOptions=(select:HTMLSelectElement,includeUnd:boolean)=>{
    select.replaceChildren();
    for(const tag of COMPREHENSION_OPTIONS){const o=document.createElement('option');o.value=tag;o.textContent=langDisplayName(tag);select.appendChild(o);}
    if(includeUnd){const o=document.createElement('option');o.value='und';o.textContent='待确认';select.appendChild(o);}
  };
  fillLangOptions(get<HTMLSelectElement>('defaultComprehensionLang'),false);
  {
    const source=get<HTMLSelectElement>('override-source');
    fillLangOptions(source,true); // 覆盖可针对待确认内容指定目标
    fillLangOptions(get<HTMLSelectElement>('override-target'),false);
  }
  function renderOverrides(overrides:Record<string,string>) {
    const box=get('lang-overrides');box.replaceChildren();
    const entries=Object.entries(overrides);
    if(!entries.length){box.className='hint';box.textContent='尚未设置覆盖。';return;}
    box.className='settings-status';
    for(const [src,target] of entries){
      const row=document.createElement('div');row.className='settings-actions';
      const label=document.createElement('span');label.textContent=`${langDisplayName(src)} → ${langDisplayName(target)}`;row.appendChild(label);
      const remove=document.createElement('button');remove.textContent='移除';
      remove.addEventListener('click',async()=>{
        const stored=await browser.storage.local.get('comprehensionOverrides');
        const next={...(stored.comprehensionOverrides as Record<string,string>)};
        delete next[src];
        await browser.storage.local.set({comprehensionOverrides:next});
        renderOverrides(next);report('lang-state','已移除',true);
      });
      row.appendChild(remove);box.appendChild(row);
    }
  }
  get('override-add').addEventListener('click',async()=>{
    const src=get<HTMLSelectElement>('override-source').value,target=get<HTMLSelectElement>('override-target').value;
    if(primaryOfLang(src)===primaryOfLang(target)){report('lang-state','源语言与理解语言相同，无需覆盖',false);return;}
    const stored=await browser.storage.local.get('comprehensionOverrides');
    const next={...(stored.comprehensionOverrides as Record<string,string>),[src]:target};
    if(!validSetting('comprehensionOverrides',next)){report('lang-state','覆盖无效',false);return;}
    await browser.storage.local.set({comprehensionOverrides:next});
    renderOverrides(next);report('lang-state',`已覆盖：${langDisplayName(src)} → ${langDisplayName(target)}`,true);
  });

  // ---- 学习库：连接 / 断开 / 立即同步 ----------------------------------------------
  let vaultBusy = false;
  let vaultFeedback = '';
  async function refreshVault():Promise<void> {
    if(vaultBusy)return;
    try{
      const r=await browser.runtime.sendMessage({type:'vaultStatus'}) as {ok?:boolean;status?:VaultStatus}|null;
      const s=r?.status;
      if(!s){get('vault-state').textContent='状态读取失败';return;}
      if(!s.connected){get('vault-state').textContent='未连接。';return;}
      const time=s.lastCommitAt?new Date(s.lastCommitAt).toLocaleTimeString():'—';
      get('vault-state').textContent=`已连接 · 待写入 ${s.pendingCount} 项 · 上次写入 ${time}${s.lastError?` · 上次问题：${s.lastError}`:''}${vaultFeedback?` · ${vaultFeedback}`:''}`;
    }catch{get('vault-state').textContent='状态读取失败，请重试';}
  }
  get('vault-connect').addEventListener('click',async()=>{
    const state=get('vault-state');state.textContent='请选择学习文件夹…';
    let picked=false;
    try{picked=await pickVaultDirectoryInPage();}catch{picked=false;}
    if(!picked){state.textContent='未选择目录（或当前页面不支持），未做更改。';return;}
    state.textContent='正在连接…';
    try{
      const r=await browser.runtime.sendMessage({type:'vaultConnect'}) as {ok?:boolean;imported?:boolean;error?:string;syncError?:string}|null;
      if(r?.ok)state.textContent=`已连接${r.imported?'，本机记录已加入同步队列':''}${r.syncError?`；同步未完成：${r.syncError}`:''}。`;
      else state.textContent=`连接失败：${r?.error??'未知错误'}；重新点击可重试授权。`;
    }catch{state.textContent='连接失败，请重试；重新点击可再次授权。';}
    await refreshVault();
  });
  get('vault-disconnect').addEventListener('click',async()=>{
    await browser.runtime.sendMessage({type:'vaultDisconnect'}).catch(()=>{});
    await refreshVault();
  });
  get('vault-flush').addEventListener('click',async()=>{
    if(vaultBusy)return;
    vaultBusy=true;
    get<HTMLButtonElement>('vault-flush').disabled=true;
    get('vault-state').textContent='正在同步…';
    const errors:Record<string,string>={'not-connected':'请先连接学习文件夹','no-permission':'未获得文件夹读写权限，请重新连接并允许访问','io':'文件读写失败，未完成的内容仍保留在本机，请重试','format':'学习文档格式有误，请检查文档后重试','conflict':'存在同一记录的修改冲突，双方内容已保留'};
    try{
      if(await authorizeVaultInPage()!=='granted')throw new Error('no-permission');
      const r=await browser.runtime.sendMessage({type:'vaultFlush'}) as {ok?:boolean;committed?:number;updated?:number;deleted?:number;error?:string}|null;
      if(!r?.ok)throw new Error(r?.error??'io');
      vaultFeedback=`同步完成：写入 ${r.committed??0} 项，读回 ${r.updated??0} 项${r.deleted?`，移除 ${r.deleted} 项`:''}`;
    }catch(error){const reason=error instanceof Error?error.message:'io';vaultFeedback=errors[reason]??`同步失败：${reason}`;}
    finally{vaultBusy=false;get<HTMLButtonElement>('vault-flush').disabled=false;await refreshVault();}
  });
  browser.runtime.onMessage.addListener((msg:unknown)=>{
    if((msg as {type?:string})?.type==='vault-changed')void refreshVault();
  });
  void refreshVault();
  let activitySync = false;
  async function syncOnActivity():Promise<void> {
    if(activitySync||document.visibilityState==='hidden')return;
    activitySync=true;
    try{await browser.runtime.sendMessage({type:'vaultSync'});}catch{ /* Manual sync reports actionable errors. */ }
    finally{activitySync=false;}
  }
  window.addEventListener('focus',()=>void syncOnActivity());
  document.addEventListener('visibilitychange',()=>void syncOnActivity());
  void syncOnActivity();
  get('save').addEventListener('click',async()=>{
    const profile=draft(),error=validateAiProfile(profile);
    if(error){report('state',error,false);return;}
    profile.baseUrl=normalizeAiBaseUrl(profile.baseUrl);
    const target=selected;get<HTMLFieldSetElement>('ai-fields').disabled=true;
    try {
      // Keep the permissions request in the click gesture, before storage awaits.
      const allowed=await browser.permissions.request({origins:[`${new URL(profile.baseUrl).origin}/*`]});
      if(!allowed){report('state','未获得该 API 地址的访问权限，配置未更改。再次保存可重试。',false);return;}
      const latest=readAiServices(await browser.storage.local.get(['aiServices','deepseekApiKey']));
      const next:AiServices={active:target,profiles:{...latest.profiles,[target]:profile}};
      await browser.storage.local.set({aiServices:next});
      services=readAiServices(await browser.storage.local.get('aiServices'));
      selected=services.active;drafts.delete(target);showProvider();report('state','已保存并启用',true);
    } catch {report('state','保存失败，请重试；新地址需要允许浏览器访问',false);}
    finally {get<HTMLFieldSetElement>('ai-fields').disabled=false;}
  });
  get('clear').addEventListener('click',async()=>{
    const target=selected;get<HTMLFieldSetElement>('ai-fields').disabled=true;
    try{const latest=readAiServices(await browser.storage.local.get(['aiServices','deepseekApiKey']));latest.profiles[target]={...latest.profiles[target]??defaultAiProfile(target),apiKey:''};await browser.storage.local.set({aiServices:latest});if(target==='deepseek')await browser.storage.local.remove('deepseekApiKey');services=readAiServices(await browser.storage.local.get('aiServices'));drafts.delete(target);showProvider();report('state','已清除所选服务的 Key',true);}catch{report('state','清除失败，请重试',false);}finally{get<HTMLFieldSetElement>('ai-fields').disabled=false;}
  });
  get('version').textContent=`Peak Distance · ${browser.runtime.getManifest().version}`;
  void load();return {refresh:load};
}
