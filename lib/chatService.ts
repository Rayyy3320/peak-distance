import {
  appendChatTurn,
  clearChat,
  getChat,
  getVaultIdentity,
  listChats,
  resetChatTurn,
  saveAssistantProgress,
  setChatRetained,
} from './db';
import { enqueueChatWrite, flushVaultWrites } from './vault/sync';
import { chatCompletionStream } from './aiClient';
import { getAiConfig } from './aiTransport';
import { validateAiProfile, type AiConfig } from '@/shared/aiConfig';
import { openPanel } from './panelService';
import { readChatEdit, writeChatEdit, replaceChatEdit, activateChatEdit, beginChatOperation, chatOperation, ownsChatEdit } from './chatWorkspace';
import {
  editChatMaterial,
  CHAT_QUESTION_MAX_CHARS,
  buildChatMessages,
  buildSegments,
  historyForTurn,
  CHAT_MATERIAL_BUDGET_CHARS,
  snapshotChars,
  type MaterialBlock,
  type MaterialPayload,
  type QuoteRef,
  type SourceDescriptor,
} from '@/shared/chat';
import {
  CHAT_PORT_NAME,
  type BgcError,
  type ChatEnsureResult,
  type ChatGetResult,
  type ChatPortEvent,
  type ChatPortMessage,
} from '@/shared/messages';

// 等待首段正文的空闲超时与总时长上限
const STREAM_IDLE_TIMEOUT_MS = 60_000;
const STREAM_TOTAL_TIMEOUT_MS = 180_000;
const CHECKPOINT_INTERVAL_MS = 1_000;
const BROADCAST_THROTTLE_MS = 120;

// 材料载荷防御上限
const MAX_BLOCKS = 4000;
const MAX_MATERIAL_CHARS = 400_000;

interface ActiveChat {
  config: AiConfig;
  stopped?: boolean;
  chatId: string;
  turnId: string;
  requestId: string;
  controller: AbortController;
  text: string;
  dirty: boolean;
  lastBroadcastAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  totalTimer: ReturnType<typeof setTimeout> | null;
  checkpointTimer: ReturnType<typeof setInterval> | null;
}

const activeChats = new Map<string, ActiveChat>();
const submittingEdits = new Set<string>();
type ChatPort = Parameters<Parameters<typeof browser.runtime.onConnect.addListener>[0]>[0];
const portSubs = new Map<ChatPort, Set<string>>();

/** 该 requestId 是否正在生成（读路径据此避免把活占位误判为陈旧 streaming）。 */
function isLiveRequest(chatId: string): (requestId: string) => boolean {
  return (requestId: string) => activeChats.get(chatId)?.requestId === requestId;
}

function bad(error: string, detail?: string): BgcError {
  return { ok: false, error, detail };
}

function portsFor(chatId: string): ChatPort[] {
  const out: ChatPort[] = [];
  for (const [port, keys] of portSubs) {
    if (keys.has(chatId) && isLive(port)) out.push(port);
  }
  return out;
}

function isLive(port: ChatPort): boolean {
  // @ts-expect-error 内部字段探测；断开的端口直接跳过
  return !port._blcDead;
}

function post(port: ChatPort, ev: ChatPortEvent): void {
  try {
    port.postMessage(ev);
  } catch {
    // 断开的端口从订阅表移除（onDisconnect 兜底）
    portSubs.delete(port);
  }
}

function broadcast(chatId: string, ev: ChatPortEvent): void {
  for (const port of portsFor(chatId)) post(port, ev);
}

function broadcastActive(chatId: string): void {
  const active = activeChats.get(chatId);
  const ev: ChatPortEvent = {
    type: 'chat-active',
    chatId,
    active: active
      ? { requestId: active.requestId, turnId: active.turnId, text: active.text }
      : null,
  };
  broadcast(chatId, ev);
}

// ---- 载荷校验 -------------------------------------------------------------------

