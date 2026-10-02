import { DEFAULT_SETTINGS, validSetting } from './settings';
import { AI_PRESETS, defaultAiProfile, normalizeAiBaseUrl, readAiServices, validateAiProfile, type AiProfile, type AiProvider, type AiServices, type AiProtocol } from './aiConfig';

export function mountSettings(root: HTMLElement) {
  root.innerHTML = `<section class="settings-section"><h2>通用设置</h2>
    <label class="settings-field">词汇标记<input id="markingEnabled" type="checkbox"></label>
    <p class="hint">在网页与字幕中识别已收藏、在学和已掌握的词语。</p>
    <label class="settings-field">会话缓存上限<input id="cacheLimit" type="number" min="20" max="500" step="1"></label>
    <p class="hint">只缓存成功查询，最多 500 条，并受 2 MB 文本总量限制。</p></section>
    <section class="settings-section"><h2>翻译与显示</h2>
    <label class="settings-field">首选词典<select id="primaryDictionary"><option value="youdao">有道</option><option value="cambridge">剑桥英汉</option></select></label>
    <label class="settings-field">备用词典<select id="backupDictionary"><option value="cambridge">剑桥英汉</option><option value="youdao">有道</option></select></label>
    <label class="settings-field">常规翻译来源<select id="regularTranslation"><option value="google-gtx">Google 免费翻译</option></select></label>
    <label class="settings-field">默认翻译方式<select id="translationMode"><option value="regular">常规翻译</option><option value="ai">AI 翻译（LLM）</option></select></label>
    <label class="settings-field">开启双语字幕<input id="bilingualEnabled" type="checkbox"></label>
    <label class="settings-field">显示中文字幕<input id="chineseVisible" type="checkbox"></label>
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
        const control=get<HTMLInputElement|HTMLSelectElement>(name),value=validSetting(name,stored[name])?stored[name]:fallback;
        if(control instanceof HTMLInputElement && control.type==='checkbox')control.checked=!!value;else control.value=String(value);
      }
      services=readAiServices(stored);selected=services.active;drafts.clear();showProvider();
    } catch {report('state','设置读取失败，请重新打开设置重试',false);}
  }
  for(const name of Object.keys(DEFAULT_SETTINGS)) {
    const control=get<HTMLInputElement|HTMLSelectElement>(name);
    control.addEventListener('change',async()=>{
      const value=control instanceof HTMLInputElement&&control.type==='checkbox'?control.checked:name==='cacheLimit'?Number(control.value):control.value;
      if(!validSetting(name,value)){report('online-state','请检查输入范围',false);return;}
      try{await browser.storage.local.set({[name]:value});report('online-state','已保存',true);}catch{report('online-state','保存失败，请重试',false);}
    });
  }
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
