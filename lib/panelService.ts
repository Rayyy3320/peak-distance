import { isPanelView, panelStateKey, type PanelMode, type PanelView } from '@/shared/panel';

type Sender = Parameters<Parameters<typeof browser.runtime.onMessage.addListener>[0]>[1];
const uiSender = (sender: Sender) => sender.url?.startsWith(browser.runtime.getURL('/sidepanel.html')) || sender.url?.startsWith(browser.runtime.getURL('/options.html'));

async function tabMessage(tabId: number, message: unknown) {
  return browser.tabs.sendMessage(tabId, message, {frameId:0}).catch(() => null);
}

export function startNativePanel(message: unknown, sender: Sender): Promise<boolean> | undefined {
  const m=message as {type?:string;fullscreen?:boolean;openPanel?:boolean};
  if(!sender.tab?.id || m.fullscreen || !(['panelOpen','openSettings','openLearning'].includes(m.type??'') || (m.type==='chatEnsure'&&m.openPanel)))return;
  return browser.sidePanel.open({windowId:sender.tab.windowId}).then(()=>true,()=>false);
}

export async function openPanel(tabId: number, windowId: number, view?: PanelView, forceMode?: PanelMode, nativeOpen?:Promise<boolean>) {
  const info = await tabMessage(tabId, {type:'pd-panel-status'});
  const stored = await browser.storage.local.get('panelMode');
  const mode = info?.fullscreen ? 'floating' : forceMode ?? (stored.panelMode === 'floating' ? 'floating' : 'fixed');
  if (view) {
    const key = panelStateKey(windowId), data = (await browser.storage.session.get(key))[key] ?? {};
    await browser.storage.session.set({[key]:{...data,view}});
  }
  if (mode === 'floating') {
    const result = await tabMessage(tabId, {type:'pd-panel-show',view});
    if (result?.ok) {
      await browser.runtime.sendMessage({type:'pd-panel-view',windowId,tabId,mode:'floating',view}).catch(() => {});
      await browser.sidePanel.close({windowId}).catch(() => {});
      return {ok:true,mode};
    }
    if (forceMode === 'floating') return {ok:false,error:'当前页面不能显示浮动面板，请保留固定侧栏'};
  }
  try {
    if(nativeOpen) {if(!await nativeOpen)throw Error('user-gesture');}
    else await browser.sidePanel.open({windowId});
    await tabMessage(tabId, {type:'pd-panel-hide'});
    await browser.runtime.sendMessage({type:'pd-panel-view',windowId,tabId,mode:'fixed',view}).catch(() => {});
    return {ok:true,mode:'fixed'};
  } catch {
    return {ok:false,error:'请点击扩展按钮打开固定侧栏，当前内容已保留'};
  }
}

export async function handlePanelMessage(message: unknown, sender: Sender, nativeOpen?:Promise<boolean>): Promise<unknown | undefined> {
  const m = message as {type?:string;view?:unknown;mode?:unknown;snapshot?:unknown;nativeOpened?:boolean;fullscreen?:boolean};
  if (!m?.type || !['panelContext','panelReady','panelFullscreen','panelOpen','panelClose','panelSwitch','selectionSnapshot','getSelectionSnapshot'].includes(m.type)) return undefined;
  const tab = sender.tab ?? (await browser.tabs.query({active:true,currentWindow:true}))[0];
  if (typeof tab?.id !== 'number' || typeof tab.windowId !== 'number') return {ok:false,error:'找不到当前页面'};
  const windowId = tab.windowId, tabId = tab.id;
  if(m.type==='panelFullscreen') {
    const beforeKey=`panel-before-fullscreen:${tabId}`,stateKey=panelStateKey(windowId);
    if(m.fullscreen) {
      const state=(await browser.storage.session.get(stateKey))[stateKey];
      await browser.storage.session.set({[beforeKey]:state??{view:'subs'}});
    } else {
      const state=(await browser.storage.session.get(beforeKey))[beforeKey];
      if(state) {
        await browser.storage.session.set({[stateKey]:state});
        const mode=(await browser.storage.local.get('panelMode')).panelMode==='floating'?'floating':'fixed';
        await browser.runtime.sendMessage({type:'pd-panel-view',windowId,tabId,mode}).catch(()=>{});
        await browser.storage.session.remove(beforeKey);
      }
    }
    await browser.runtime.sendMessage({type:'pd-panel-fullscreen',windowId,tabId,fullscreen:!!m.fullscreen}).catch(()=>{});return {ok:true};
  }
  if (m.type === 'selectionSnapshot') {
    const s = m.snapshot as {text?:unknown;url?:unknown;title?:unknown};
    if (!s || typeof s.text !== 'string' || s.text.length > 20000 || typeof s.url !== 'string' || typeof s.title !== 'string') return {ok:false};
    await browser.storage.session.set({[`selection:${windowId}`]:{text:s.text,url:s.url,title:s.title,tabId}});
    return {ok:true};
  }
  if (!uiSender(sender) && m.type !== 'panelOpen') return {ok:false,error:'forbidden-sender'};
  if(m.type==='panelReady'){await tabMessage(tabId,{type:'pd-panel-ready'});return {ok:true};}
  if (m.type === 'getSelectionSnapshot') return {ok:true,snapshot:(await browser.storage.session.get(`selection:${windowId}`))[`selection:${windowId}`] ?? null};
  if (m.type === 'panelContext') return {ok:true,windowId,tabId,fullscreen:!!(await tabMessage(tabId,{type:'pd-panel-status'}))?.fullscreen,floating:typeof sender.tab?.id === 'number' && (sender.frameId ?? 0) > 0};
  if (m.type === 'panelClose') {
    if ((sender.frameId ?? 0) > 0) await tabMessage(tabId,{type:'pd-panel-hide'});
    else await browser.sidePanel.close({windowId});
    return {ok:true};
  }
  if (m.type === 'panelSwitch') {
    if (m.mode !== 'fixed' && m.mode !== 'floating') return {ok:false,error:'bad-payload'};
    const info = await tabMessage(tabId,{type:'pd-panel-status'});
    if (info?.fullscreen && m.mode === 'fixed') return {ok:false,error:'退出视频全屏后可使用固定侧栏'};
    const result = await openPanel(tabId,windowId,undefined,m.mode,m.nativeOpened?Promise.resolve(true):undefined);
    if (result.ok) await browser.storage.local.set({panelMode:m.mode});
    return result;
  }
  return openPanel(tabId,windowId,isPanelView(m.view) ? m.view : undefined,undefined,nativeOpen);
}