function validBlocks(blocks: unknown): MaterialBlock[] | null {
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > MAX_BLOCKS) return null;
  let total = 0;
  const out: MaterialBlock[] = [];
  for (const b of blocks) {
    const x = b as Record<string, unknown>;
    if (typeof x?.id !== 'string' || !/^p\d+$/.test(x.id)) return null;
    if (typeof x?.text !== 'string' || !x.text.trim()) return null;
    const block: MaterialBlock = { id: x.id, text: x.text };
    if (typeof x.startMs === 'number' && Number.isFinite(x.startMs) && x.startMs >= 0) {
      block.startMs = Math.round(x.startMs);
      if (typeof x.endMs === 'number' && Number.isFinite(x.endMs)) {
        block.endMs = Math.round(x.endMs);
      }
    }
    total += block.text.length;
    if (total > MAX_MATERIAL_CHARS) return null;
    out.push(block);
  }
  return out;
}

function parseMaterial(v: unknown): MaterialPayload | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  const blocks = validBlocks(s.blocks);
  if (!blocks) return null;
  return { label: typeof s.label === 'string' ? s.label.slice(0, 40) : '材料', blocks };
}

function parseQuote(v: unknown): QuoteRef | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  const ids = Array.isArray(s.blockIds)
    ? s.blockIds.filter((x): x is string => typeof x === 'string' && /^p\d+$/.test(x)).slice(0, 8)
    : [];
  const quote: QuoteRef = { blockIds: ids };
  if (typeof s.expression === 'string') quote.expression = s.expression.slice(0, 300);
  if (typeof s.definition === 'string') quote.definition = s.definition.slice(0, 600);
  if (typeof s.note === 'string') quote.note = s.note.slice(0, 200);
  return quote;
}

function parseSource(v: unknown): SourceDescriptor | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  if (
    s.sourceType !== 'youtube' &&
    s.sourceType !== 'article' &&
    s.sourceType !== 'x'
  ) {
    return null;
  }
  if (typeof s.sourceKey !== 'string' || !s.sourceKey || s.sourceKey.length > 600) return null;
  if (typeof s.title !== 'string') return null;
  if (typeof s.url !== 'string' || !/^https?:\/\//.test(s.url)) return null;
  const desc: SourceDescriptor = {
    sourceType: s.sourceType,
    sourceKey: s.sourceKey,
    title: s.title.slice(0, 300),
    url: s.url,
  };
  if (s.video && typeof s.video === 'object') {
    const vid = s.video as Record<string, unknown>;
    if (
      typeof vid.videoId === 'string' &&
      typeof vid.trackId === 'string' &&
      (vid.trackKind === 'manual' || vid.trackKind === 'asr') &&
      typeof vid.trackLang === 'string'
    ) {
      desc.video = {
        videoId: vid.videoId.slice(0, 32),
        trackId: vid.trackId.slice(0, 2000),
        trackKind: vid.trackKind,
        trackLang: vid.trackLang.slice(0, 32),
      };
    }
  }
  return desc;
}

// ---- 单轮执行 -------------------------------------------------------------------

