import '@/shared/theme.css';
import { mountSettings } from '@/shared/settingsView';
import { createYoutubeWorkspace, type WorkspaceState } from '@/shared/youtubeWorkspace';
import { isPanelView, panelStateKey, panelTransportFailure, type SelectionSnapshot, type PanelFrameState } from '@/shared/panel';
import { createTranslationPopup } from '@/shared/translationPopup';
import { createLookupPopup } from '@/shared/lookupPopup';
import { shadowSelection } from '@/shared/selection';
import { buildMarkBuckets } from '@/shared/marker';
import { effectiveEntryLanguage, isRtlLanguage, langDisplayName } from '@/shared/languages';
import { segmentWords } from '@/shared/tokenize';
// 侧栏三个视图：生词本（词条 / 上下文 / 词形关联管理）、字幕（当前标签页
// 视频的原文列表 + 译文 + 播放控制）、复习（原句回忆，无 AI 调用）。
// 数据全部来自 background 的 IndexedDB；vocab-changed 广播后刷新。
// 字幕控制消息经 tabs.sendMessage 直达当前标签页，携带 videoId 防串页。

import type { EntryView, SubViewState } from '@/shared/messages';
import { videoContextUrl, blankExpression, type SavedSentence, type VocabStatus } from '@/shared/vocab';
import { buildReviewQueue, refreshQueue, type ReviewItem } from '@/shared/review';
import { fmtClock } from '@/shared/cues';
import {
  chatViewEnter,
  chatViewLeave,
  initChatView,
  subtitleAskAi,
  saveDraft,
  snapshotChat,restoreChat,setChatActive,type ChatViewSnapshot,
} from './chatView';

const STATUS_LABEL: Record<VocabStatus, string> = {
  saved: '已收藏',
  learning: '在学',
  known: '已掌握',
};

function send<T>(msg: unknown): Promise<T> {
  return new Promise((resolve) => {
    const failed = (error: unknown) => {
      console.warn('[pd] panel transport failed', { type: (msg as {type?:string}).type, reason: panelTransportFailure(error) });
      resolve(undefined as T);
    };
    try {
      const pending = browser.runtime.sendMessage(msg, (r: unknown) => {
        const error = browser.runtime.lastError;
        if (error) failed(error.message); else resolve(r as T);
      }) as unknown as Promise<unknown> | undefined;
      void pending?.catch(failed);
    } catch (error) { failed(error); }
  });
}

function tabSend<T>(tabId: number, msg: unknown): Promise<T | null> {
  return new Promise((resolve) => {
    browser.tabs.sendMessage(tabId, msg, (r: unknown) => {
      void browser.runtime.lastError;
      resolve((r as T) ?? null);
    });
  });
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ---- 视图切换 -------------------------------------------------------------------

let currentView = '';
let previousView = 'list';
let panelWindow = -1;
let floating = false;
let panelTabId=-1;
let activePanel=true;
let inVideoFullscreen=false;
let ready = false;
let panelDocumentId = '';
let workspaceInitialized = false;
let workspaceFailureStage = '';
const workspaceVersion = browser.runtime.getManifest().version;
function workspaceFailed(stage: string, error: unknown) {
  workspaceFailureStage = stage; ready = false;
  console.warn('[pd] workspace initialization failed', { stage, documentId: panelDocumentId, version: workspaceVersion, reason: error instanceof Error ? error.name : 'unknown-error' });
  feedback('工作区暂不可用，请使用浮动外壳的重试入口');
}
browser.runtime.onMessage.addListener((m: unknown, _sender, reply) => {
  if ((m as {type?:string}).type !== 'pd-workspace-status') return;
  const phase: PanelFrameState['phase'] = !document.getElementById('views') ? 'document-empty'
    : workspaceFailureStage ? 'failed' : !workspaceInitialized ? 'loading' : ready ? 'ready' : 'standby';
  reply({ ok: phase === 'ready' || phase === 'standby', phase, documentId: panelDocumentId, version: workspaceVersion, reason: workspaceFailureStage || undefined } satisfies PanelFrameState);
});
let savedScroll: Record<string,number> = {};
interface PanelSnapshot {view?:string;previousView?:string;search?:string;reviewQueue?:ReviewItem[];reviewIdx?:number;revealed?:boolean;scroll?:Record<string,number>;video?:{tab?:string;follow?:boolean;top?:number};chat?:ChatViewSnapshot}
const settingsView=mountSettings(document.getElementById('settings-body')!);
const selectionPopup=createTranslationPopup(send);
const lookupPopup=createLookupPopup({send});
let hoveredWord:HTMLElement|null=null;
let wordTimer:ReturnType<typeof setTimeout>|undefined;
let closeTimer:ReturnType<typeof setTimeout>|undefined;
let lookupTarget='';
const currentMain=()=>document.getElementById('view-'+currentView);
const feedback=(text:string)=>{const n=document.getElementById('panel-feedback')!;n.hidden=!text;n.textContent=text;};
async function persistPanel() {
  if(!ready || !activePanel || panelWindow<0)return;
  savedScroll[currentView]=currentMain()?.scrollTop??0;
  await browser.storage.session.set({[panelStateKey(panelWindow)]:{view:currentView,previousView,search:(document.getElementById('search') as HTMLInputElement).value,reviewQueue,reviewIdx,revealed,scroll:savedScroll,video:videoWorkspace.snapshot(),chat:snapshotChat()}});
}


function switchView(view: string): void {
  if (view === currentView) return;
  lookupPopup.close();document.getElementById('panel-selection-actions')?.remove();
  const prev = currentView;
  if (prev === 'chat' && view !== 'chat') chatViewLeave();
  savedScroll[prev]=currentMain()?.scrollTop??0;
  if(view==='settings' && prev!=='settings')previousView=prev||'list';
  currentView = view;
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#views button')) {
    btn.classList.toggle('active', btn.dataset.view === (['list','sentences','review'].includes(view)?'list':view));
  }
  document.getElementById('view-sentences')!.hidden = view !== 'sentences';
  document.getElementById('view-list')!.hidden = view !== 'list';
  document.getElementById('view-subs')!.hidden = view !== 'subs';
  document.getElementById('view-review')!.hidden = view !== 'review';
  document.getElementById('view-chat')!.hidden = view !== 'chat';
  document.getElementById('view-settings')!.hidden = view !== 'settings';
  document.getElementById('library-tools')!.hidden = !['list','sentences'].includes(view);
  document.querySelectorAll<HTMLButtonElement>('.library-tabs button').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  currentMain()?.scrollTo(0,savedScroll[view]??0);
  const search = document.getElementById('search')!;
  search.style.display = view === 'list' ? '' : 'none';
  // 侧栏各视图共用同一连接；显式停止或窗口关闭才停止生成
  if (view === 'chat') chatViewEnter();
  if (view === 'list') void refresh();
  if (view === 'subs') pollSubs();
  if (view === 'sentences') void refreshSentences();
  if (view === 'review') {if(reviewQueue.length)renderReview();else void startReview();}
  if (view === 'settings')void settingsView.refresh();
  void persistPanel();
}

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
  btn.addEventListener('click', () => switchView(btn.dataset.view!));
}

