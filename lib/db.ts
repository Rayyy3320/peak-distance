// 学习数据存取：扩展自身源下的 IndexedDB（仅 background 使用）。
// 词条与上下文的保存 / 删除在单一事务中完成；写入内容完全由
// shared/vocab.ts 的 planSave 等纯决策产生（tools/regress.ts 离线回归）。
//
// 兼容 M1 数据（不清库重建）：旧上下文缺 sourceType / video 字段，
// 读取时按 web 处理；词条键与上下文 ID 保持稳定。
// M6 增量新增 conversations，将旧 chats 一条迁为一个独立会话。
// 旧 store 保留作兼容备份；版本升级仅执行一次，材料快照保留原来源。

import {
  buildFormIndex,
  normalizeExpression,
  planSave,
  shouldBackfill,
  type ContextRecord,
  type LearningResult,
  type ContextExplanation,
  type LookupSnapshot,
  type VocabEntryRecord,
  type VocabIndexItem,
  type VocabStatus,
  type SavedSentence,
} from '@/shared/vocab';
import {
  migrateLegacyChat,
  type ChatMessageRecord,
  type ChatRecord,
  type QuoteRef,
} from '@/shared/chat';
import type { EntryView, SaveResult } from '@/shared/messages';
import { effectiveEntryLanguage, normalizeLangTag, entryKeyOf, parseEntryKey, LANG_UNDETERMINED } from '@/shared/languages';
import { planLegacyLanguage } from '@/shared/vocab';
import type { VaultIdentity, VaultPendingWrite, VaultStatus } from '@/shared/vault';

const DB_NAME = 'blc-learning';
const DB_VERSION = 5;
const ENTRIES = 'entries';
const CONTEXTS = 'contexts';
const CHATS = 'conversations';
const VAULT = 'vault'; // 目录句柄 + 库身份（仅 background 读写）
const VAULT_QUEUE = 'vaultQueue'; // 待写入学习库的队列（幂等键 id）