async function runTurn(active: ActiveChat): Promise<void> {
  const { chatId, turnId, requestId } = active;
  const controller = active.controller;
  try {
    const record = await getChat(chatId, isLiveRequest(chatId));
    if (!record) return;
    const userMsg = record.messages.find((m) => m.role === 'user' && m.turnId === turnId);
    if (!userMsg || controller.signal.aborted) return;
    const snapshot = record.snapshots.find(s => s.version === userMsg.snapshotVersion) ?? null;
    const segments = snapshot ? (snapshotChars(snapshot.blocks) <= CHAT_MATERIAL_BUDGET_CHARS
      ? [{ index: 0, label: snapshot.label, blocks: snapshot.blocks }]
      : buildSegments(snapshot.blocks, snapshot.source.sourceType)) : [];
    const segment = segments[userMsg.segmentIndex ?? 0] ?? null;
    const history = historyForTurn(record.messages, turnId, userMsg.snapshotVersion ?? 0);
    const messages = buildChatMessages({
      snapshot,
      segment,
      question: userMsg.text,
      quote: userMsg.quote ?? null,
      history,
    });

    const clearTimers = () => {
      if (active.idleTimer) clearTimeout(active.idleTimer);
      if (active.totalTimer) clearTimeout(active.totalTimer);
      if (active.checkpointTimer) clearInterval(active.checkpointTimer);
      active.idleTimer = null;
      active.totalTimer = null;
      active.checkpointTimer = null;
    };
    const armIdle = () => {
      if (active.idleTimer) clearTimeout(active.idleTimer);
      active.idleTimer = setTimeout(() => {
        controller.abort('idle-timeout');
      }, STREAM_IDLE_TIMEOUT_MS);
    };
    const finish = async (
      state: 'done' | 'stopped' | 'error' | 'interrupted',
      errorKind?: string,
    ) => {
      clearTimers();
      if (activeChats.get(chatId) !== active || active.stopped) return;
      const saved = await saveAssistantProgress({
        chatId,
        requestId,
        text: active.text,
        state,
        errorKind,
      });
      if (activeChats.get(chatId) === active) activeChats.delete(chatId);
      persistChatToVault(chatId);
      broadcast(chatId, {
        type: 'chat-ev',
        chatId,
        requestId,
        turnId,
        kind: state === 'done' ? 'done' : state === 'stopped' ? 'stopped' : 'error',
        text: active.text,
        errorKind,
        saved,
      });
      broadcastActive(chatId);
    };

    active.totalTimer = setTimeout(() => {
      controller.abort('total-timeout');
    }, STREAM_TOTAL_TIMEOUT_MS);
    active.checkpointTimer = setInterval(() => {
      if (!active.dirty) return;
      active.dirty = false;
      void saveAssistantProgress({ chatId, requestId, text: active.text });
    }, CHECKPOINT_INTERVAL_MS);

    broadcast(chatId, {
      type: 'chat-ev',
      chatId,
      requestId,
      turnId,
      kind: 'start',
      text: '',
    });
    broadcastActive(chatId);

    armIdle();
    const r = await chatCompletionStream(active.config, messages, {
      signal: controller.signal,
      // 每个 SSE 事件（含 reasoning 增量）都重置空闲计时：推理阶段没有
      // content 增量，不能当成“无有效流事件”误判超时
      onEvent: armIdle,
      onText: (full) => {
        if (controller.signal.aborted || activeChats.get(chatId) !== active) return;
        active.text = full;
        active.dirty = true;
        const now = Date.now();
        if (now - active.lastBroadcastAt >= BROADCAST_THROTTLE_MS) {
          active.lastBroadcastAt = now;
          broadcast(chatId, {
            type: 'chat-ev',
            chatId,
            requestId,
            turnId,
            kind: 'delta',
            text: full,
          });
        }
      },
    });
    if (r.ok) {
      active.text = r.text;
      await finish('done');
    } else if (r.error === 'aborted') {
      // 停止（用户）或超时中止：保留已生成正文
      const reason = controller.signal.reason;
      const kind = reason === 'idle-timeout' || reason === 'total-timeout' ? 'timeout' : undefined;
      await finish(kind ? 'error' : 'stopped', kind);
    } else {
      await finish('error', r.error);
    }
  } catch (e) {
    // 兜底：编排层任何异常都以可重试错误收场，不留永久生成态
    console.warn('[blc] chat turn crashed', { error: String((e as Error)?.message ?? e) });
    if (activeChats.get(chatId)?.requestId === requestId) {
      if (active.idleTimer) clearTimeout(active.idleTimer);
      if (active.totalTimer) clearTimeout(active.totalTimer);
      if (active.checkpointTimer) clearInterval(active.checkpointTimer);
      activeChats.delete(chatId);
      const saved = await saveAssistantProgress({
        chatId,
        requestId,
        text: active.text,
        state: 'error',
        errorKind: 'internal',
      }).catch(() => false);
      persistChatToVault(chatId);
      broadcast(chatId, {
        type: 'chat-ev',
        chatId,
        requestId,
        turnId,
        kind: 'error',
        text: active.text,
        errorKind: 'internal',
        saved,
      });
      broadcastActive(chatId);
    }
  }
}