document.getElementById('open-settings')!.addEventListener('click', () => switchView('settings'));
document.getElementById('settings-back')!.addEventListener('click', () => switchView(previousView));
document.getElementById('panel-mode')!.addEventListener('click',async()=>{
  if(floating&&inVideoFullscreen){feedback('退出视频全屏后可使用固定侧栏');return;}
  // Native sidePanel.open must run before the first await in the click handler.
  const nativeOpen=floating?browser.sidePanel.open({windowId:panelWindow}).then(()=>true,()=>false):Promise.resolve(false);
  lookupPopup.close();
  await saveDraft();await persistPanel();
  const r=await send<{ok:boolean;error?:string}>({type:'panelSwitch',mode:floating?'fixed':'floating',nativeOpened:await nativeOpen});
  if(!r?.ok)feedback(r?.error??'切换失败，请重试');
});
document.getElementById('panel-close')!.addEventListener('click',async()=>{lookupPopup.close();await persistPanel();setChatActive(false);activePanel=false;ready=false;const r=await send<{ok:boolean}>({type:'panelClose'});if(!r?.ok){activePanel=true;ready=true;setChatActive(true);feedback('关闭失败，请重试');}});
document.addEventListener('pointerdown',()=>void send({type:'panelOutsideClick',at:performance.timeOrigin+performance.now()}),true);
document.addEventListener('click',()=>setTimeout(()=>void persistPanel(),0));
document.addEventListener('scroll',()=>void persistPanel(),true);


async function refreshSentences(): Promise<void> {
  const r = await send<{ ok:boolean; sentences:SavedSentence[] }>({ type:'listSentences' });
  if (currentView !== 'sentences') return;
  const body = document.getElementById('sentences-list')!; body.replaceChildren();
  if (!r?.ok) { body.append(el('p', 'empty', '读取失败，请重新打开句子页重试')); return; }
  if (!r.sentences.length) body.append(el('p', 'empty', '还没有收藏的字幕句子'));
  for (const saved of r.sentences) {
    const card = el('article', 'entry'); card.append(el('p', 'sentence', saved.text));
    if (saved.zh) card.append(el('p', 'definition', saved.zh));
    const meta = el('div', 'meta');
    const link = el('a', 'source', `${saved.title} · ${fmtClock(saved.video.startMs)}`);
    link.href = videoContextUrl(saved.video.videoId, saved.video.startMs); link.target = '_blank'; link.rel = 'noopener'; meta.append(link);
    const remove = el('button', 'delete', '取消收藏');
    remove.addEventListener('click', async () => {
      const result = await send<{ ok:boolean }>({ type:'deleteSentence', id:saved.id });
      if (!result?.ok) remove.textContent = '删除失败，重试';
    });
    meta.append(remove); card.append(meta); body.append(card);
  }
}

