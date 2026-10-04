import { isPanelView, panelStateKey, type PanelMode, type PanelView, type PanelFrameState } from '@/shared/panel';
import { discardChatEdit } from './chatWorkspace';

const hostKey = (windowId: number) => `panel-host:${windowId}`;
export function initPanelLifecycle() {
  browser.sidePanel.onClosed.addListener(info => {
    const transferKey = `panel-native-transfer:${info.windowId}`;
    void browser.storage.session.get([hostKey(info.windowId), transferKey]).then(async data => {
      if (data[transferKey]) { await browser.storage.session.remove(transferKey); return; }
      if ((data[hostKey(info.windowId)] as { mode?: string } | undefined)?.mode === 'floating') return;
      await discardChatEdit(info.windowId);
      await browser.storage.session.remove(hostKey(info.windowId));
      await browser.runtime.sendMessage({ type: 'pd-panel-closed', windowId: info.windowId }).catch(() => {});
    });
  });
  browser.tabs.onRemoved.addListener(tabId => {
    void browser.storage.session.get(null).then(async data => {
      for (const [key, host] of Object.entries(data)) {
        const value = host as { mode?: string; tabId?: number };
        if (key.startsWith('panel-host:') && value.mode === 'floating' && value.tabId === tabId) await discardChatEdit(Number(key.split(':')[1]));
      }
      await browser.storage.session.remove(`panel-diagnostics:${tabId}`);
    });
  });
  browser.windows.onRemoved.addListener(windowId => {
    void discardChatEdit(windowId);
    void browser.storage.session.remove([`selection:${windowId}`, `chat-tab:${windowId}`]);
  });
}

type Sender = Parameters<Parameters<typeof browser.runtime.onMessage.addListener>[0]>[1];
const uiSender = (sender: Sender) => sender.url?.startsWith(browser.runtime.getURL('/sidepanel.html')) || sender.url?.startsWith(browser.runtime.getURL('/options.html'));

async function tabMessage(tabId: number, message: unknown) {
  return browser.tabs.sendMessage(tabId, message, {frameId:0}).catch(() => null);
}

async function frameStatus(tabId: number, stage: string): Promise<PanelFrameState> {
  const contexts = await browser.runtime.getContexts({ tabIds: [tabId] });
  const context = contexts.find(c => c.frameId > 0 && c.documentUrl?.startsWith(browser.runtime.getURL('/sidepanel.html')));
  const version = browser.runtime.getManifest().version;
  let state: PanelFrameState = { ok: false, phase: 'document-missing', version };
  if (context?.documentId) {
    const response = await browser.tabs.sendMessage(tabId, { type: 'pd-workspace-status' }, { documentId: context.documentId }).catch(() => null);
    if (response && (response.documentId === context.documentId || response.phase === 'loading' && !response.documentId)) {
      state = { ok: response.ok === true, phase: response.phase, version, documentId: context.documentId,
        reason: ['context','boot','restore'].includes(response.reason) ? response.reason : undefined };
    } else state = { ok: false, phase: 'unresponsive', documentId: context.documentId, version, reason: 'no-workspace-response' };
  }
  const key = `panel-diagnostics:${tabId}`;
  const events = ((await browser.storage.session.get(key))[key] ?? []) as Array<PanelFrameState & { at: number; stage: string }>;
  const previous = events.at(-1);
  if (previous?.phase !== state.phase || previous.documentId !== state.documentId || stage === 'load' || stage === 'retry') {
    const event = { ...state, at: Date.now(), stage };
    console.info('[pd] workspace document', event);
    await browser.storage.session.set({ [key]: [...events.slice(-19), event] });
  }
  return state;
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
      await browser.storage.session.set({ [hostKey(windowId)]: { mode: 'floating', tabId, hostId: result.hostId } });
      await browser.runtime.sendMessage({type:'pd-panel-view',windowId,tabId,mode:'floating',view}).catch(() => {});
      const contexts = await browser.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] });
      if (contexts.some(c => c.windowId === windowId)) await browser.storage.session.set({ [`panel-native-transfer:${windowId}`]: true });
      await browser.sidePanel.close({windowId}).catch(() => browser.storage.session.remove(`panel-native-transfer:${windowId}`));
      return {ok:true,mode};
    }
    if (forceMode === 'floating') return {ok:false,error:'当前页面不能显示浮动面板，请保留固定侧栏'};
  }
  try {
    if(nativeOpen) {if(!await nativeOpen)throw Error('user-gesture');}
    else await browser.sidePanel.open({windowId});
    await browser.storage.session.set({ [hostKey(windowId)]: { mode: 'fixed', tabId } });
    await tabMessage(tabId, {type:'pd-panel-hide'});
    await browser.runtime.sendMessage({type:'pd-panel-view',windowId,tabId,mode:'fixed',view}).catch(() => {});
    return {ok:true,mode:'fixed'};
  } catch {
    return {ok:false,error:'请点击扩展按钮打开固定侧栏，当前内容已保留'};
  }
}