/** 终态后把完整会话提交学习库（streaming 中间态不写文件；失败保留待办）。 */
function persistChatToVault(chatId: string): void {
  void (async () => {
    try {
      if (!(await getVaultIdentity())) return;
      const record = await getChat(chatId);
      if (!record) return;
      await enqueueChatWrite(record);
      await flushVaultWrites();
    } catch {
      /* 队列持久化，下次活动补写 */
    }
  })();
}

async function stopChat(chatId: string, reason: string): Promise<void> {
  const active = activeChats.get(chatId);
  if (!active) return;
  active.stopped = true;
  active.controller.abort(reason);
  if (active.idleTimer) clearTimeout(active.idleTimer);
  if (active.totalTimer) clearTimeout(active.totalTimer);
  if (active.checkpointTimer) clearInterval(active.checkpointTimer);
  await saveAssistantProgress({ chatId, requestId: active.requestId, text: active.text, state: 'stopped' });
  if (activeChats.get(chatId) === active) activeChats.delete(chatId);
  persistChatToVault(chatId);
  broadcast(chatId, { type: 'chat-ev', chatId, requestId: active.requestId, turnId: active.turnId, kind: 'stopped', text: active.text, saved: true });
  broadcastActive(chatId);
}

// ---- 端口消息 -------------------------------------------------------------------

function ack(
  port: ChatPort,
  chatId: string,
  payload: { ok: true; turnId: string; requestId: string; submittedChatId?: string; editId?: string } | { ok: false; error: string; editId?: string },
): void {
  try {
    post(port, {
      type: 'chat-ack',
      chatId,
      ...payload,
    } as ChatPortEvent);
  } catch {
    /* ignore */
  }
}