// ---- 生词本 ----------------------------------------------------------------------

function renderContextMeta(c: EntryView['contexts'][number]): HTMLElement {
  const meta = el('div', 'meta');
  const src = el('a', 'source');
  src.href = c.url;
  src.target = '_blank';
  src.rel = 'noopener';
  if (c.sourceType === 'video' && c.video) {
    src.textContent = `YouTube · ${fmtClock(c.video.startMs)}`;
    src.title = `${c.title} · ${c.video.trackLang}${c.video.trackKind === 'asr' ? '(自动)' : '(人工)'}`;
  } else {
    src.textContent = hostOf(c.url) || '打开来源';
    src.title = c.title || c.url;
  }
  meta.appendChild(src);
  const type = el(
    'span',
    'src-type',
    c.sourceType === 'video' ? '视频字幕' : '网页',
  );
  meta.appendChild(type);
  meta.appendChild(el('time', 'time', fmtTime(c.createdAt)));
  return meta;
}

function renderEntry(entry: EntryView): HTMLElement {
  const card = el('article', 'entry');
  card.dataset.key = entry.key;

  const head = el('div', 'entry-head');
  const expr = el('h2', 'expr', entry.expression);
  const entryLang = effectiveEntryLanguage(entry);
  if (entryLang && isRtlLanguage(entryLang)) expr.dir = 'rtl';
  head.appendChild(expr);
  const kind = el('span', 'kind', entry.kind === 'word' ? '词' : '短语');
  head.appendChild(kind);
  // 语言徽标：缺失（迁移前旧记录）不显示，不冒充任何语言
  if (entryLang) {
    const chip = el('span', 'kind', langDisplayName(entryLang));
    chip.title = entryLang;
    head.appendChild(chip);
  }

  const sel = el('select', 'status') as HTMLSelectElement;
  for (const s of ['saved', 'learning', 'known'] as const) {
    const opt = el('option', undefined, STATUS_LABEL[s]);
    opt.value = s;
    if (entry.status === s) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', async () => {
    const r = await send<{ ok: boolean }>({
      type: 'setStatus',
      key: entry.key,
      status: sel.value as VocabStatus,
    });
    if (!r?.ok) sel.value = entry.status;
  });
  head.appendChild(sel);

  const del = el('button', 'delete', '删除');
  del.addEventListener('click', async () => {
    if (!confirm(`删除「${entry.expression}」及其 ${entry.contexts.length} 条上下文？`)) return;
    await send({ type: 'deleteEntry', key: entry.key });
    // vocab-changed 广播会触发刷新
  });
  head.appendChild(del);
  card.appendChild(head);

  const first=entry.contexts[0];
  const meaning=first?.result?.kind==='dictionary'?first.result.entry.senses[0]?.definition:first?.result?.kind==='translation'?first.result.text:first?.result?.kind==='ai-definition'?first.result.text.split('\n')[0]:first?.definition;
  if(meaning)card.append(el('p','entry-preview',meaning));

  // 个人笔记（学习库“我的笔记”同源；就地编辑，正常保存给就近状态）
  const noteBox = el('details', 'note-box');
  const noteSummary = el('summary', undefined, entry.note ? '我的笔记' : '添加笔记');
  noteBox.appendChild(noteSummary);
  const noteArea = document.createElement('textarea');
  noteArea.value = entry.note ?? '';
  noteArea.placeholder = '写下自己的理解（同步到学习库“我的笔记”，Obsidian 中可直接编辑）';
  noteArea.setAttribute('aria-label', `${entry.expression} 我的笔记`);
  const noteState = el('p', 'hint');
  const noteSave = el('button', 'ghost', '保存笔记');
  noteSave.addEventListener('click', async () => {
    noteSave.disabled = true;
    const r = await send<{ ok: boolean }>({ type: 'setNote', key: entry.key, note: noteArea.value });
    noteSave.disabled = false;
    noteState.textContent = r?.ok ? '已保存' : '保存失败，请重试';
    if (r?.ok) noteSummary.textContent = noteArea.value.trim() ? '我的笔记' : '添加笔记';
  });
  const noteRow = el('div', 'note-actions');
  noteRow.append(noteSave, noteState);
  noteBox.append(noteArea, noteRow);
  card.appendChild(noteBox);

  // 词形关联：查看 + 移除错误关联
  if (entry.forms.length) {
    const forms = el('div', 'forms');
    forms.appendChild(el('span', 'form-label', '词形关联：'));
    for (const f of entry.forms) {
      const chip = el('span', 'form-chip');
      chip.appendChild(document.createTextNode(f));
      const rm = el('button', undefined, '×');
      rm.title = `移除词形关联「${f}」`;
      rm.addEventListener('click', async () => {
        await send({ type: 'removeForm', key: entry.key, form: f });
      });
      chip.appendChild(rm);
      forms.appendChild(chip);
    }
    card.appendChild(forms);
  }

  const details=el('details','entry-details');const summary=el('summary',undefined,'原句与详情');details.append(summary);
  for (const c of entry.contexts) {
    const box = el('div', 'context');
    box.appendChild(renderContextMeta(c));
    box.appendChild(el('p', 'sentence', c.sentence));
    if (c.result?.kind === 'dictionary') {
      const result = c.result;
      const sense = result.entry.senses[result.selectedSense ?? 0];
      if (sense) box.appendChild(el('p', 'definition', `${result.entry.source === 'youdao' ? '有道' : '剑桥英汉'} · ${sense.partOfSpeech ?? ''} ${sense.definition}`));
    } else if (c.result?.kind === 'translation') box.appendChild(el('p', 'definition', `翻译 · ${c.result.text}`));
    else if (c.result?.kind === 'ai-definition') box.appendChild(el('p', 'definition', `AI 释义 · ${c.result.text}`));
    if (c.explanation) box.appendChild(el('p', 'definition', `AI 语境解释 · ${c.explanation.text}`));
    else if (c.definition) box.appendChild(el('p', 'definition', `已存语境释义 · ${c.definition}`));
    details.appendChild(box);
  }
  card.append(details);
  return card;
}

