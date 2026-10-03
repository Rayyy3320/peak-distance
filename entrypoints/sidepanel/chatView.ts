import {
  CHAT_MATERIAL_BUDGET_CHARS,
  CHAT_QUESTION_MAX_CHARS,
  buildSegments,
  parseAnswerCitations,
  pickDefaultSegment,
  snapshotChars,
  type ChatMessageRecord,
  type ChatRecordView,
  type MaterialPayload,
  type QuoteRef,
  type SourceDescriptor,
} from '@/shared/chat';
import {
  CHAT_PORT_NAME,
  type ChatPortEvent,
  type ChatPortMessage,
  type ChatRecentItem,
  type ChatSourceInfo,
  type SubtitleCueView,
  type SubViewState,
} from '@/shared/messages';
import { videoContextUrl } from '@/shared/vocab';
import { fmtClock } from '@/shared/cues';
import { createDeleteButton } from '@/shared/deleteButton';
import { panelTransportFailure } from '@/shared/panel';

export interface ChatViewDeps {
  getActiveView(): string;
  switchView(view: string): void;
}

interface ChatScope {
  snapshotVersion: number;
  segmentIndex: number;
}

// ---- 基础工具 -------------------------------------------------------------------

function send<T>(msg: unknown): Promise<T | null> {
  return new Promise((resolve) => {
    const failed = (reason: unknown) => {
      console.warn('[pd] chat transport failed', { type: (msg as {type?:string}).type, reason: panelTransportFailure(reason) });
      resolve(null);
    };
    try {
      const pending = browser.runtime.sendMessage({ ...(msg as object), windowId: chatWindowId, editId: chatRecord?.editId }, (r: unknown) => {
        const error = browser.runtime.lastError;
        if (error) failed(error.message); else resolve((r as T) ?? null);
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

const ERROR_LABEL: Record<string, string> = {
  'commit-failed': '保存失败，内容已保留，请重试',
  'invalid-config': '请在设置中检查 AI 接口与模型',
  permission: '请在设置中重新保存 AI 配置并允许访问服务地址',
  'no-key': '尚未配置 API key',
  auth: 'API key 无效或无权限',
  'rate-limit': '请求过于频繁',
  network: '网络错误',
  http: '服务返回异常',
  'bad-response': '响应无法解析（可重试）',
  timeout: '等待超时（可重试）',
  'no-material': '材料缺失',
  busy: '当前对话已有回答在生成',
  'material-changed': '材料已改变，请按当前材料重新提问',
  'question-too-long': `问题超过 ${CHAT_QUESTION_MAX_CHARS} 字`,
  'empty-question': '先输入问题',
};

// ---- 状态 -----------------------------------------------------------------------

let deps: ChatViewDeps | null = null;

let chatWindowId = -1;
let chatId = '';
let historyOpen = false;
const generating = new Set<string>();
let sending: string | null = null;
let submittedInput = '';
let submittedQuoteKey = '';
let chatTabId: number | null = null;
let chatSource: SourceDescriptor | null = null;
let chatRecord: ChatRecordView | null = null;
let chatQuote: QuoteRef | null = null;
let chatSegmentIndex = 0;
let retainedOnly = false;
let autoScroll = true;
let messageScrollTop=0;
let port: ReturnType<typeof browser.runtime.connect> | null = null;
let subscribedKey: string | null = null;
let pendingAskFocus = false; // 从字幕列表带入引用后聚焦输入
let panelActive = true;
let operation = 0;
export interface ChatViewSnapshot {chatId:string;materialVersion:number|null;quoteKey:string;segmentIndex:number;historyOpen:boolean;retainedOnly:boolean;autoScroll:boolean;top:number}
export function snapshotChat():ChatViewSnapshot {const list=document.getElementById('chat-list');return {chatId,materialVersion:chatRecord?.activeSnapshotVersion??null,quoteKey:JSON.stringify(chatQuote),segmentIndex:chatSegmentIndex,historyOpen,retainedOnly,autoScroll,top:list?.clientHeight?list.scrollTop:messageScrollTop};}
export function setChatActive(active:boolean) {panelActive=active;if(!active)operation++;}
export async function restoreChat(snapshot?:ChatViewSnapshot) {
  const op = ++operation;
  const r=await send<{ok:boolean;chat:ChatRecordView}>({type:'chatActive'});
  if(op !== operation || !panelActive) return;
  if(!r?.ok||!r.chat)return;
  await acceptRecord(r.chat,false);
  (document.getElementById('chat-input') as HTMLTextAreaElement).value=r.chat.draft??'';
  if(snapshot?.chatId===chatId&&snapshot.materialVersion===(r.chat.activeSnapshotVersion??null)&&snapshot.quoteKey===JSON.stringify(chatQuote)){chatSegmentIndex=snapshot.segmentIndex;historyOpen=snapshot.historyOpen;retainedOnly=snapshot.retainedOnly;autoScroll=snapshot.autoScroll;messageScrollTop=snapshot.top;}
  renderChat();
  if(snapshot?.chatId===chatId&&!snapshot.autoScroll)document.getElementById('chat-list')!.scrollTop=snapshot.top;
}

// ---- 长连接 ---------------------------------------------------------------------

function connectPort(): void {
  if (port) return;
  try {
    port = browser.runtime.connect({ name: CHAT_PORT_NAME });
  } catch {
    port = null;
    return;
  }
  port.onMessage.addListener((ev: unknown) => onPortEvent(ev as ChatPortEvent));
  port.onDisconnect.addListener(() => {
    port = null;
    subscribedKey = null;
  });
  if (chatId) subscribe(chatId);
}

function subscribe(chatId: string): void {
  connectPort();
  if (!port) return;
  if (subscribedKey === chatId) return;
  subscribedKey = chatId;
  try {
    port.postMessage({ type: 'chat-subscribe', chatId } satisfies ChatPortMessage);
  } catch {
    /* ignore */
  }
}

function portSend(m: ChatPortMessage): void {
  connectPort();
  if (!port) {
    sending = null;
    inlineError('连接不可用，请重试');
    return;
  }
  try {
    port.postMessage(m);
  } catch {
    port = null;
    sending = null;
    inlineError('连接中断，请重试');
  }
}

function onPortEvent(ev: ChatPortEvent): void {
  if (!ev) return;
  if (ev.type === 'chat-active') {
    if (ev.active) generating.add(ev.chatId); else generating.delete(ev.chatId);
  } else if (ev.type === 'chat-ev') {
    if (ev.kind === 'start' || ev.kind === 'delta') generating.add(ev.chatId); else generating.delete(ev.chatId);
  }
  renderGenerationState();
  if (ev.type === 'chat-ack') {
    onAck(ev);
    return;
  }
  if (ev.type === 'chat-active') {
    if (ev.chatId === chatId && ev.active) void reloadRecord();
    return;
  }
  if (ev.type !== 'chat-ev') return;
  if (ev.chatId !== chatId) return; // 其它来源：不动当前视图
  if (!chatRecord) {
    void reloadRecord();
    return;
  }
  const msg = chatRecord.messages.find((m) => m.requestId === ev.requestId);
  if (!msg) {
    void reloadRecord();
    return;
  }
  msg.text = ev.text;
  if (ev.kind === 'delta' || ev.kind === 'start') msg.state = 'streaming';
  else if (ev.kind === 'done') {
    msg.state = 'done';
    (msg as ChatMessageRecord & { saved?: boolean }).saved = ev.saved === true;
  } else if (ev.kind === 'stopped') msg.state = 'stopped';
  else if (ev.kind === 'error') {
    msg.state = 'error';
    msg.errorKind = ev.errorKind;
  }
  renderMessages();
  renderInputState();
  renderGenerationState();
}

function inlineError(text: string): void {
  const box = document.getElementById('chat-meta-error');
  if (box) {
    box.textContent = text;
    box.hidden = false;
    setTimeout(() => {
      box.hidden = true;
    }, 3000);
  }
}

// ---- 记录与材料 -------------------------------------------------------------------

async function reloadRecord(): Promise<void> {
  if (!chatId) return;
  const id = chatId, op = operation;
  const r = await send<{ ok: boolean; chat: ChatRecordView | null }>({ type: 'chatActive' });
  if (r?.ok && r.chat && id === chatId && op === operation) await acceptRecord(r.chat);
}

function resetCitePanel(): void {
  const panel = document.getElementById('chat-cite-panel');
  if (panel) { panel.hidden = true; panel.textContent = ''; }
}

export async function saveDraft(): Promise<void> {
  if(!panelActive)return;
  const input = document.getElementById('chat-input') as HTMLTextAreaElement;
  if (chatRecord) await send({ type: 'chatSetDraft', chatId, draft: input.value.slice(0, 8000) });
}

async function acceptRecord(record: ChatRecordView, revealQuote = true): Promise<void> {
  if(!panelActive)return;
  const changed = chatId !== record.id || chatRecord?.editId !== record.editId;
  if (changed) {
    resetCitePanel();
    chatQuote = null;
    chatSegmentIndex = 0;
    retainedOnly = false;
    (document.getElementById('chat-input') as HTMLTextAreaElement).value = record.draft ?? '';
  }
  chatId = record.id;
  chatRecord = record;
  chatSource = record.source;
  if (record.pendingQuote && JSON.stringify(record.pendingQuote)!==JSON.stringify(chatQuote)) {
    chatQuote = record.pendingQuote;
    const snap = latestSnapshot();
    if (snap) chatSegmentIndex = pickDefaultSegment(buildSegments(snap.blocks, snap.source.sourceType), chatQuote.blockIds[0] ?? null);
    if(revealQuote){pendingAskFocus = true;deps?.switchView('chat');}
  }
  if(!record.pendingQuote)chatQuote=null;
  subscribe(chatId);
  renderChat();
  renderGenerationState();
}

let polling = false;
async function pollChatSource(): Promise<void> {
  if (polling || !panelActive) return;
  const op = operation;
  polling = true;
  try {
    const r = await send<{ ok: boolean; chat: ChatRecordView }>({ type: 'chatActive' });
    if (op !== operation) return;
    if (r?.ok && r.chat && (r.chat.editId !== chatRecord?.editId || r.chat.id !== chatId || JSON.stringify(r.chat.pendingQuote??null)!==JSON.stringify(chatQuote) || r.chat.updatedAt !== chatRecord?.updatedAt)) {
      await acceptRecord(r.chat);
    }
    if (historyOpen) void refreshHistory();
  } finally { polling = false; }
}

async function attachMaterial(kind: 'page' | 'selection' | 'video'): Promise<void> {
  const op = operation;
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (typeof tab?.id !== 'number') return;
  const info = await tabSend<ChatSourceInfo>(tab.id, { type: 'blc-chat-source' });
  if (!info?.source || (kind === 'video' && info.source.sourceType !== 'youtube')) {
    inlineError(kind === 'video' ? '当前页面没有可附加的视频字幕' : '当前页面无法附加材料，仍可直接提问');
    return;
  }
  const material = await tabSend<{ material: MaterialPayload | null }>(tab.id, {
    type: kind === 'selection' ? 'blc-chat-selection' : 'blc-chat-material',
  });
  if (!material?.material) { inlineError('没有可附加的内容，请先在页面选择文字'); return; }
  if (op !== operation) return;
  const r = await send<{ ok: boolean; chat: ChatRecordView }>({ type: 'chatEnsure', chatId, source: info.source, material: material.material });
  if (r?.ok && op === operation) { chatTabId = tab.id; chatQuote = null; chatSegmentIndex = 0; await acceptRecord(r.chat); }
}

async function newConversation(): Promise<void> {
  const op = ++operation;
  const r = await send<{ ok: boolean; chat: ChatRecordView }>({ type: 'chatNew' });
  if (r?.ok && op === operation) { historyOpen = false; await acceptRecord(r.chat); }
}

function renderGenerationState(): void {
  const tab = document.querySelector('[data-view="chat"]');
  if (tab) tab.textContent = generating.size ? 'AI 问答 · 生成中' : 'AI 问答';
}

// ---- 发送 / 停止 / 重试 ----------------------------------------------------------

function latestSnapshot() {
  return chatRecord?.snapshots.find(s => s.version === chatRecord?.activeSnapshotVersion) ?? null;
}

function currentSegments() {
  const snap = latestSnapshot();
  if (!snap) return null;
  const chars = snapshotChars(snap.blocks);
  if (chars <= CHAT_MATERIAL_BUDGET_CHARS) {
    return { overBudget: false, snap, segments: [{ index: 0, label: snap.label, blocks: snap.blocks }] };
  }
  return {
    overBudget: true,
    snap,
    segments: buildSegments(snap.blocks, snap.source.sourceType),
  };
}

function scopeOf(msg: ChatMessageRecord): ChatScope | null {
  const user = chatRecord?.messages.find(
    (m) => m.role === 'user' && m.turnId === msg.turnId,
  );
  if (!user?.snapshotVersion) return null;
  return { snapshotVersion: user.snapshotVersion, segmentIndex: user.segmentIndex ?? 0 };
}

function validCitationIds(msg: ChatMessageRecord): Set<string> {
  const scope = scopeOf(msg);
  if (!scope || !chatRecord) return new Set();
  const snap = chatRecord.snapshots.find((s) => s.version === scope.snapshotVersion);
  if (!snap) return new Set();
  const chars = snapshotChars(snap.blocks);
  if (chars <= CHAT_MATERIAL_BUDGET_CHARS) {
    return new Set(snap.blocks.map((b) => b.id));
  }
  const segments = buildSegments(snap.blocks, snap.source.sourceType);
  const seg = segments[Math.min(scope.segmentIndex, segments.length - 1)];
  return new Set(seg ? seg.blocks.map((b) => b.id) : []);
}

async function doSend(): Promise<void> {
  const input = document.getElementById('chat-input') as HTMLTextAreaElement;
  const question = input.value.trim();
  if (!question) return;
  if (question.length > CHAT_QUESTION_MAX_CHARS) {
    inlineError(ERROR_LABEL['question-too-long']!);
    return;
  }
  if (!chatRecord || sending === chatId) return;
  const id = chatId;
  const snapshotVersion = latestSnapshot()?.version ?? 0;
  const quote = chatQuote;
  const segmentIndex = chatSegmentIndex;
  sending = id;
  const editId = chatRecord.editId;
  submittedInput = input.value;
  submittedQuoteKey = JSON.stringify(chatQuote);
  await saveDraft();
  if (id !== chatId || editId !== chatRecord?.editId) { if (sending === id) sending = null; return; }
  portSend({
    type: 'chat-send',
    chatId: id,
    windowId: chatWindowId, editId,
    question,
    quote,
    snapshotVersion,
    segmentIndex,
  });

}

function doStop(): void {
  if (chatId) portSend({ type: 'chat-stop', chatId });
}

function doRetry(turnId: string): void {
  if (chatId) portSend({ type: 'chat-retry', chatId, turnId });
}

function onAck(
  payload: Extract<ChatPortEvent, { type: 'chat-ack' }>,
): void {
  if (sending === payload.chatId) sending = null;
  if (payload.chatId !== chatId || payload.editId && payload.editId !== chatRecord?.editId) return;
  if (!payload.ok) {
    if (payload.error === 'no-key') document.getElementById('chat-settings')!.hidden = false;
    inlineError(ERROR_LABEL[payload.error ?? ''] ?? payload.error ?? '发送失败');
    return;
  }
  if (!payload.editId) { void reloadRecord(); return; }
  chatId = payload.submittedChatId ?? chatId;
  subscribe(chatId);
  const input = document.getElementById('chat-input') as HTMLTextAreaElement;
  if (input.value === submittedInput) input.value = '';
  if (JSON.stringify(chatQuote) === submittedQuoteKey) chatQuote = null;
  pendingAskFocus = true;
  void reloadRecord();
}

// ---- 引用 -----------------------------------------------------------------------

async function openCitation(msg: ChatMessageRecord, blockId: string): Promise<void> {
  if (!chatRecord) return;
  const scope = scopeOf(msg);
  if (!scope) return;
  const snap = chatRecord.snapshots.find((s) => s.version === scope.snapshotVersion);
  const block = snap?.blocks.find((b) => b.id === blockId);
  if (!block || !snap) return;
  const isVideo = snap.source.sourceType === 'youtube';
  if (isVideo && typeof block.startMs === 'number') {
    const videoId = snap.source.video?.videoId;
    if (!videoId) return;
    // 复用 tabId + videoId 校验；原标签页已换视频则打开来源时间链接
    if (
      chatTabId !== null &&
      chatSource?.sourceType === 'youtube' &&
      chatSource.video?.videoId === videoId
    ) {
      const r = await tabSend<{ ok: boolean }>(chatTabId, {
        type: 'blc-sub-control',
        videoId,
        action: 'seek',
        timeMs: block.startMs,
      });
      if (r?.ok) {
        showCitationPanel(blockId, block.text, isVideo, true, snap.source);
        return;
      }
    }
    window.open(videoContextUrl(videoId, block.startMs), '_blank', 'noopener');
    showCitationPanel(blockId, block.text, isVideo, true, snap.source);
    return;
  }
  // 网页 / X：显示保存原文 + 尝试滚动定位
  let located = false;
  const tabs = await browser.tabs.query({});
  const sourceTab = tabs.find(t => t.url?.split('#')[0] === snap.source.url.split('#')[0]);
  if (typeof sourceTab?.id === 'number') {
    const r = await tabSend<{ found: boolean }>(sourceTab.id, {
      type: 'blc-chat-locate',
      text: block.text,
    });
    located = !!r?.found;
  }
  showCitationPanel(blockId, block.text, isVideo, located, snap.source);
}

function showCitationPanel(blockId: string, text: string, isVideo: boolean, located: boolean, source: SourceDescriptor): void {
  const panel = document.getElementById('chat-cite-panel')!;
  panel.textContent = '';
  const head = el('div', 'cite-head');
  const title = el('span', undefined, isVideo ? `引用 ${blockId}（已跳转）` : `引用 ${blockId}`);
  head.appendChild(title);
  if (!isVideo) {
    head.appendChild(el('span', 'cite-state', located ? '已定位到原文' : '页面已变化，显示保存的原文'));
  }
  const close = el('button', 'cite-close', '×');
  close.addEventListener('click', () => {
    panel.hidden = true;
  });
  head.appendChild(close);
  panel.appendChild(head);
  panel.appendChild(el('div', 'cite-text', text));
  if (source) {
    const link = el('a', 'cite-link', '打开来源');
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener';
    panel.appendChild(link);
  }
  panel.hidden = false;
}

// ---- 渲染 -----------------------------------------------------------------------

function renderChat(): void {
  if (!deps || deps.getActiveView() !== 'chat') return;
  renderHead();
  renderSegments();
  renderMessages();
  renderInputState();
}

function renderHead(): void {
  const head = document.getElementById('chat-head')!;
  const top = head.scrollTop;
  head.textContent = '';
  const row = el('div', 'chat-meta');
  row.appendChild(el('span', 'chat-title', chatRecord?.title ?? '新对话'));
  const addButton = (label: string, action: () => void) => {
    const b = el('button', 'chat-tool', label); b.addEventListener('click', action); row.appendChild(b);
  };
  addButton('新对话', () => void newConversation());
  addButton('历史', () => { historyOpen = !historyOpen; renderChat(); });
  row.lastElementChild?.setAttribute('aria-expanded', String(historyOpen));
  addButton(retainedOnly ? '显示全部' : '已保留', () => { retainedOnly = !retainedOnly; renderChat(); });
  row.lastElementChild?.setAttribute('aria-pressed', String(retainedOnly));
  clearButton.setDisabled(!chatId && !chatQuote && !latestSnapshot() && !(document.getElementById('chat-input') as HTMLTextAreaElement).value);
  row.append(clearButton.element);
  head.appendChild(row);
  const snap = latestSnapshot();
  if (snap) {
    const material = el('div', 'quote-row', `${snap.source.title} · ${snap.label}（v${snap.version}）`);
    const remove = el('button', 'chat-tool', '移除材料');
    remove.addEventListener('click', async () => {
      const op = operation;
      const r = await send<{ ok: boolean; chat: ChatRecordView }>({ type: 'chatRemoveMaterial', chatId });
      if (r?.ok && op === operation) { chatQuote = null; resetCitePanel(); await acceptRecord(r.chat); }
    });
    material.appendChild(remove); head.appendChild(material);
  } else head.appendChild(el('div', 'chat-scope', '自由提问，也可以附加阅读材料'));
  if (chatQuote) {
    const quote = el('div', 'quote-row', `引用：${chatQuote.expression || chatQuote.note || chatQuote.blockIds.join(', ')}`);
    const remove = el('button', 'chat-tool', '移除引用');
    remove.addEventListener('click', async () => {const op=operation;const r=await send<{ok:boolean}>({type:'chatTakeQuote',chatId});if(op!==operation)return;if(r?.ok){chatQuote = null;if(chatRecord)chatRecord.pendingQuote=null;renderChat();}else inlineError('移除失败，请重试');});
    quote.appendChild(remove); head.appendChild(quote);
  }
  historyList.hidden = !historyOpen;
  historyMeta.hidden = !historyOpen;
  head.append(historyMeta);
  head.append(historyList);
  head.scrollTop = top;
  if (historyOpen) void refreshHistory();
}

const historyList = el('div', 'chat-recent-list');
const historyMeta = el('div', 'chat-history-meta');
const historyTotal = el('span');
const historyFeedback = el('span'); historyFeedback.setAttribute('role', 'status');
historyMeta.append(historyTotal, historyFeedback);
const historyRows = new Map<string, { item: HTMLElement; open: HTMLButtonElement }>();
let historyRequest = 0;
const clearButton = createDeleteButton({ buttonText: '清空', onDelete: () => void clearConversation() });
async function refreshHistory(): Promise<void> {
  const request = ++historyRequest;
  const r = await send<{ ok: boolean; chats: ChatRecentItem[] }>({ type: 'chatRecent' });
  if (request !== historyRequest) return;
  if (!r?.ok) { if (!historyRows.size) historyList.textContent = '历史加载失败，请重试'; return; }
  historyTotal.textContent = `历史 · ${r.chats.length} 个对话`;
  if (!historyRows.size) historyList.textContent = '';
  const ids = new Set(r.chats.map(c => c.chatId));
  for (const [id, row] of historyRows) if (!ids.has(id)) { row.item.remove(); historyRows.delete(id); }
  for (const c of r.chats) {
    let row = historyRows.get(c.chatId);
    if (!row) {
      const item = el('div', 'chat-recent-row');
      const open = el('button', 'chat-tool');
      const error = el('span', 'chat-delete-error'); error.setAttribute('role', 'status');
      open.addEventListener('click', async () => {
        if (chatId === c.chatId) return;
        const op = ++operation;
        const selected = await send<{ ok: boolean; chat: ChatRecordView }>({ type: 'chatSelect', chatId: c.chatId });
        if (selected?.ok && op === operation) { historyOpen = false; await acceptRecord(selected.chat); }
        else if (!selected?.ok) error.textContent = '切换失败，请重试';
      });
      const remove = createDeleteButton({ onDelete: () => {
        remove.setDisabled(true); error.textContent = '';
        historyFeedback.textContent = '';
        const current = chatId === c.chatId;
        const op = current ? ++operation : operation;
        void send<{ ok: boolean }>({ type: 'chatDelete', chatId: c.chatId }).then(async result => {
          if (!result?.ok) { remove.setDisabled(false); error.textContent = '删除失败，请重试'; return; }
          historyRequest++;
          item.remove(); historyRows.delete(c.chatId);
          historyTotal.textContent = `历史 · ${historyRows.size} 个对话`;
          historyFeedback.textContent = '已删除一个对话';
          if (current && op === operation) {
            const active = await send<{ ok: boolean; chat: ChatRecordView }>({ type: 'chatActive' });
            if (active?.ok && op === operation) await acceptRecord(active.chat);
          }
          if (!historyRows.size) historyList.textContent = '还没有历史对话';
        });
      } });
      item.append(open, remove.element, error); row = { item, open }; historyRows.set(c.chatId, row);
    }
    row.open.textContent = `${c.title} · ${c.questions} 问`;
    if (!row.item.isConnected) historyList.append(row.item);
  }
  if (!r.chats.length) historyList.textContent = '还没有历史对话';
}

function renderSegments(): void {
  const box = document.getElementById('chat-segments')!;
  box.textContent = '';
  if (!chatRecord) return;
  const cur = currentSegments();
  if (!cur || !cur.overBudget || !cur.segments.length) return;
  const label = el('div', 'seg-label', '材料超出单次预算，选择讨论范围：');
  box.appendChild(label);
  const row = el('div', 'seg-row');
  for (const seg of cur.segments) {
    const b = el('button', seg.index === chatSegmentIndex ? 'seg on' : 'seg', seg.label);
    b.addEventListener('click', () => {
      chatSegmentIndex = seg.index;
      renderChat();
    });
    row.appendChild(b);
  }
  box.appendChild(row);
}

function assistantStateChip(msg: ChatMessageRecord): HTMLElement {
  if (msg.state === 'streaming') {
    return el('span', 'state streaming', msg.text ? '生成中…' : '正在准备回答');
  }
  if (msg.state === 'stopped') return el('span', 'state stopped', '已停止');
  if (msg.state === 'interrupted') return el('span', 'state stopped', '已中断');
  if (msg.state === 'error') {
    return el('span', 'state error', `失败：${ERROR_LABEL[msg.errorKind ?? ''] ?? msg.errorKind ?? '未知'}`);
  }
  const saved = (msg as ChatMessageRecord & { saved?: boolean }).saved;
  return el('span', 'state done', saved === false ? '已回答（未保存）' : '已回答');
}

function renderAnswerText(box: HTMLElement, msg: ChatMessageRecord): void {
  const valid = validCitationIds(msg);
  for (const token of parseAnswerCitations(msg.text)) {
    if (token.type === 'text') {
      box.appendChild(document.createTextNode(token.text));
      continue;
    }
    if (valid.has(token.id)) {
      const b = el('button', 'cite', `[${token.id}]`);
      b.title = '点击查看 / 跳转到原文';
      b.addEventListener('click', () => void openCitation(msg, token.id));
      box.appendChild(b);
    } else {
      box.appendChild(document.createTextNode(`[${token.id}]`));
    }
  }
}

function renderMessages(): void {
  if (!deps || deps.getActiveView() !== 'chat') return;
  const list = document.getElementById('chat-list')!;
  list.textContent = '';
  document.getElementById('view-chat')!.classList.toggle('is-empty', !chatRecord?.messages.length);
  const msgs = chatRecord?.messages ?? [];
  if (!msgs.length) {
    const welcome = el('div', 'chat-welcome');
    const title = el('h1', 'chat-welcome-title');
    const mark = el('span', 'brand-mark');
    const image = el('img'); image.src = '/brand/peak-mark-crop.png'; image.alt = '';
    mark.setAttribute('aria-hidden', 'true'); mark.appendChild(image);
    title.append(mark, el('span', undefined, '从一句话，读懂更多。'));
    welcome.append(title, el('p', undefined, '聊聊刚读到的内容，或从一个问题开始。'));
    list.appendChild(welcome);
    return;
  }
  const items: ChatMessageRecord[] = [];
  if (retainedOnly) {
    for (const m of msgs) {
      if (m.role === 'assistant' && m.retained) {
        const user = msgs.find((x) => x.role === 'user' && x.turnId === m.turnId);
        if (user) items.push(user);
        items.push(m);
      }
    }
    if (!items.length) {
      list.appendChild(el('div', 'chat-hint', '还没有保留的解释。回答完成后点“保留解释”存档。'));
      return;
    }
  } else {
    items.push(...msgs);
  }
  for (const m of items) {
    const item = el('div', `msg ${m.role}`);
    if (m.role === 'user') {
      if (m.scopeLabel) item.appendChild(el('div', 'scope', `[范围：${m.scopeLabel}]`));
      item.appendChild(el('div', 'q', m.text));
      if (m.quote?.expression) {
        item.appendChild(el('div', 'quote-ref', `引用：${m.quote.expression}`));
      }
    } else {
      const headRow = el('div', 'a-head');
      headRow.appendChild(assistantStateChip(m));
      if (m.state === 'streaming') {
        const stop = el('button', 'mini', '停止');
        stop.addEventListener('click', doStop);
        headRow.appendChild(stop);
      } else if (m.state === 'error' || m.state === 'interrupted' || m.state === 'stopped') {
        const retry = el('button', 'mini', '重试');
        retry.addEventListener('click', () => doRetry(m.turnId));
        headRow.appendChild(retry);
      }
      if (m.state === 'done' || m.state === 'stopped') {
        const retain = el(
          'button',
          m.retained ? 'mini on' : 'mini',
          m.retained ? '取消保留' : '保留解释',
        );
        retain.addEventListener('click', async () => {
          if (!chatId) return;
          await send({
            type: 'chatRetain',
            chatId,
            messageId: m.id,
            retained: !m.retained,
          });
          m.retained = !m.retained;
          renderMessages();
        });
        headRow.appendChild(retain);
      }
      item.appendChild(headRow);
      const body = el('div', 'a-text');
      renderAnswerText(body, m);
      if (m.state === 'streaming' && !m.text) {
        body.appendChild(el('span', 'pending', '……'));
      }
      item.appendChild(body);
    }
    list.appendChild(item);
  }
  const listEl = document.getElementById('chat-list')!;
  listEl.scrollTop = autoScroll ? listEl.scrollHeight : messageScrollTop;
  if (pendingAskFocus) {
    pendingAskFocus = false;
    (document.getElementById('chat-input') as HTMLTextAreaElement)?.focus();
  }
}

function renderInputState(): void {
  const input = document.getElementById('chat-input') as HTMLTextAreaElement | null;
  const sendBtn = document.getElementById('chat-send') as HTMLButtonElement | null;
  const stopBtn = document.getElementById('chat-stop') as HTMLButtonElement | null;
  const starters = document.getElementById('chat-starters')!;
  const inputRow = document.getElementById('chat-input-row')!;
  if (!input || !sendBtn || !stopBtn) return;
  const hasChat = true;
  inputRow.hidden = !hasChat;
  starters.textContent = '';
  if (latestSnapshot()) {
    for (const prompt of ['解释这句', '梳理观点', '举例说明']) {
      const b = el('button', 'starter', prompt);
      b.addEventListener('click', () => {
        input.value = chatQuote?.expression
          ? `${prompt}：${chatQuote.expression}`
          : `${prompt}（材料中你最关注的部分）`;
        input.focus();
        updateCount();
      });
      starters.appendChild(b);
    }
  }
  const streaming = chatRecord?.messages.some((m) => m.state === 'streaming');
  sendBtn.hidden = !!streaming;
  stopBtn.hidden = !streaming;
  updateCount();
}

function updateCount(): void {
  const input = document.getElementById('chat-input') as HTMLTextAreaElement | null;
  const count = document.getElementById('chat-count');
  if (!input || !count) return;
  const n = input.value.length;
  count.textContent = n > CHAT_QUESTION_MAX_CHARS ? `${n} / ${CHAT_QUESTION_MAX_CHARS}（超限）` : n ? `${n} / ${CHAT_QUESTION_MAX_CHARS}` : 'Ctrl / ⌘ + Enter 发送';
  count.classList.toggle('over', n > CHAT_QUESTION_MAX_CHARS);
}

async function clearConversation(): Promise<void> {
  const op = ++operation;
  clearButton.setDisabled(true);
  const r = await send<{ ok: boolean }>({ type: chatId ? 'chatClear' : 'chatNew', chatId });
  if (op !== operation) return;
  if (!r?.ok) { clearButton.setDisabled(false); inlineError('清空失败，请重试'); return; }
  const active = await send<{ ok: boolean; chat: ChatRecordView }>({ type: 'chatActive' });
  if (active?.ok && op === operation) await acceptRecord(active.chat);
}

// ---- 字幕列表「问 AI」入口 ---------------------------------------------------------

export async function subtitleAskAi(subs: SubViewState, cue: SubtitleCueView): Promise<void> {
  if (!subs.videoId || !subs.trackId) return;
  const source: SourceDescriptor = {
    sourceType: 'youtube',
    sourceKey: `yt:${subs.videoId}`,
    title: subs.title || subs.videoId,
    url: `https://www.youtube.com/watch?v=${subs.videoId}`,
    video: {
      videoId: subs.videoId,
      trackId: subs.trackId,
      trackKind: subs.trackKind === 'asr' ? 'asr' : 'manual',
      trackLang: subs.trackLang,
    },
  };
  const material: MaterialPayload = {
    label: '当前轨道完整字幕',
    blocks: subs.cues.map((c, i) => ({
      id: `p${i + 1}`,
      text: c.text,
      startMs: c.startMs,
      endMs: c.endMs,
    })),
  };
  const quote: QuoteRef = {
    blockIds: [`p${cue.id + 1}`],
    note: `${fmtClock(cue.startMs)} · ${cue.text.slice(0, 80)}`,
  };
  const r = await send<{ ok: boolean; chat: ChatRecordView | null }>({
    type: 'chatEnsure',
    source,
    material,
    quote,
  });
  if (!r?.ok) return;
  // 未发送引用留在会话中，直到提交或明确移除；容器切换不会消费它。
  if (r.chat) await acceptRecord(r.chat);
  deps?.switchView('chat');
}

// ---- 生命周期 ---------------------------------------------------------------------

export function initChatView(d: ChatViewDeps): void {
  deps = d;
  const attachments = document.getElementById('chat-attachments') as HTMLDetailsElement;
  for (const kind of ['page', 'selection', 'video'] as const) document.getElementById(`chat-attach-${kind}`)?.addEventListener('click', () => { attachments.open = false; void attachMaterial(kind); });
  document.getElementById('view-chat')?.addEventListener('click', e => { if (!attachments.contains(e.target as Node)) attachments.open = false; });
  attachments.addEventListener('keydown', e => { if (e.key === 'Escape') { attachments.open = false; attachments.querySelector('summary')?.focus(); } });
  document.getElementById('chat-settings')?.addEventListener('click', () => deps?.switchView('settings'));
  void browser.windows.getCurrent().then(w => {
    chatWindowId = w.id ?? -1;
    connectPort();
    void pollChatSource();
    setInterval(() => void pollChatSource(), 1500);
  });
  window.addEventListener('pagehide', () => { port?.disconnect(); });
  const input = document.getElementById('chat-input') as HTMLTextAreaElement | null;
  input?.addEventListener('input', () => {
    updateCount();
    void saveDraft();
    clearButton.setDisabled(false);
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void doSend();
    }
  });
  document.getElementById('chat-send')?.addEventListener('click', () => void doSend());
  document.getElementById('chat-stop')?.addEventListener('click', doStop);
  const list = document.getElementById('chat-list');
  list?.addEventListener('scroll', () => {
    if (!list || !list.clientHeight) return;
    messageScrollTop=list.scrollTop;
    const nearBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 60;
    autoScroll = nearBottom;
    const btn = document.getElementById('chat-latest');
    if (btn) btn.hidden = nearBottom;
  });
  document.getElementById('chat-latest')?.addEventListener('click', () => {
    const l = document.getElementById('chat-list');
    if (l) {
      autoScroll = true;
      l.scrollTop = l.scrollHeight;
      const btn = document.getElementById('chat-latest');
      if (btn) btn.hidden = true;
    }
  });
}

export function chatViewEnter(): void {
  connectPort();
  renderChat();
  void pollChatSource();
}

export function chatViewLeave(): void {
  const list=document.getElementById('chat-list');
  if(list?.clientHeight)messageScrollTop=list.scrollTop;
  void saveDraft();
}