async function onPortMessage(port: ChatPort, msg: unknown): Promise<void> {
  const m = msg as Partial<ChatPortMessage>;
  if (!m || typeof m.type !== 'string') return;
  switch (m.type) {
    case 'chat-subscribe': {
      if (typeof m.chatId !== 'string') return;
      portSubs.get(port)?.add(m.chatId);
      broadcastActive(m.chatId); // 新订阅者立即拿到当前生成状态
      return;
    }
    case 'chat-unsubscribe': {
      if (typeof m.chatId === 'string') portSubs.get(port)?.delete(m.chatId);
      return;
    }
    case 'chat-send': {
      if (typeof m.chatId !== 'string' || typeof m.question !== 'string') return;
      const question = m.question.trim();
      if (!question) {
        ack(port, m.chatId, { ok: false, error: 'empty-question' });
        return;
      }
      if (question.length > CHAT_QUESTION_MAX_CHARS) {
        ack(port, m.chatId, { ok: false, error: 'question-too-long' });
        return;
      }
      if (activeChats.has(m.chatId)) {
        ack(port, m.chatId, { ok: false, error: 'busy' });
        return;
      }
      const windowId = port.sender?.tab?.windowId ?? m.windowId ?? -1;
      const edit = await readChatEdit(windowId);
      const fail = (error: string) => ack(port, m.chatId!, { ok: false, error, editId: m.editId });
      if (edit.id !== m.chatId || (m.editId && edit.editId !== m.editId)) { fail('material-changed'); return; }
      const record = structuredClone(edit);
      const submittedDraft = edit.draft;
      const submittedQuote = JSON.stringify(edit.pendingQuote);
      const config = await getAiConfig();
      if (!config.apiKey) { fail('no-key'); return; }
      if (validateAiProfile(config)) { fail('invalid-config'); return; }
      if (!ownsChatEdit(windowId, edit)) { fail('material-changed'); return; }
      const version = record.activeSnapshotVersion ?? 0;
      if ((m.snapshotVersion ?? 0) !== version) { ack(port, m.chatId, { ok: false, error: 'material-changed' }); return; }
      const snapshot = record.snapshots.find(s => s.version === version);
      const segments = snapshot ? (snapshotChars(snapshot.blocks) <= CHAT_MATERIAL_BUDGET_CHARS
        ? [{ index: 0, label: snapshot.label, blocks: snapshot.blocks }]
        : buildSegments(snapshot.blocks, snapshot.source.sourceType)) : [];
      const segIndex = Math.min(Math.max(m.segmentIndex ?? 0, 0), Math.max(segments.length - 1, 0));
      const scopeLabel = segments[segIndex]?.label ?? '普通问答';
      if (activeChats.has(m.chatId) || submittingEdits.has(edit.editId!)) { fail('busy'); return; }
      submittingEdits.add(edit.editId!);
      const committedId = m.chatId || crypto.randomUUID();
      const turnId = crypto.randomUUID();
      const requestId = crypto.randomUUID();
      // 先登记生成中状态再落库：发送回执触发的读路径（chatGet）会把
      // streaming 占位误判为陈旧状态打成“已中断”——activeChats 在场即可免误杀
      const active: ActiveChat = {
        config,
        chatId: committedId,
        turnId,
        requestId,
        controller: new AbortController(),
        text: '',
        dirty: false,
        lastBroadcastAt: 0,
        idleTimer: null,
        totalTimer: null,
        checkpointTimer: null,
      };
      activeChats.set(committedId, active);
      const saved = await appendChatTurn({
        chatId: committedId,
        turnId,
        requestId,
        question,
        quote: snapshot ? parseQuote(m.quote) : null,
        snapshotVersion: version,
        segmentIndex: segIndex,
        scopeLabel,
        context: record, create: !m.chatId,
      }).catch(() => null);
      submittingEdits.delete(edit.editId!);
      if (!saved) {
        activeChats.delete(committedId);
        fail('commit-failed');
        return;
      }
      portSubs.get(port)?.add(committedId);
      // 已提交的问题保留，即使用户此时离开；旧回执不覆盖新的编辑工作区。
      if (ownsChatEdit(windowId, edit)) {
        const committed = await getChat(committedId, isLiveRequest(committedId));
        if (committed && ownsChatEdit(windowId, edit)) {
          await activateChatEdit(windowId, { ...edit, id: committedId, title: committed.title, messages: committed.messages,
            draft: edit.draft === submittedDraft ? '' : edit.draft,
            pendingQuote: JSON.stringify(edit.pendingQuote) === submittedQuote ? null : edit.pendingQuote });
        }
      }
      ack(port, m.chatId, { ok: true, turnId, requestId, submittedChatId: committedId, editId: m.editId });
      await runTurn(active);
      return;
    }
    case 'chat-stop': {
      if (typeof m.chatId !== 'string') return;
      await stopChat(m.chatId, 'user-stop');
      return;
    }
    case 'chat-retry': {
      if (typeof m.chatId !== 'string' || typeof m.turnId !== 'string') return;
      if (activeChats.has(m.chatId)) {
        ack(port, m.chatId, { ok: false, error: 'busy' });
        return;
      }
      const record = await getChat(m.chatId, isLiveRequest(m.chatId));
      const turn = record?.messages.find(x => x.role === 'user' && x.turnId === m.turnId);
      if (!turn || (turn.snapshotVersion ?? 0) !== (record?.activeSnapshotVersion ?? 0)) {
        ack(port, m.chatId, { ok: false, error: 'material-changed' }); return;
      }
      const config = await getAiConfig();
      if (!config.apiKey) { ack(port, m.chatId, { ok: false, error: 'no-key' }); return; }
      if (validateAiProfile(config)) { ack(port, m.chatId, { ok: false, error: 'invalid-config' }); return; }
      if (activeChats.has(m.chatId)) { ack(port, m.chatId, { ok: false, error: 'busy' }); return; }
      const requestId = crypto.randomUUID();
      // 同 chat-send：先登记再重置轮次，避免读路径误杀新占位
      const active: ActiveChat = {
        config,
        chatId: m.chatId,
        turnId: m.turnId,
        requestId,
        controller: new AbortController(),
        text: '',
        dirty: false,
        lastBroadcastAt: 0,
        idleTimer: null,
        totalTimer: null,
        checkpointTimer: null,
      };
      activeChats.set(m.chatId, active);
      const okReset = await resetChatTurn(m.chatId, m.turnId, requestId);
      if (!okReset) {
        activeChats.delete(m.chatId);
        ack(port, m.chatId, { ok: false, error: 'no-chat' });
        return;
      }
      ack(port, m.chatId, { ok: true, turnId: m.turnId, requestId });
      await runTurn(active);
      return;
    }
  }
}