async function refresh(): Promise<void> {
  const list = document.getElementById('list')!;
  const q = (document.getElementById('search') as HTMLInputElement).value;
  const r = await send<{ ok: boolean; entries?: EntryView[] }>({
    type: 'listEntries',
    query: q || undefined,
  });
  if (currentView !== 'list') return;
  list.textContent = '';
  if (!r?.ok || !r.entries) {
    list.appendChild(el('div', 'empty', '加载失败，请重试'));
    return;
  }
  // 语言筛选：全部 / 待确认 / 出现过的语言（记住选择，spec 3.4）
  const filter = document.getElementById('lang-filter') as HTMLSelectElement;
  const langs = [...new Set(r.entries.map((e) => effectiveEntryLanguage(e)).filter((l): l is string => !!l))].sort();
  const wanted = localStorage.getItem('blc-lang-filter') ?? 'all';
  if (filter.dataset.langs !== langs.join(',')) {
    filter.dataset.langs = langs.join(',');
    const current = wanted;
    filter.replaceChildren();
    const all = el('option', undefined, '全部语言'); all.value = 'all'; filter.appendChild(all);
    const und = el('option', undefined, '待确认'); und.value = 'und'; filter.appendChild(und);
    for (const l of langs) {
      if (l === 'und') continue;
      const o = el('option', undefined, langDisplayName(l)); o.value = l; filter.appendChild(o);
    }
    filter.value = [...filter.options].some((o) => o.value === current) ? current : 'all';
  }
  const filtered = filter.value === 'all' ? r.entries : r.entries.filter((e) => effectiveEntryLanguage(e) === filter.value);
  if (filtered.length === 0) {
    list.appendChild(
      el('div', 'empty', q ? '没有匹配的表达' : filter.value !== 'all' ? '该语言暂无词条' : '还没有收藏的表达。在网页上选中一个词或短语，点击“查词”开始。'),
    );
    return;
  }
  for (const e of filtered) list.appendChild(renderEntry(e));
  currentMain()?.scrollTo(0,savedScroll[currentView]??0);
}

document.getElementById('search')!.addEventListener('input', () => void refresh());
document.getElementById('lang-filter')!.addEventListener('change', () => {
  const filter = document.getElementById('lang-filter') as HTMLSelectElement;
  localStorage.setItem('blc-lang-filter', filter.value);
  void refresh();
});

// ---- 字幕视图（当前标签页的视频） ---------------------------------------------------