function px<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 等待事务完成（原生 IDBTransaction 无 .done 属性）。 */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sentences')) db.createObjectStore('sentences', { keyPath: 'id' });
      if (!db.objectStoreNames.contains(ENTRIES)) {
        db.createObjectStore(ENTRIES, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(CONTEXTS)) {
        const s = db.createObjectStore(CONTEXTS, { keyPath: 'id', autoIncrement: true });
        s.createIndex('entryKey', 'entryKey');
      }
      if (!db.objectStoreNames.contains(CHATS)) {
        const conversations = db.createObjectStore(CHATS, { keyPath: 'id' });
        if (db.objectStoreNames.contains('chats')) {
          const cursor = req.transaction!.objectStore('chats').openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) return;
            conversations.put(migrateLegacyChat(row.value));
            row.continue();
          };
        }
      }
      // M11 v5：学习库句柄／身份（out-of-line 键 'handle'/'identity'）与待写入队列。
      // 不迁移旧词条语言 —— 语言赋值由专门迁移批次按证据执行（spec 第 5 节）。
      if (!db.objectStoreNames.contains(VAULT)) db.createObjectStore(VAULT);
      if (!db.objectStoreNames.contains(VAULT_QUEUE)) db.createObjectStore(VAULT_QUEUE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

function toEntryView(e: VocabEntryRecord, contexts: ContextRecord[]): EntryView {
  return {
    key: e.key,
    language: e.language,
    expression: e.expression,
    note: e.note,
    kind: e.kind,
    status: e.status,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    forms: e.forms ?? [],
    contexts: contexts
      .filter((c) => c.entryKey === e.key && typeof c.id === 'number')
      .map((c) => ({
        id: c.id!,
        sentence: c.sentence,
        definition: c.definition,
        result: c.result,
        explanation: c.explanation,
        sourceType: c.sourceType ?? 'web', // 旧记录缺字段按 web 读
        url: c.url,
        title: c.title,
        createdAt: c.createdAt,
        video: c.video ?? null,
      }))
      .sort((a, b) => b.createdAt - a.createdAt),
  };
}

/**
 * 表面词形 → 实际词条：精确键优先；否则取唯一词形关联；
 * 冲突或无关联返回 undefined（保留独立表达）。
 */
export async function resolveEntry(key: string): Promise<VocabEntryRecord | undefined> {
  return withDb(async (db) => {
    const tx = db.transaction([ENTRIES], 'readonly');
    const direct = (await px(tx.objectStore(ENTRIES).get(key))) as
      | VocabEntryRecord
      | undefined;
    if (direct) return direct;
    const all = (await px(tx.objectStore(ENTRIES).getAll())) as VocabEntryRecord[];
    await txDone(tx);
    const owner = buildFormIndex(all).get(key);
    return owner ? all.find((e) => e.key === owner) : undefined;
  });
}

/** 保存词条 + 上下文（单一事务）。返回生效状态与上下文 id。
 * 词形关联在此合并：被其它词条占用或本身是独立词条键的词形不并入。 */
export async function saveSnapshot(
  snapshot: LookupSnapshot,
  opts: { status?: VocabStatus; definition?: string; forms?: string[]; result?: LearningResult; explanation?: ContextExplanation },
): Promise<SaveResult | null> {
  return withDb(async (db) => {
    const tx = db.transaction([ENTRIES, CONTEXTS], 'readwrite');
    const entries = tx.objectStore(ENTRIES);
    const contexts = tx.objectStore(CONTEXTS);

    // 先做纯决策，再在同一事务内落地。键与 planSave 共用同一规范化函数。
    const key = normalizeExpression(snapshot.expression);
    // 词形关联：查词 'constrained' 落到词条 'constrain' 时，上下文键用目标键。
    const direct = (await px(entries.get(key))) as VocabEntryRecord | undefined;
    let existingEntry = direct;
    let entryKey = key;
    if (!existingEntry) {
      const allPre = (await px(entries.getAll())) as VocabEntryRecord[];
      const owner = buildFormIndex(allPre).get(key);
      if (owner) {
        entryKey = owner;
        existingEntry = (await px(entries.get(owner))) as VocabEntryRecord | undefined;
      }
    }
    const allContexts = (await px(
      contexts.index('entryKey').getAll(entryKey),
    )) as ContextRecord[];
    const plan = planSave(existingEntry, allContexts, snapshot, opts);
    if (!plan) return null;

    if (opts.result) plan.context.result = opts.result;
    if (opts.explanation && opts.explanation.sentence === snapshot.sentence) plan.context.explanation = opts.explanation;

    entries.put(plan.entry);
    let contextId: number;
    if (plan.appended) {
      contextId = (await px(contexts.add(plan.context))) as number;
    } else {
      contextId = plan.context.id!;
      contexts.put({ ...plan.context, id: contextId });
    }
    await txDone(tx);
    return {
      ok: true as const,
      status: plan.status,
      contextId,
      appended: plan.appended,
      key: plan.entry.key,
    };
  });
}

export async function getEntry(key: string): Promise<EntryView | null> {
  return withDb(async (db) => {
    const tx = db.transaction([ENTRIES, CONTEXTS], 'readonly');
    const direct = (await px(tx.objectStore(ENTRIES).get(key))) as
      | VocabEntryRecord
      | undefined;
    let entry = direct;
    if (!entry) {
      const all = (await px(tx.objectStore(ENTRIES).getAll())) as VocabEntryRecord[];
      const owner = buildFormIndex(all).get(key);
      entry = owner ? all.find((e) => e.key === owner) : undefined;
    }
    if (!entry) return null;
    const contexts = (await px(
      tx.objectStore(CONTEXTS).index('entryKey').getAll(entry.key),
    )) as ContextRecord[];
    await txDone(tx);
    return toEntryView(entry, contexts);
  });
}

export async function listEntries(query?: string, language?: string): Promise<EntryView[]> {
  return withDb(async (db) => {
    const tx = db.transaction([ENTRIES, CONTEXTS], 'readonly');
    const entries = (await px(tx.objectStore(ENTRIES).getAll())) as VocabEntryRecord[];
    const contexts = (await px(tx.objectStore(CONTEXTS).getAll())) as ContextRecord[];
    await txDone(tx);
    const q = query?.trim().toLowerCase() ?? '';
    // 语言筛选：'all'／缺省 = 全部；'und' = 待确认集合（已迁移、证据不足）。
    // 迁移前旧记录（无语言）只在全部视图出现，不冒充任何语言。
    const wantLang = !language || language === 'all' ? null : normalizeLangTag(language);
    return entries
      .filter((e) => {
        if (wantLang && effectiveEntryLanguage(e) !== wantLang) return false;
        return !q || e.key.includes(q) || e.expression.toLowerCase().includes(q);
      })
      .map((e) => toEntryView(e, contexts))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

/** 轻量索引：content script 标记与词形解析用，不含上下文。 */
export async function listIndex(): Promise<VocabIndexItem[]> {
  return withDb(async (db) => {
    const tx = db.transaction([ENTRIES], 'readonly');
    const entries = (await px(tx.objectStore(ENTRIES).getAll())) as VocabEntryRecord[];
    await txDone(tx);
    return entries.map((e) => ({
      key: e.key,
      language: e.language,
      expression: e.expression,
      status: e.status,
      forms: e.forms ?? [],
    }));
  });
}

/** 个人笔记（M11：学习库“我的笔记”同源字段；空串清除）。 */
export async function setEntryNote(key: string, note: string): Promise<boolean> {
  return withDb(async (db) => {
    const tx = db.transaction([ENTRIES], 'readwrite');
    const store = tx.objectStore(ENTRIES);
    const entry = (await px(store.get(key))) as VocabEntryRecord | undefined;
    if (!entry) {
      await txDone(tx);
      return false;
    }
    if (note.trim()) entry.note = note.slice(0, 4000);
    else delete entry.note;
    entry.updatedAt = Date.now();
    store.put(entry);
    await txDone(tx);
    return true;
  });
}

export async function setStatus(key: string, status: VocabStatus): Promise<boolean> {
  return withDb(async (db) => {
    const tx = db.transaction([ENTRIES], 'readwrite');
    const store = tx.objectStore(ENTRIES);
    const entry = (await px(store.get(key))) as VocabEntryRecord | undefined;
    if (!entry) {
      await txDone(tx);
      return false;
    }
    entry.status = status;
    entry.updatedAt = Date.now();
    store.put(entry);
    await txDone(tx);
    return true;
  });
}

/** 删除词条连同其全部上下文（单一事务）。词条删除后其词形关联一并消失。 */
export async function deleteEntry(key: string): Promise<boolean> {
  return withDb(async (db) => {
    const tx = db.transaction([ENTRIES, CONTEXTS], 'readwrite');
    const entries = tx.objectStore(ENTRIES);
    const contexts = tx.objectStore(CONTEXTS);
    const existing = (await px(entries.get(key))) as VocabEntryRecord | undefined;
    if (!existing) {
      await txDone(tx);
      return false;
    }
    const ids = (await px(contexts.index('entryKey').getAllKeys(key))) as IDBValidKey[];
    for (const id of ids) contexts.delete(id);
    entries.delete(key);
    await txDone(tx);
    return true;
  });
}

/** 上下文补释义：仅当该上下文尚无释义时写入。 */
export async function backfillDefinition(
  contextId: number,
  definition: string,
): Promise<boolean> {
  return withDb(async (db) => {
    const tx = db.transaction([CONTEXTS], 'readwrite');
    const store = tx.objectStore(CONTEXTS);
    const context = (await px(store.get(contextId))) as ContextRecord | undefined;
    if (!shouldBackfill(context)) {
      await txDone(tx);
      return false;
    }
    store.put({ ...context!, definition });
    await txDone(tx);
    return true;
  });
}

/** 移除词条上的一个词形关联（侧栏管理入口）。 */
export async function removeForm(key: string, form: string): Promise<boolean> {
  return withDb(async (db) => {
    const tx = db.transaction([ENTRIES], 'readwrite');
    const store = tx.objectStore(ENTRIES);
    const entry = (await px(store.get(key))) as VocabEntryRecord | undefined;
    if (!entry || !entry.forms?.length) {
      await txDone(tx);
      return false;
    }
    const forms = entry.forms.filter((f) => f !== form);
    if (forms.length === entry.forms.length) {
      await txDone(tx);
      return false;
    }
    entry.forms = forms;
    entry.updatedAt = Date.now();
    store.put(entry);
    await txDone(tx);
    return true;
  });
}

// ---- 独立问答会话（conversations store） ---------------------------------------------------

export async function getChat(
  chatId: string,
  isLive?: (requestId: string) => boolean,
): Promise<ChatRecord | null> {
  return withDb(async (db) => {
    const tx = db.transaction([CHATS], 'readwrite'); // 读 + 归一写
    const store = tx.objectStore(CHATS);
    const record = (await px(store.get(chatId))) as ChatRecord | undefined;
    if (!record) {
      await txDone(tx);
      return null;
    }
    // SW / 连接中断后遗留的 streaming 态恢复为“已中断”；但正在生成的请求
    //（background activeChats 里登记的 requestId）必须保持 streaming，
    // 否则发送回执触发的读路径会把刚落库的活占位误杀成“已中断”。
    let dirty = false;
    for (const m of record.messages) {
      if (m.role === 'assistant' && m.state === 'streaming') {
        const live = m.requestId && isLive ? isLive(m.requestId) : false;
        if (!live) {
          m.state = 'interrupted';
          dirty = true;
        }
      }
    }
    if (dirty) {
      record.updatedAt = Date.now();
      store.put(record);
    }
    await txDone(tx);
    return record;
  });
}

/** 最近会话列表（问答空态的会话管理：广告帖等无法再进入的会话可在此清理）。 */
export async function listChats(): Promise<
  {
    chatId: string;
    sourceType: 'youtube' | 'article' | 'x' | null;
    title: string;
    url: string;
    questions: number;
    updatedAt: number;
  }[]
> {
  return withDb(async (db) => {
    const tx = db.transaction([CHATS], 'readonly');
    const all = (await px(tx.objectStore(CHATS).getAll())) as ChatRecord[];
    await txDone(tx);
    return all
      .map((r) => ({
        chatId: r.id,
        sourceType: r.source?.sourceType ?? null,
        title: r.title,
        url: r.source?.url ?? '',
        questions: r.messages.filter((m) => m.role === 'user').length,
        updatedAt: r.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

/** 发送前落库：用户消息 + 该次回答的 streaming 占位（同一事务，请求归属固定）。 */
export async function appendChatTurn(input: {
  chatId: string;
  turnId: string;
  requestId: string;
  question: string;
  quote: QuoteRef | null;
  snapshotVersion: number;
  segmentIndex: number;
  scopeLabel: string;
  context?: ChatRecord;
  create?: boolean;
}): Promise<ChatMessageRecord | null> {
  return withDb(async (db) => {
    const tx = db.transaction([CHATS], 'readwrite');
    const store = tx.objectStore(CHATS);
    let record = (await px(store.get(input.chatId))) as ChatRecord | undefined;
    if (!record && input.create && input.context) record = { ...input.context, id: input.chatId };
    if (!record) {
      await txDone(tx);
      return null;
    }
    const now = Date.now();
    if (input.context) {
      record.source = input.context.source; record.sourceKey = input.context.sourceKey;
      record.snapshots = input.context.snapshots;
      record.activeSnapshotVersion = input.context.activeSnapshotVersion;
    }
    const userMsg: ChatMessageRecord = {
      id: crypto.randomUUID(),
      role: 'user',
      turnId: input.turnId,
      text: input.question,
      at: now,
      quote: input.quote ?? undefined,
      snapshotVersion: input.snapshotVersion,
      segmentIndex: input.segmentIndex,
      scopeLabel: input.scopeLabel,
    };
    const assistantMsg: ChatMessageRecord = {
      id: crypto.randomUUID(),
      role: 'assistant',
      turnId: input.turnId,
      text: '',
      at: now,
      requestId: input.requestId,
      state: 'streaming',
    };
    if (!record.messages.some(m => m.role === 'user')) record.title = input.question.slice(0, 40);
    record.draft = '';
    record.pendingQuote = null;
    record.messages.push(userMsg, assistantMsg);
    record.updatedAt = now;
    store.put(record);
    await txDone(tx);
    return assistantMsg;
  });
}

/**
 * 回答进度 / 终态写入。守卫：消息必须属于该 requestId；增量只写 streaming 态，
 * 终态（done/stopped/error/interrupted）允许覆盖。停止 / 清空后的迟到增量被丢弃。
 */
export async function saveAssistantProgress(input: {
  chatId: string;
  requestId: string;
  text?: string;
  state?: 'streaming' | 'done' | 'stopped' | 'error' | 'interrupted';
  errorKind?: string;
}): Promise<boolean> {
  return withDb(async (db) => {
    const tx = db.transaction([CHATS], 'readwrite');
    const store = tx.objectStore(CHATS);
    const record = (await px(store.get(input.chatId))) as ChatRecord | undefined;
    if (!record) {
      await txDone(tx);
      return false; // 已被清空：迟到结果不复活
    }
    const msg = record.messages.find(
      (m) => m.role === 'assistant' && m.requestId === input.requestId,
    );
    if (!msg) {
      await txDone(tx);
      return false;
    }
    const isTerminal =
      input.state && input.state !== 'streaming' ? true : false;
    if (msg.state !== 'streaming') {
      await txDone(tx);
      return false; // 该尝试已停止 / 结束：旧增量不写回
    }
    if (input.text !== undefined) msg.text = input.text;
    if (isTerminal && input.state) {
      msg.state = input.state;
      if (input.errorKind) msg.errorKind = input.errorKind;
    }
    record.updatedAt = Date.now();
    store.put(record);
    await txDone(tx);
    return true;
  });
}

/** 重试：同一 turn 的回答尝试重置（新 requestId、清空正文），不追加用户消息。 */
export async function resetChatTurn(
  chatId: string,
  turnId: string,
  requestId: string,
): Promise<boolean> {
  return withDb(async (db) => {
    const tx = db.transaction([CHATS], 'readwrite');
    const store = tx.objectStore(CHATS);
    const record = (await px(store.get(chatId))) as ChatRecord | undefined;
    if (!record) {
      await txDone(tx);
      return false;
    }
    let msg = record.messages.find((m) => m.role === 'assistant' && m.turnId === turnId);
    if (!msg) {
      msg = {
        id: crypto.randomUUID(),
        role: 'assistant',
        turnId,
        text: '',
        at: Date.now(),
      };
      record.messages.push(msg);
    }
    msg.requestId = requestId;
    msg.state = 'streaming';
    msg.text = '';
    msg.errorKind = undefined;
    record.updatedAt = Date.now();
    store.put(record);
    await txDone(tx);
    return true;
  });
}

export async function setChatRetained(
  chatId: string,
  messageId: string,
  retained: boolean,
): Promise<boolean> {
  return withDb(async (db) => {
    const tx = db.transaction([CHATS], 'readwrite');
    const store = tx.objectStore(CHATS);
    const record = (await px(store.get(chatId))) as ChatRecord | undefined;
    if (!record) {
      await txDone(tx);
      return false;
    }
    const msg = record.messages.find((m) => m.id === messageId);
    if (!msg || msg.role !== 'assistant') {
      await txDone(tx);
      return false;
    }
    msg.retained = retained;
    record.updatedAt = Date.now();
    store.put(record);
    await txDone(tx);
    return true;
  });
}

/** 清空当前对话：连同材料快照、引用与保留标记（不动生词本与原有上下文）。 */
export async function clearChat(chatId: string): Promise<boolean> {
  return withDb(async (db) => {
    const tx = db.transaction([CHATS], 'readwrite');
    const store = tx.objectStore(CHATS);
    const record = await px(store.get(chatId)) as ChatRecord | undefined;
    if (!record) { await txDone(tx); return false; }
    store.delete(chatId);
    await txDone(tx);
    return true;
  });
}

/** 只补写原保存上下文，不复活删除记录。基础结果与 AI 解释分别填充。 */
export async function backfillResult(contextId: number, result?: LearningResult, explanation?: ContextExplanation): Promise<boolean> {
  return withDb(async db => {
    const tx = db.transaction(CONTEXTS, 'readwrite');
    const store = tx.objectStore(CONTEXTS);
    const context = await px(store.get(contextId)) as ContextRecord | undefined;
    if (!context) { await txDone(tx); return false; }
    let filled = false;
    if (result && !context.result) { context.result = result; filled = true; }
    if (explanation && !context.explanation && context.sentence === explanation.sentence.replace(/\s+/g, ' ').trim()) {
      context.explanation = explanation; filled = true;
    }
    if (filled) store.put(context);
    await txDone(tx);
    return filled;
  });
}

// 句子收藏与词条独立，确定 ID 使重复保存自然覆盖同一项。
export async function saveSentence(sentence: SavedSentence): Promise<void> {
  return withDb(async db => {
    const tx = db.transaction('sentences', 'readwrite');
    tx.objectStore('sentences').put(sentence);
    await txDone(tx);
  });
}

export async function listSentences(): Promise<SavedSentence[]> {
  return withDb(async db => {
    const tx = db.transaction('sentences', 'readonly');
    const items = await px(tx.objectStore('sentences').getAll()) as SavedSentence[];
    return items.sort((a, b) => b.createdAt - a.createdAt);
  });
}

export async function deleteSentence(id: string): Promise<void> {
  return withDb(async db => {
    const tx = db.transaction('sentences', 'readwrite');
    tx.objectStore('sentences').delete(id);
    await txDone(tx);
  });
}

// ---- M11 学习库：句柄／身份／待写入队列（仅 background 读写） ---------------------
// 句柄经 structured clone 存入 IDB（具体权限恢复行为以 V 探针实测为准），
// 类型在 lib/vault/** 边界处收窄，这里按 unknown 保管。

interface VaultStatusMeta {
  lastCommitAt: number | null;
  lastError: string | null;
}

export async function getVaultIdentity(): Promise<VaultIdentity | null> {
  return withDb(async db => {
    const tx = db.transaction(VAULT, 'readonly');
    const r = (await px(tx.objectStore(VAULT).get('identity'))) as VaultIdentity | undefined;
    await txDone(tx);
    return r ?? null;
  });
}

export async function setVaultIdentity(identity: VaultIdentity): Promise<void> {
  return withDb(async db => {
    const tx = db.transaction(VAULT, 'readwrite');
    tx.objectStore(VAULT).put(identity, 'identity');
    await txDone(tx);
  });
}

export async function clearVault(): Promise<void> {
  return withDb(async db => {
    const tx = db.transaction(VAULT, 'readwrite');
    tx.objectStore(VAULT).clear(); // 断开：句柄与身份移除，不删除文件；待办按库身份保留在队列
    await txDone(tx);
  });
}

export async function getVaultHandle(): Promise<unknown> {
  return withDb(async db => {
    const tx = db.transaction(VAULT, 'readonly');
    const r = await px(tx.objectStore(VAULT).get('handle'));
    await txDone(tx);
    return r ?? null;
  });
}

export async function setVaultHandle(handle: unknown): Promise<void> {
  return withDb(async db => {
    const tx = db.transaction(VAULT, 'readwrite');
    tx.objectStore(VAULT).put(handle, 'handle');
    await txDone(tx);
  });
}

/** 本机事务提交成功后入队（幂等：同 id 覆盖，重试不重复导入）。 */
export async function enqueueVaultWrite(write: VaultPendingWrite): Promise<void> {
  return withDb(async db => {
    const tx = db.transaction(VAULT_QUEUE, 'readwrite');
    tx.objectStore(VAULT_QUEUE).put(write);
    await txDone(tx);
  });
}

export async function listVaultQueue(): Promise<VaultPendingWrite[]> {
  return withDb(async db => {
    const tx = db.transaction(VAULT_QUEUE, 'readonly');
    const items = (await px(tx.objectStore(VAULT_QUEUE).getAll())) as VaultPendingWrite[];
    await txDone(tx);
    return items.sort((a, b) => a.queuedAt - b.queuedAt);
  });
}

/** 写入成功后出队。 */
export async function removeVaultWrite(id: string): Promise<void> {
  return withDb(async db => {
    const tx = db.transaction(VAULT_QUEUE, 'readwrite');
    tx.objectStore(VAULT_QUEUE).delete(id);
    await txDone(tx);
  });
}

export async function markVaultWriteAttempt(id: string, error?: string): Promise<void> {
  return withDb(async db => {
    const tx = db.transaction([VAULT_QUEUE, VAULT], 'readwrite');
    const store = tx.objectStore(VAULT_QUEUE);
    const write = (await px(store.get(id))) as VaultPendingWrite | undefined;
    if (write) {
      write.attempts = (write.attempts ?? 0) + 1;
      write.lastError = error;
      store.put(write);
    }
    const metaStore = tx.objectStore(VAULT);
    const meta = (await px(metaStore.get('status'))) as VaultStatusMeta | undefined;
    metaStore.put(
      {
        lastCommitAt: error ? (meta?.lastCommitAt ?? null) : Date.now(),
        lastError: error ?? null,
      },
      'status',
    );
    await txDone(tx);
  });
}

/** 面板／设置页展示的库状态；connected = 已持有句柄（权限在写入时验证）。 */
export async function getVaultStatus(): Promise<VaultStatus> {
  return withDb(async db => {
    const tx = db.transaction([VAULT, VAULT_QUEUE], 'readonly');
    const handle = await px(tx.objectStore(VAULT).get('handle'));
    const identity = (await px(tx.objectStore(VAULT).get('identity'))) as
      | VaultIdentity
      | undefined;
    const queue = (await px(tx.objectStore(VAULT_QUEUE).getAll())) as VaultPendingWrite[];
    const meta = (await px(tx.objectStore(VAULT).get('status'))) as VaultStatusMeta | undefined;
    await txDone(tx);
    return {
      connected: handle != null,
      identity: identity ?? null,
      pendingCount: queue.length,
      lastCommitAt: meta?.lastCommitAt ?? null,
      lastError: meta?.lastError ?? null,
    };
  });
}

// ---- 学习库读回：外部记录落库与同步快照（三方合并的 base） ------------------------

/** 外部（Obsidian）记录整体落库：词条替换 + 上下文全量重建（单一事务）。 */
export async function importVaultEntry(
  entry: VocabEntryRecord,
  contexts: Omit<ContextRecord, 'id'>[],
): Promise<void> {
  return withDb(async db => {
    const tx = db.transaction([ENTRIES, CONTEXTS], 'readwrite');
    const entries = tx.objectStore(ENTRIES);
    const contextStore = tx.objectStore(CONTEXTS);
    entries.put(entry);
    const ids = (await px(contextStore.index('entryKey').getAllKeys(entry.key))) as IDBValidKey[];
    for (const id of ids) contextStore.delete(id);
    for (const c of contexts) contextStore.add({ ...c, entryKey: entry.key });
    await txDone(tx);
  });
}

export async function upsertVaultSentence(sentence: SavedSentence): Promise<void> {
  return withDb(async db => {
    const tx = db.transaction('sentences', 'readwrite');
    tx.objectStore('sentences').put(sentence);
    await txDone(tx);
  });
}

/** 上次同步快照（JSON 字符串）：三方合并的 base；缺失返回 null。 */
export async function getSyncSnapshot(recordId: string): Promise<string | null> {
  return withDb(async db => {
    const tx = db.transaction(VAULT, 'readonly');
    const r = (await px(tx.objectStore(VAULT).get(`sync:${recordId}`))) as string | undefined;
    await txDone(tx);
    return r ?? null;
  });
}

export async function setSyncSnapshot(recordId: string, json: string): Promise<void> {
  return withDb(async db => {
    const tx = db.transaction(VAULT, 'readwrite');
    tx.objectStore(VAULT).put(json, `sync:${recordId}`);
    await txDone(tx);
  });
}

/** 列出全部同步快照的 recordId（删除检测用）。 */
export async function listSyncSnapshotIds(): Promise<string[]> {
  return withDb(async db => {
    const tx = db.transaction(VAULT, 'readonly');
    const keys = (await px(tx.objectStore(VAULT).getAllKeys())) as IDBValidKey[];
    await txDone(tx);
    return keys.filter((k) => String(k).startsWith('sync:')).map((k) => String(k).slice(5));
  });
}

export async function deleteSyncSnapshot(recordId: string): Promise<void> {
  return withDb(async db => {
    const tx = db.transaction(VAULT, 'readwrite');
    tx.objectStore(VAULT).delete(`sync:${recordId}`);
    await txDone(tx);
  });
}

/** 断开时清理同步快照（待办队列保留，按库身份重连后重建）。 */
export async function clearSyncSnapshots(): Promise<void> {
  return withDb(async db => {
    const tx = db.transaction(VAULT, 'readwrite');
    const keys = (await px(tx.objectStore(VAULT).getAllKeys())) as IDBValidKey[];
    for (const k of keys) if (String(k).startsWith('sync:')) tx.objectStore(VAULT).delete(k);
    await txDone(tx);
  });
}

/** vault store 的通用键值（冲突记录等小对象）。 */
export async function putVaultRaw(key: string, value: unknown): Promise<void> {
  return withDb(async db => {
    const tx = db.transaction(VAULT, 'readwrite');
    tx.objectStore(VAULT).put(value, key);
    await txDone(tx);
  });
}

export async function getVaultRaw<T>(key: string): Promise<T | null> {
  return withDb(async db => {
    const tx = db.transaction(VAULT, 'readonly');
    const r = (await px(tx.objectStore(VAULT).get(key))) as T | undefined;
    await txDone(tx);
    return r ?? null;
  });
}


/** 学习库读回的会话落库：本地不存在则插入；文件较新且本地无进行中生成时替换。
 *  streaming 本地记录不被动（另一浏览器不接管，spec 4.5）。 */
export async function upsertChatRecordFromVault(record: ChatRecord): Promise<'inserted' | 'replaced' | 'kept-local'> {
  return withDb(async db => {
    const tx = db.transaction([CHATS], 'readwrite');
    const store = tx.objectStore(CHATS);
    const local = (await px(store.get(record.id))) as ChatRecord | undefined;
    if (!local) {
      store.put(record);
      await txDone(tx);
      return 'inserted';
    }
    const liveLocal = local.messages.some(m => m.role === 'assistant' && m.state === 'streaming');
    if (!liveLocal && record.updatedAt > local.updatedAt) {
      store.put({ ...record, draft: local.draft, pendingQuote: local.pendingQuote });
      await txDone(tx);
      return 'replaced';
    }
    await txDone(tx);
    return 'kept-local';
  });
}

// ---- M11 语言迁移：旧词条按证据赋语言（spec 第 5 节） ------------------------------
// 幂等：迁移后不再存在“裸键且无 language”的词条；键冲突时合并（不增副本）。
// 旧键 → 新键映射存 vault store 'legacyMap'（可追溯）。

export interface LanguageMigrationReport {
  entriesScanned: number;
  assigned: number;   // 单一证据语言
  split: number;      // 跨语言语境拆分
  undetermined: number; // 无证据 → 待确认
  merged: number;     // 迁入已存在的同语言词条
  sentencesBackfilled: number;
}

export async function migrateLegacyLanguages(): Promise<LanguageMigrationReport> {
  const report: LanguageMigrationReport = {
    entriesScanned: 0, assigned: 0, split: 0, undetermined: 0, merged: 0, sentencesBackfilled: 0,
  };
  return withDb(async db => {
    const tx = db.transaction([ENTRIES, CONTEXTS, VAULT, 'sentences'], 'readwrite');
    const entries = tx.objectStore(ENTRIES);
    const contexts = tx.objectStore(CONTEXTS);
    const vault = tx.objectStore(VAULT);

    const allEntries = (await px(entries.getAll())) as VocabEntryRecord[];
    const allContexts = (await px(contexts.getAll())) as ContextRecord[];
    const byKey = new Map(allEntries.map(e => [e.key, e]));
    const ctxsOf = (key: string) => allContexts.filter(c => c.entryKey === key);
    const legacyMap: Record<string, string[]> = (await px(vault.get('legacyMap'))) as Record<string, string[]> ?? {};

    for (const entry of allEntries) {
      if (entry.language) continue;
      if (parseEntryKey(entry.key)) continue; // 已是语言作用域键
      report.entriesScanned++;
      const ctxs = ctxsOf(entry.key);
      const plan = planLegacyLanguage(
        ctxs.map(c => ({
          sourceType: c.sourceType ?? 'web',
          ...(c.video?.trackLang ? { trackLang: c.video.trackLang } : {}),
          ...(c.result?.kind === 'dictionary' ? { hasDictionaryResult: true } : {}),
        })),
      );

      // 目标分组：assign/none 单组；split 多组
      const groups: { language: string; indexes: number[] }[] =
        plan.kind === 'split'
          ? plan.groups.map(g => ({ language: g.language, indexes: g.contextIndexes }))
          : [{ language: plan.kind === 'assign' ? plan.language : LANG_UNDETERMINED, indexes: ctxs.map((_, i) => i) }];
      if (plan.kind === 'assign') report.assigned++;
      else if (plan.kind === 'split') report.split++;
      else report.undetermined++;

      const newKeys: string[] = [];
      for (const g of groups) {
        const newKey = entryKeyOf(g.language, entry.expression);
        newKeys.push(newKey);
        const existing = byKey.get(newKey);
        if (existing && existing !== entry) {
          // 已有同语言词条：语境迁入，状态取较新的一方（不清空用户操作）
          for (const i of g.indexes) {
            const c = ctxs[i]!;
            c.entryKey = newKey;
            contexts.put(c);
          }
          const newer = existing.updatedAt >= entry.updatedAt ? existing : entry;
          existing.status = newer.status;
          existing.updatedAt = Date.now();
          existing.forms = [...new Set([...existing.forms ?? [], ...(newer.forms ?? [])])];
          if (entry.note && !existing.note) existing.note = entry.note;
          entries.put(existing);
          entries.delete(entry.key);
          report.merged++;
          continue;
        }
        if (existing === entry) continue; // 目标键恰为自身（不应发生：裸键）
        const newEntry: VocabEntryRecord = {
          ...entry,
          key: newKey,
          language: g.language,
          legacyKey: entry.key,
          updatedAt: Date.now(),
        };
        byKey.set(newKey, newEntry);
        entries.put(newEntry);
        for (const i of g.indexes) {
          const c = ctxs[i]!;
          c.entryKey = newKey;
          contexts.put(c);
        }
        if (groups.length > 1) {
          // 拆分组除最大组外复制状态；词条本体（forms/note）保留在首组
          delete (newEntry as Partial<VocabEntryRecord>).forms;
        }
      }
      if (newKeys.length > 1 || newKeys[0] !== entry.key) entries.delete(entry.key);
      legacyMap[entry.key] = newKeys;
    }

    // 旧句子收藏：语言 = 轨道语言
    const sentenceStore = tx.objectStore('sentences');
    const sentences = (await px(sentenceStore.getAll())) as SavedSentence[];
    for (const s of sentences) {
      if (s.language) continue;
      const primary = (s.video.trackLang ?? '').trim().toLowerCase().split('-')[0] ?? '';
      if (!/^[a-z]{2,3}$/.test(primary)) continue;
      s.language = primary;
      sentenceStore.put(s);
      report.sentencesBackfilled++;
    }

    vault.put(legacyMap, 'legacyMap');
    await txDone(tx);
    return report;
  });
}