// ---- runtime CRUD ---------------------------------------------------------------

export async function handleChatRequest(
  msg: unknown,
  sender: { tab?: { id?: number; windowId?: number } | null;nativeOpen?:Promise<boolean> },
): Promise<unknown> {
  const m = msg as Record<string, unknown>;
  const windowId = sender.tab?.windowId ?? (typeof m.windowId === 'number' ? m.windowId : -1);
  const activeKey = `chat-active:${windowId}`;
  const currentId = async () => (await browser.storage.session.get(activeKey))[activeKey] as string | undefined;
  // manifest 无 tabs 权限，Tab.url 恒为 undefined：来源标签页只能在 chatEnsure
  //（内容脚本发起）时按 windowId 记账，侧栏引用定位用它找回原页。
  const tabKey = `chat-tab:${windowId}`;
  const sourceTabId = async () => ((await browser.storage.session.get(tabKey))[tabKey] as number | undefined) ?? null;
  const operation = ['chatNew', 'chatSelect', 'chatClear'].includes(String(m.type)) ? beginChatOperation(windowId) : chatOperation(windowId);
  const currentOperation = () => chatOperation(windowId) === operation;
  switch (m.type) {
    case 'chatNew': {
      await activateChatEdit(windowId, null);
      return { ok: true, chat: await readChatEdit(windowId) };
    }
    case 'chatActive': {
      const edit = await readChatEdit(windowId);
      const id = await currentId();
      if (edit.id && edit.id === id) {
        const record = await getChat(edit.id, isLiveRequest(edit.id));
        if (!currentOperation()) return { ok: true, chat: await readChatEdit(windowId), sourceTabId: await sourceTabId() };
        if (!record) {
          if (ownsChatEdit(windowId, edit)) await activateChatEdit(windowId, null);
        } else if (ownsChatEdit(windowId, edit)) {
          edit.messages = record.messages;
          edit.updatedAt = Math.max(edit.updatedAt, record.updatedAt);
        }
      } else if (!edit.id && id) {
        const record = await getChat(id, isLiveRequest(id));
        if (record && currentOperation() && ownsChatEdit(windowId, edit)) await replaceChatEdit(windowId, record);
      }
      return { ok: true, chat: await readChatEdit(windowId), sourceTabId: await sourceTabId() };
    }
    case 'chatSelect': {
      if (typeof m.chatId !== 'string') return bad('bad-payload');
      const chat = await getChat(m.chatId, isLiveRequest(m.chatId));
      if (!chat) return bad('not-found');
      if (!currentOperation()) return bad('stale-edit');
      await activateChatEdit(windowId, { ...chat, draft: '', pendingQuote: null, editId: crypto.randomUUID() });
      return { ok: true, chat: await readChatEdit(windowId) };
    }
    case 'chatRemoveMaterial': {
      const edit = await readChatEdit(windowId);
      if (edit.id !== m.chatId || (m.editId && m.editId !== edit.editId)) return bad('stale-edit');
      editChatMaterial(edit, { removeMaterial: true });
      await writeChatEdit(windowId, edit);
      return { ok: true, chat: edit };
    }
    case 'chatGet': {
      if (typeof m.chatId !== 'string' || !m.chatId) return bad('bad-payload', 'chatId');
      const r: ChatGetResult = {
        ok: true,
        chat: await getChat(m.chatId, isLiveRequest(m.chatId)),
      };
      return r;
    }
    case 'chatRecent': {
      return { ok: true, chats: await listChats() };
    }
    case 'chatEnsure': {
      const source = parseSource(m.source);
      if (!source) return bad('bad-payload', 'source');
      const material = m.material === null || m.material === undefined ? null : parseMaterial(m.material);
      if (m.material != null && !material) return bad('bad-payload', 'material');
      const quote = m.quote == null ? null : parseQuote(m.quote);
      // 先调用打开动作（用户点击手势窗口内），再异步准备材料（spec §1）
      let panelOpened = false;
      if (m.openPanel === true) {
        const tabId = sender.tab?.id;
        if (typeof tabId === 'number') {
          panelOpened = (await openPanel(tabId,windowId,'chat',undefined,sender.nativeOpen)).ok;
        }
      }
      const edit = await readChatEdit(windowId);
      if (!currentOperation()) return bad('stale-edit');
      if (typeof m.chatId === 'string' && m.chatId !== edit.id || m.editId && m.editId !== edit.editId) return bad('stale-edit');
      editChatMaterial(edit, { source, material, quote });
      await writeChatEdit(windowId, edit);
      if (typeof sender.tab?.id === 'number') {
        await browser.storage.session.set({ [tabKey]: sender.tab.id });
      }
      const r: ChatEnsureResult = { ok: true, chat: edit, panelOpened, sourceTabId: await sourceTabId() };
      return r;
    }
    case 'chatUpdateMaterial': {
      const material = parseMaterial(m.material);
      if (!material) return bad('bad-payload', 'material');
      const edit = await readChatEdit(windowId);
      if (edit.id !== m.chatId || m.editId && m.editId !== edit.editId) return bad('stale-edit');
      editChatMaterial(edit, { source: edit.source, material });
      await writeChatEdit(windowId, edit);
      return { ok: true, chat: edit };
    }
    case 'chatSetDraft': {
      if (typeof m.chatId !== 'string' || typeof m.draft !== 'string') return bad('bad-payload');
      const edit = await readChatEdit(windowId);
      if (edit.id !== m.chatId || m.editId !== edit.editId) return bad('stale-edit');
      edit.draft = m.draft.slice(0, 8000);
      await writeChatEdit(windowId, edit);
      return { ok: true };
    }
    case 'chatTakeQuote': {
      const edit = await readChatEdit(windowId);
      if (edit.id !== m.chatId || m.editId && m.editId !== edit.editId) return bad('stale-edit');
      const quote = edit.pendingQuote; edit.pendingQuote = null;
      await writeChatEdit(windowId, edit);
      return { ok: true, quote };
    }
    case 'chatRetain': {
      if (
        typeof m.chatId !== 'string' ||
        typeof m.messageId !== 'string' ||
        typeof m.retained !== 'boolean'
      ) {
        return bad('bad-payload');
      }
      const ok = await setChatRetained(m.chatId, m.messageId, m.retained);
      if (!ok) return bad('not-found');
      return { ok: true };
    }
    case 'chatDelete':
    case 'chatClear': {
      if (typeof m.chatId !== 'string' || !m.chatId) return bad('bad-payload', 'chatId');
      await stopChat(m.chatId, 'cleared');
      const removed = await clearChat(m.chatId);
      if (!removed) return bad('not-found');
      if (await currentId() === m.chatId && currentOperation()) await activateChatEdit(windowId, null);
      broadcastActive(m.chatId);
      return { ok: true };
    }
    default:
      return undefined;
  }
}

// ---- 初始化 ---------------------------------------------------------------------

export function initChatService(): void {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== CHAT_PORT_NAME || port.sender?.id !== browser.runtime.id) return;
    portSubs.set(port, new Set());
    port.onMessage.addListener((msg) => {
      void onPortMessage(port, msg).catch(() => {});
    });
    port.onDisconnect.addListener(() => {
      // @ts-expect-error 标记失效（postMessage 兜底之外的双保险）
      port._blcDead = true;
      const subs = portSubs.get(port) ?? new Set<string>();
      portSubs.delete(port);
      // 某来源再无订阅端口（侧栏关闭 / 切出问答视图）：停止其生成
      for (const key of subs) {
        if (!portsFor(key).length && activeChats.has(key)) {
          void stopChat(key, 'no-subscriber');
        }
      }
    });
  });
}