let subsState: SubViewState | null = null;
let subsTabId: number | null = null;
let cachedVideo: WorkspaceState | null=null;
const videoWorkspace=createYoutubeWorkspace({
  bindWords:host=>{
    const events=host.shadowRoot!;
    let selectedAt=0;
    document.addEventListener('mouseup',e=>{
      if(currentView!=='subs'||e.composedPath().some(n=>n instanceof Element&&n.matches('#panel-selection-actions,#blc-lookup-popup,#pd-translation')))return;
      const selection=shadowSelection(events),text=selection?.text??'';
      if(!text||!(/\s/.test(text))||!subsState)return;
      selectedAt=Date.now();e.stopPropagation();
      document.getElementById('panel-selection-actions')?.remove();
      const buttons=el('div','selection-actions');buttons.id='panel-selection-actions';
      const rect=selection!.range.getBoundingClientRect();buttons.style.left=Math.max(8,Math.min(rect.left,innerWidth-176))+'px';buttons.style.top=Math.min(rect.bottom+4,innerHeight-44)+'px';
      const node=selection!.range.startContainer;
      const element=node instanceof Element?node:node.parentElement;
      const selectedRow=element?.closest('[data-cue]');
      if(!selectedRow)return;
      const selectedIndex=Number(selectedRow.getAttribute('data-cue'));
      const selectedVideo=subsState.videoId,selectedCue=subsState.cues[selectedIndex];
      if(!selectedCue)return;
      const snapshot={text,title:subsState.title,url:videoContextUrl(selectedVideo,selectedCue.startMs)};
      const translate=el('button',undefined,'翻译');translate.onmousedown=e=>e.preventDefault();translate.onclick=()=>{buttons.remove();selectionPopup.open(snapshot,rect);};buttons.append(translate);
      if(text.length<=200){const lookup=el('button',undefined,'查词');lookup.onmousedown=e=>e.preventDefault();lookup.onclick=()=>{buttons.remove();if(subsState?.videoId===selectedVideo)void videoAction('lookup',selectedIndex,text);};buttons.append(lookup);}
      const close=el('button',undefined,'×');close.setAttribute('aria-label','关闭选区操作');close.onclick=()=>buttons.remove();buttons.append(close);document.body.append(buttons);
    });
    const wordOf=(e:Event)=>(e.composedPath()[0] as Element)?.closest?.('.w') as HTMLElement|null;
    const openWord=(word:HTMLElement,compact:boolean)=>openPanelWord(word.textContent??'',Number(word.closest('[data-cue]')?.getAttribute('data-cue')),word,compact);
    events.addEventListener('pointerover',e=>{const word=wordOf(e);if((e as PointerEvent).buttons||!word||word===hoveredWord||(lookupPopup.isOpen()&&!lookupPopup.isCompact()))return;clearTimeout(wordTimer);clearTimeout(closeTimer);wordTimer=setTimeout(()=>{if(!getSelection()?.toString()){hoveredWord=word;openWord(word,true);}},180);});
    events.addEventListener('pointerdown',()=>{clearTimeout(wordTimer);});
    events.addEventListener('pointerout',()=>{clearTimeout(wordTimer);closeTimer=setTimeout(()=>{if(lookupPopup.isCompact()){lookupPopup.close();hoveredWord=null;}},220);});
    events.addEventListener('click',e=>{if(Date.now()-selectedAt<500||getSelection()?.toString())return;const w=wordOf(e);if(!w)return;clearTimeout(wordTimer);clearTimeout(closeTimer);if(w===hoveredWord&&lookupPopup.isOpen()){if(lookupPopup.isCompact())lookupPopup.expand();else lookupPopup.close();}else{hoveredWord=w;openWord(w,false);}});
    events.addEventListener('focusin',e=>{const w=wordOf(e);if(w&&w!==hoveredWord){hoveredWord=w;openWord(w,true);}});
    events.addEventListener('keydown',e=>{const key=e as KeyboardEvent,w=wordOf(e);if(w&&(key.key==='Enter'||key.key===' ')){key.preventDefault();hoveredWord=w;openWord(w,false);}});
  },
  words:(parent,text)=>{const lang=((cachedVideo?.trackLang||subsState?.trackLang)||'en').split('-')[0]!;let last=0;for(const s of segmentWords(text,lang)){if(s.start>last)parent.append(document.createTextNode(text.slice(last,s.start)));const w=el('span','w',s.text);w.tabIndex=0;w.setAttribute('role','button');w.style.userSelect='text';parent.append(w);last=s.end;}if(last<text.length)parent.append(document.createTextNode(text.slice(last)));},
  seek:(i,play)=>void videoAction('seek',i,undefined,play),lookup:(word,i,anchor)=>openPanelWord(word,i,anchor,false),
  save:i=>void videoAction('save',i),remove:id=>void send({type:'deleteSentence',id}),
  ask:i=>{if(subsState?.cues[i])void subtitleAskAi(subsState,subsState.cues[i]!);},open:switchView,
  status:(key,status)=>void send({type:'setStatus',key,status}).then(()=>pollSubs()),
},document.getElementById('video-workspace')!);
function openPanelWord(word:string,index:number,anchor:HTMLElement,compact:boolean) {
  const state=subsState,tabId=subsTabId,cue=state?.cues[index];
  if(!state||tabId===null||!cue)return;
  if(lookupTarget!==`${tabId}:${state.videoId}`)lookupPopup.close();
  lookupTarget=`${tabId}:${state.videoId}`;
  const token=crypto.randomUUID();
  let closed=false;
  const resume=()=>void tabSend(tabId,{type:'pd-video-action',videoId:state.videoId,index,action:'resumeLookup',token});
  void tabSend(tabId,{type:'pd-video-action',videoId:state.videoId,index,action:'pauseLookup',token}).then(()=>{if(closed)resume();});
  lookupPopup.open({snapshot:{source:'video',expression:word,sentence:cue.text,title:state.title,lang:state.trackLang||undefined,video:{videoId:state.videoId,trackId:state.trackId,trackKind:state.trackKind==='asr'?'asr':'manual',trackLang:state.trackLang,startMs:cue.startMs}},anchor,compact,subLine:`YouTube · ${fmtClock(cue.startMs)}`,onContinueAsk:()=>void subtitleAskAi(state,cue),onClose:()=>{closed=true;resume();}});
  const card=lookupPopup.host()?.shadowRoot?.querySelector('.card');card?.addEventListener('pointerenter',()=>clearTimeout(closeTimer));card?.addEventListener('pointerleave',()=>{closeTimer=setTimeout(()=>{if(lookupPopup.isCompact()){lookupPopup.close();hoveredWord=null;}},220);});
}
async function videoAction(action:string,index:number,word?:string,play?:boolean) {
  if(subsTabId===null||!subsState?.videoId)return;
  const r=await tabSend<{ok:boolean}>(subsTabId,{type:'pd-video-action',action,index,word,play,videoId:subsState.videoId});
  if(!r?.ok)feedback('视频操作失败，请回到原视频重试');
  else await pollSubs();
}
async function pollSubs():Promise<void> {
  if(currentView!=='subs'||!activePanel)return;
  const tab=(await browser.tabs.query({active:true,currentWindow:true}))[0];
  if(typeof tab?.id!=='number')return;
  const id=tab.id;
  const st=await tabSend<SubViewState>(id,{type:'blc-sub-get'});
  if(currentView!=='subs')return;
  if(subsTabId!==id||subsState?.videoId!==st?.videoId){lookupPopup.close();selectionPopup.close();document.getElementById('panel-selection-actions')?.remove();}
  subsTabId=id;subsState=st?.type==='blc-sub-state'?st:null;
  document.getElementById('video-workspace')!.hidden=!subsState?.videoId;
  const web=document.getElementById('web-selection')!;web.hidden=!!subsState?.videoId;
  if(!subsState?.videoId){
    const r=await send<{ok:boolean;snapshot:SelectionSnapshot|null}>({type:'getSelectionSnapshot'});
    if(currentView!=='subs')return;
    const signature=JSON.stringify(r?.snapshot??null);if(web.dataset.snapshot===signature)return;web.dataset.snapshot=signature;web.replaceChildren();
    web.append(el('h1',undefined,'当前内容'));
    if(r?.snapshot){const source=el('a','source',r.snapshot.title||'原文来源');source.href=r.snapshot.url;source.target='_blank';source.rel='noopener';web.append(source,el('p','selection-text',r.snapshot.text));const button=el('button','primary','翻译选区');button.onclick=()=>selectionPopup.open(r.snapshot!);web.append(button);}
    else {web.append(el('div','empty','在网页中选中英文，点击查词或翻译。'),el('div','empty-landscape'));}
    return;
  }
  const state=subsState;
  const [vocab,saved,index]=await Promise.all([send<{ok:boolean;entries:EntryView[]}>({type:'listEntries'}),send<{ok:boolean;sentences:SavedSentence[]}>({type:'listSentences'}),send<{ok:boolean;items:import('@/shared/vocab').VocabIndexItem[]}>({type:'vocabIndex'})]);
  if(currentView!=='subs'||subsState!==state)return;
  const cues=state.cues.map(c=>({start:c.startMs,dur:c.endMs-c.startMs,text:c.text,lastOff:0}));
  const stable=<T>(old:T,next:T):T=>JSON.stringify(old)===JSON.stringify(next)?old:next;
  cachedVideo={videoId:state.videoId,videoRef:{videoId:state.videoId,trackId:state.trackId,trackKind:state.trackKind==='asr'?'asr':'manual',trackLang:state.trackLang,startMs:0},
    trackLang:state.trackLang||undefined,
    cues:cachedVideo?.videoId===state.videoId?stable(cachedVideo.cues,cues):cues,current:state.currentIndex,translations:new Map(state.cues.filter(c=>c.zh).map(c=>[c.id,c.zh!])),
    statuses:buildMarkBuckets(index?.items??[]).get((state.trackLang||'en').split('-')[0]!)?.statusByKey??new Map<string,string>(),
    sentences:stable(cachedVideo?.sentences??[],saved?.sentences??[]),entries:stable(cachedVideo?.entries??[],vocab?.entries??[]),notice:state.notice,chinese:state.chineseVisible!==false};
  videoWorkspace.update(cachedVideo);
}
setInterval(()=>void pollSubs(),1000);
async function control(action:'seek'|'togglePlay'|'replay'|'next'|'prev',timeMs?:number):Promise<void>{if(subsTabId!==null&&subsState?.videoId){await tabSend(subsTabId,{type:'blc-sub-control',videoId:subsState.videoId,action,timeMs});await pollSubs();}}