export async function handlePanelMessage(message: unknown, sender: Sender, nativeOpen?:Promise<boolean>): Promise<unknown | undefined> {
  const m = message as {type?:string;view?:unknown;mode?:unknown;snapshot?:unknown;nativeOpened?:boolean;fullscreen?:boolean;at?:number;stage?:string;hostId?:string};
  if (!m?.type || !['panelContext','panelReady','panelFrameStatus','panelFrameRetry','panelFullscreen','panelOpen','panelClose','panelHostClosed','panelOutsideClick','panelSwitch','selectionSnapshot','getSelectionSnapshot'].includes(m.type)) return undefined;
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
  if (!uiSender(sender) && !['panelOpen','panelClose','panelHostClosed','panelOutsideClick','panelFrameStatus','panelFrameRetry'].includes(m.type)) return {ok:false,error:'forbidden-sender'};
  if (m.type === 'panelFrameStatus') return frameStatus(tabId, ['load','show','probe'].includes(m.stage ?? '') ? m.stage! : 'probe');
  if (m.type === 'panelFrameRetry') {
    await frameStatus(tabId, 'retry');
    return { ok: true };
  }
  if (m.type === 'panelOutsideClick') {
    const event = { type: 'pd-popup-outside', origin: uiSender(sender) ? 'panel' : 'page', windowId, tabId, at: m.at };
    if (event.origin === 'panel') await tabMessage(tabId, event);
    else await browser.runtime.sendMessage(event).catch(() => {});
    return { ok: true };
  }
  if (m.type === 'panelHostClosed') {
    if ((sender.frameId ?? 0) !== 0 || uiSender(sender)) return {ok:false,error:'forbidden-sender'};
    const host = (await browser.storage.session.get(hostKey(windowId)))[hostKey(windowId)] as { mode?: string; tabId?: number; hostId?: string } | undefined;
    if (host?.mode === 'floating' && host.tabId === tabId && host.hostId === m.hostId) await discardChatEdit(windowId);
    return { ok: true };
  }
  if(m.type==='panelReady'){await tabMessage(tabId,{type:'pd-panel-ready',documentId:sender.documentId});return {ok:true};}
  if (m.type === 'getSelectionSnapshot') return {ok:true,snapshot:(await browser.storage.session.get(`selection:${windowId}`))[`selection:${windowId}`] ?? null};
  if (m.type === 'panelContext') {
    const floating = typeof sender.tab?.id === 'number' && (sender.frameId ?? 0) > 0;
    const host = (await browser.storage.session.get(hostKey(windowId)))[hostKey(windowId)] as { mode?: string; tabId?: number } | undefined;
    return {ok:true,windowId,tabId,documentId:sender.documentId,fullscreen:!!(await tabMessage(tabId,{type:'pd-panel-status'}))?.fullscreen,floating,
      active: !host || host.mode === (floating ? 'floating' : 'fixed') && (!floating || host.tabId === tabId)};
  }
  if (m.type === 'panelClose') {
    await discardChatEdit(windowId);
    await browser.storage.session.remove(hostKey(windowId));
    await browser.runtime.sendMessage({ type: 'pd-panel-closed', windowId }).catch(() => {});
    if ((sender.frameId ?? 0) > 0 || !uiSender(sender)) await tabMessage(tabId,{type:'pd-panel-hide'});
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