// 快捷键：输入框 / 编辑区 / 弹窗内不截获
document.addEventListener('keydown', (e) => {
  if (currentView !== 'subs' || !subsState?.videoId) return;
  const t = e.target as HTMLElement | null;
  if (
    t &&
    (t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' ||
      t.isContentEditable)
  ) {
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 'j') void control('next');
  else if (k === 'k') void control('prev');
  else if (k === 'r') void control('replay');
  else return;
  e.preventDefault();
});

// ---- 复习视图（M4：原句回忆，无 AI） -------------------------------------------------

let reviewQueue: ReviewItem[] = [];
let reviewIdx = 0;
let revealed = false;

async function startReview(): Promise<void> {
  const r = await send<{ ok: boolean; entries?: EntryView[] }>({ type: 'listEntries' });
  if (currentView !== 'review') return;
  reviewQueue = r?.ok && r.entries ? buildReviewQueue(r.entries) : [];
  reviewIdx = 0;
  revealed = false;
  renderReview();
}

function renderReview(): void {
  if (currentView !== 'review') return;
  const body = document.getElementById('review-body')!;
  body.textContent = '';

  const backBtn = () => {
    const b = el('button', 'ghost', '返回生词本');
    b.addEventListener('click', () => switchView('list'));
    return b;
  };

  if (!reviewQueue.length) {
    body.appendChild(
      el('div', 'empty', '没有可复习的词条。收藏的 saved / learning 词条会出现在这里。'),
    );
    const row = el('div', 'review-actions');
    row.appendChild(backBtn());
    body.appendChild(row);
    return;
  }
  if (reviewIdx >= reviewQueue.length) {
    body.appendChild(el('div', 'empty', '本轮复习完成 🎉'));
    const row = el('div', 'review-actions');
    const again = el('button', undefined, '再来一轮');
    again.addEventListener('click', () => void startReview());
    row.appendChild(again);
    row.appendChild(backBtn());
    body.appendChild(row);
    return;
  }

  const it = reviewQueue[reviewIdx]!;
  const prog = el('div', 'review-progress');
  prog.textContent = `${reviewIdx + 1} / ${reviewQueue.length} · ${STATUS_LABEL[it.status]}`;
  body.appendChild(prog);

  const card = el('div', 'review-card');
  const { text, count } = blankExpression(it.sentence, it.expression);
  const sentence = el('p', 'sentence', count ? text : it.sentence);
  if (!count) sentence.title = '（原句中未找到该表达的精确匹配）';
  card.appendChild(sentence);

  const meta = el('div', 'review-meta');
  const src = el('a', 'source');
  src.href = it.url;
  src.target = '_blank';
  src.rel = 'noopener';
  src.textContent =
    it.sourceType === 'video' && it.video
      ? `YouTube · ${fmtClock(it.video.startMs)}`
      : hostOf(it.url);
  src.title = it.title;
  meta.appendChild(src);
  meta.appendChild(el('time', 'time', fmtTime(it.createdAt)));
  card.appendChild(meta);

  if (revealed) {
    const rv = el('div', 'review-reveal');
    rv.appendChild(el('div', 'word', it.expression));
    if (it.definition) {
      const d = el('p', 'definition', it.definition);
      rv.appendChild(d);
    } else {
      rv.appendChild(el('div', 'no-def', '未保存释义'));
    }
    card.appendChild(rv);
  }

  const actions = el('div', 'review-actions');
  if (!revealed) {
    const reveal = el('button', undefined, '揭示');
    reveal.addEventListener('click', () => {
      revealed = true;
      renderReview();
    });
    actions.appendChild(reveal);
  } else {
    const next = el('button', 'ghost', '下一条');
    next.addEventListener('click', () => {
      revealed = false;
      reviewIdx++;
      renderReview();
    });
    actions.appendChild(next);
    const learn = el('button', 'ghost', '在学');
    learn.addEventListener('click', () => void reviewStatus('learning'));
    actions.appendChild(learn);
    const known = el('button', undefined, '已掌握');
    known.addEventListener('click', () => void reviewStatus('known'));
    actions.appendChild(known);
    const back = el('button', 'ghost', '返回来源');
    back.addEventListener('click', () => {
      window.open(it.url, '_blank', 'noopener');
    });
    actions.appendChild(back);
  }
  const exit = el('button', 'ghost', '退出复习');
  exit.addEventListener('click', () => switchView('list'));
  actions.appendChild(exit);
  card.appendChild(actions);
  body.appendChild(card);
}

async function reviewStatus(status: VocabStatus): Promise<void> {
  const it = reviewQueue[reviewIdx];
  if (!it) return;
  await send({ type: 'setStatus', key: it.key, status });
  // vocab-changed 广播触发 refreshReviewQueue；这里先推进
  revealed = false;
  reviewIdx++;
  renderReview();
}

// 词条被删除 / 改状态后队列及时更新（保持位置）
async function refreshReviewQueue(): Promise<void> {
  if (currentView !== 'review') return;
  const r = await send<{ ok: boolean; entries?: EntryView[] }>({ type: 'listEntries' });
  if (currentView !== 'review' || !r?.ok || !r.entries) return;
  const currentKey = reviewQueue[reviewIdx]?.key ?? null;
  const { queue, currentIndex } = refreshQueue(reviewQueue, currentKey, r.entries);
  reviewQueue = queue;
  reviewIdx = currentIndex;
  if (reviewIdx >= reviewQueue.length) revealed = false;
  renderReview();
}

// ---- 广播 -----------------------------------------------------------------------

browser.runtime.onMessage.addListener((msg: unknown) => {
  const t = (msg as { type?: string })?.type;
  if (t === 'vocab-changed') {
    if (currentView === 'list') void refresh();
    if (currentView === 'review') void refreshReviewQueue();
  }
  if (t === 'sentences-changed' && currentView === 'sentences') void refreshSentences();
  if (t === 'settings-changed') {
    /* 内容标记开关变化不影响侧栏自身展示 */
  }
});

initChatView({ getActiveView: () => currentView, switchView });

async function boot(){
 const ctx=await send<{ok:boolean;windowId:number;tabId:number;documentId:string;floating:boolean;fullscreen:boolean;active:boolean}>({type:'panelContext'});
 if(!ctx?.ok){workspaceFailed('context',new Error('panel-context-unavailable'));return;}
 panelDocumentId=ctx.documentId;
 panelWindow=ctx.windowId;panelTabId=ctx.tabId;floating=ctx.floating;inVideoFullscreen=ctx.fullscreen;
 activePanel=ctx.active;setChatActive(activePanel);
 const mode=document.getElementById('panel-mode')!;mode.textContent=floating?'固定':'浮动';mode.setAttribute('aria-label',floating?'切换为固定侧栏':'切换为浮动面板');
 const stored=(await browser.storage.session.get(panelStateKey(panelWindow)))[panelStateKey(panelWindow)] as PanelSnapshot|undefined;
 if(stored){savedScroll=stored.scroll??{};reviewQueue=stored.reviewQueue??[];reviewIdx=stored.reviewIdx??0;revealed=!!stored.revealed;previousView=stored.previousView??'list';(document.getElementById('search') as HTMLInputElement).value=stored.search??'';}
 const hash=location.hash.slice(1);switchView(isPanelView(hash)?hash:isPanelView(stored?.view)?stored.view:'subs');
 await restoreChat(stored?.chat);
 if(stored?.video){await pollSubs();videoWorkspace.restore(stored.video);}
 ready=activePanel;document.body.inert=!activePanel;
 workspaceInitialized=true;
 browser.runtime.onMessage.addListener((m:unknown)=>{const v=m as {type?:string;windowId?:number;tabId?:number;mode?:string;view?:unknown;origin?:string;at?:number};if(v.type==='pd-popup-outside'&&v.windowId===panelWindow&&v.origin==='page'){document.dispatchEvent(new CustomEvent('pd-popup-outside',{detail:{at:v.at}}));return;}if(v.type==='pd-panel-closed'&&v.windowId===panelWindow){void restoreChat();return;}if(v.type==='pd-panel-view'&&v.windowId===panelWindow){activePanel=v.mode===(floating?'floating':'fixed')&&(!floating||v.tabId===panelTabId);setChatActive(false);restoreVersion++;ready=false;document.body.inert=true;if(activePanel)void restorePanel(v.view).catch(error=>workspaceFailed('restore',error));}});
 if(floating)void send({type:'panelReady'});
 browser.runtime.onMessage.addListener((m:unknown)=>{const v=m as {type?:string;tabId?:number;fullscreen?:boolean};if(v.type==='pd-panel-fullscreen'&&v.tabId===panelTabId)inVideoFullscreen=!!v.fullscreen;});
}
let restoreVersion=0;
async function restorePanel(view?:unknown) {
  const version=++restoreVersion;
  ready=false;document.body.inert=true;setChatActive(false);
  const s=(await browser.storage.session.get(panelStateKey(panelWindow)))[panelStateKey(panelWindow)] as PanelSnapshot|undefined;
  if(version!==restoreVersion)return;
  if(s) {
    savedScroll=s.scroll??{};previousView=s.previousView??'list';
    reviewQueue=s.reviewQueue??[];reviewIdx=s.reviewIdx??0;revealed=!!s.revealed;
    (document.getElementById('search') as HTMLInputElement).value=s.search??'';
    if(isPanelView(view))switchView(view);else if(isPanelView(s.view))switchView(s.view);
    if(currentView==='review')renderReview();
    setChatActive(activePanel);await restoreChat(s.chat);
    if(version!==restoreVersion)return;
    if(s.video){await pollSubs();videoWorkspace.restore(s.video);}
    currentMain()?.scrollTo(0,savedScroll[currentView]??0);
  }
  if(version!==restoreVersion)return;
  workspaceFailureStage='';setChatActive(activePanel);ready=true;document.body.inert=false;
}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){void persistPanel();setChatActive(false);}else setChatActive(activePanel&&ready);});
void boot().catch(error=>workspaceFailed('boot',error));
