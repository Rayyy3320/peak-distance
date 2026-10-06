// M11 学习库同步编排：首次导入、待写入提交、读回合并、断开。
// 被 entrypoints/background.ts 调用（唯一入口）；文件操作在 ./fs.ts，
// 三方合并在 ./format.ts 的 mergeVocabRecord，队列与快照在 lib/db.ts。
//
// 合并语义（spec 4.4）：base = 上次确认的共享文件；无 base 时不猜共同祖先。
// 冲突不丢数据：保留本地，
// 冲突详情存 vault store（conflict:<id>），由 UI 呈现处理选项。

import {
  ensurePermission,
  ensureVault,
  migrateVaultCollections,
  deleteCollectionRecord,
  parseChatDocument,
  readVocabRecordById,
  scanVault,
  writeChatToVault,
  writeMaterialToVault,
  writePreferenceToVault,
  writeSentenceToVault,
  writeVocabToVault,
  type VaultFileScan,
} from './fs';
import { serializeChatRecord } from './chatFormat';
import type { VaultChatRecord } from '@/shared/vault';
import { vaultRecordJson, vaultErrorCode, type VaultError } from '@/shared/vault';
import type { ChatRecord, MaterialSnapshotRecord } from '@/shared/chat';
import { mergeVocabRecord } from './format';
import {
  clearSyncSnapshots,
  clearVault,
  deleteEntry,
  deleteSentence,
  deleteSyncSnapshot,
  enqueueVaultWrite,
  enqueueRecoveredVaultWrite,
  getSyncSnapshot,
  getVaultHandle,
  getVaultIdentity,
  getVaultStatus,
  importVaultEntry,
  listEntries,
  getChat,
  listChats,
  listSentences,
  listSyncSnapshotIds,
  upsertChatRecordFromVault,
  listVaultQueue,
  markVaultWriteAttempt,
  putVaultRaw,
  removeVaultWrite,
  setSyncSnapshot,
  setVaultIdentity,
  upsertVaultSentence,
} from '@/lib/db';
import type {
  VaultConflictRecord,
  VaultSentenceRecord,
  VaultStatus,
  VaultVocabRecord,
} from '@/shared/vault';
import { entryViewToVaultRecord, sentenceToVaultRecord, vaultRecordToEntry } from './records';
import { DEFAULT_SETTINGS, validSetting } from '@/shared/settings';

type DirHandle = Parameters<typeof ensureVault>[0];

// One worker must not read/replace the same collection in overlapping save and sync operations.
let vaultOperation: Promise<unknown> = Promise.resolve();
function runVaultOperation<T>(task: () => Promise<T>): Promise<T> {
  const operation = vaultOperation.then(task);
  vaultOperation = operation.catch(() => {});
  return operation;
}

function storageLocal(): {
  get: (keys: string[]) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
} {
  return browser.storage.local as unknown as ReturnType<typeof storageLocal>;
}

// ---- 待写入提交 -------------------------------------------------------------------

export interface FlushResult {
  committed: number;
  failed: number;
  skipped: number;
  error?: VaultError;
}

export const flushVaultWrites = (): Promise<FlushResult> => runVaultOperation(flushPendingWrites);

async function flushPendingWrites(): Promise<FlushResult> {
  const handle = (await getVaultHandle()) as DirHandle | null;
  if (!handle) return { committed: 0, failed: 0, skipped: 0, error: 'not-connected' };
  const perm = await ensurePermission(handle);
  const queue = await listVaultQueue();
  if (perm !== 'granted') {
    for (const w of queue) await markVaultWriteAttempt(w, 'no-permission');
    return { committed: 0, failed: queue.length, skipped: 0, error: 'no-permission' };
  }
  await migrateVaultCollections(handle);
  let committed = 0;
  let failed = 0;
  let skipped = 0;
  let error: FlushResult['error'];
  for (const w of queue) {
    try {
      if (w.payload === null && (w.kind === 'vocab' || w.kind === 'sentence')) {
        await deleteCollectionRecord(handle, w.kind, w.recordId);
        await deleteSyncSnapshot(w.kind === 'sentence' ? `sentence:${w.recordId}` : w.recordId);
      } else if (w.kind === 'vocab') {
        const record = w.payload as VaultVocabRecord;
        // 提交前检查文件变化（spec 4.4）：库中版本相对上次同步快照有外部改动时
        // 先做三方合并；同字段双方修改判冲突 → 不覆盖文件，记录详情并保留待办。
        const prev = await readVocabRecordById(handle, record.id);
        let toWrite: VaultVocabRecord = record;
        if (prev) {
          const baseRaw = await getSyncSnapshot(record.id);
          const base = baseRaw ? (JSON.parse(baseRaw) as VaultVocabRecord) : null;
          const outcome = mergeVocabRecord(base, record, {
            ...prev.record,
            note: prev.note,
          });
          if (outcome.kind === 'conflict') {
            const conflict: VaultConflictRecord = {
              kind: 'vocab',
              recordId: record.id,
              fields: outcome.fields.map((f) => ({ field: f.field, local: f.local, remote: f.file })),
              local: record,
              remote: prev.record,
            };
            await putVaultRaw(`conflict:${record.id}`, conflict);
            await markVaultWriteAttempt(w, 'conflict');
            failed++;
            error = 'conflict';
            continue; // 待办保留；解决后下次提交
          }
          toWrite = outcome.value;
        }
        await writeVocabToVault(handle, toWrite);
        const { entry, contexts } = vaultRecordToEntry(toWrite, toWrite.note ?? '');
        await importVaultEntry(entry, contexts, record, w);
        // 我们刚写的内容即“上次共同内容”（下次读回的三方合并 base）
        await setSyncSnapshot(record.id, vaultRecordJson(toWrite));
      } else if (w.kind === 'sentence') {
        const record = w.payload as VaultSentenceRecord;
        await writeSentenceToVault(handle, record);
        await setSyncSnapshot(`sentence:${record.id}`, vaultRecordJson(record));
      } else if (w.kind === 'preference') {
        const p = w.payload as { defaultComprehensionLang: string; comprehensionOverrides: Record<string, string> };
        await writePreferenceToVault(handle, p);
      } else if (w.kind === 'chat') {
        const record = w.payload as VaultChatRecord;
        // 材料快照不可变：先落材料（存在即跳过），再写会话
        for (const snap of record.snapshots) {
          await writeMaterialToVault(handle, record.id, snap as MaterialSnapshotRecord);
        }
        await writeChatToVault(handle, record.id, record.title, serializeChatRecord(record));
      } else {
        skipped++;
        continue;
      }
      await removeVaultWrite(w);
      await markVaultWriteAttempt(w);
      committed++;
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      await markVaultWriteAttempt(w, message);
      error = vaultErrorCode(e);
      failed++;
    }
  }
  return { committed, failed, skipped, ...(error ? { error } : {}) };
}

/** 本机保存成功后的入队（幂等键 = kind:recordId，后写覆盖先写）。 */
export async function enqueueVocabWrite(record: VaultVocabRecord): Promise<void> {
  await enqueueVaultWrite({
    id: `vocab:${record.id}`,
    kind: 'vocab',
    recordId: record.id,
    payload: record,
    queuedAt: Date.now(),
  });
}

export async function enqueueSentenceWrite(record: VaultSentenceRecord): Promise<void> {
  await enqueueVaultWrite({
    id: `sentence:${record.id}`,
    kind: 'sentence',
    recordId: record.id,
    payload: record,
    queuedAt: Date.now(),
  });
}

/** 会话写入排队（终态后调用；streaming 中间态不写文件）。 */
export async function enqueueChatWrite(record: ChatRecord): Promise<void> {
  const { draft: _draft, pendingQuote: _pq, ...vaultRecord } = record;
  await enqueueVaultWrite({
    id: `chat:${record.id}`,
    kind: 'chat',
    recordId: record.id,
    payload: vaultRecord as VaultChatRecord,
    queuedAt: Date.now(),
  });
}

// ---- 读回合并 ---------------------------------------------------------------------

export interface SyncResult {
  updated: number;
  deleted: number;
  conflicts: number;
  broken: number;
}

type VaultSyncResult = SyncResult & { error?: FlushResult['error'] };
export const syncFromVault = (): Promise<VaultSyncResult> => runVaultOperation(readVaultChanges);

async function readVaultChanges(): Promise<VaultSyncResult> {
  const handle = (await getVaultHandle()) as DirHandle | null;
  if (!handle) return { updated: 0, deleted: 0, conflicts: 0, broken: 0, error: 'not-connected' };
  const perm = await ensurePermission(handle);
  if (perm !== 'granted') return { updated: 0, deleted: 0, conflicts: 0, broken: 0, error: 'no-permission' };

  await migrateVaultCollections(handle);
  const scan: VaultFileScan = await scanVault(handle);
  const local = await listEntries();
  const localByKey = new Map(local.map((e) => [e.key, e]));
  const pending = await listVaultQueue();
  const pendingKeys = new Set(pending.map(write => `${write.kind}:${write.recordId}`));
  const seen = new Set<string>();
  let updated = 0;
  let conflicts = pending.filter(write => write.lastError === 'conflict' || write.lastError?.startsWith('conflict:')).length;

  for (const { record, note } of scan.vocab) {
    seen.add(record.id);
    if (pendingKeys.has(`vocab:${record.id}`)) continue;
    const localEntry = localByKey.get(record.id);
    const baseRaw = await getSyncSnapshot(record.id);
    const base = baseRaw ? (JSON.parse(baseRaw) as VaultVocabRecord & { note?: string }) : null;
    if (!localEntry) {
      // 其它浏览器 / Obsidian 新增：导入本地
      const { entry, contexts } = vaultRecordToEntry(record, note);
      if (!await importVaultEntry(entry, contexts, null)) continue;
      await setSyncSnapshot(record.id, vaultRecordJson({ ...record, note }));
      updated++;
      continue;
    }
    const localRecord = entryViewToVaultRecord(localEntry);
    const fileRecord: VaultVocabRecord & { note?: string } = { ...record, note };
    // 未确认共同文件时保留标量差异为冲突，不能把另一浏览器的选择当成覆盖依据。
    const outcome = mergeVocabRecord(base, localRecord, fileRecord);
    if (outcome.kind === 'conflict') {
      const conflict: VaultConflictRecord = {
        kind: 'vocab',
        recordId: record.id,
        fields: outcome.fields.map((f) => ({
          field: f.field,
          local: f.local,
          remote: f.file,
        })),
        local: localRecord,
        remote: fileRecord,
      };
      await putVaultRaw(`conflict:${record.id}`, conflict);
      conflicts++;
      continue; // 保留本地，待用户处理；不丢任何一方
    }
    const mergedNote = (outcome.value as { note?: string }).note ?? '';
    const { entry, contexts } = vaultRecordToEntry(outcome.value, mergedNote);
    if (vaultRecordJson(localRecord) !== vaultRecordJson(outcome.value)) {
      if (!await importVaultEntry(entry, contexts, localRecord)) continue;
      updated++;
    }
    await setSyncSnapshot(record.id, vaultRecordJson(fileRecord));
  }

  // 删除检测：有同步快照但库中不再存在该 ID（移动保留同 ID，不会误判）。
  // 本轮有文件读取失败（权限瞬断 / IO）时扫描不完整，跳过删除检测（下次 vaultSync 重试），
  // 避免读取失败的词条被当成“文件已删”而误删本地词条与全部上下文。
  let deleted = 0;
  const pendingIds = new Set(pending.map(write => write.recordId));
  if (scan.readFailures === 0 && scan.broken.length === 0) {
    for (const id of await listSyncSnapshotIds()) {
      if (!id.startsWith('sentence:') && !seen.has(id) && !pendingIds.has(id)) {
        const current = localByKey.get(id);
        if (!await deleteEntry(id, false, current ? entryViewToVaultRecord(current) : null)) continue;
        await deleteSyncSnapshot(id);
        await putVaultRaw(`conflict:${id}`, null).catch(() => {});
        deleted++;
      }
    }
  }

  // 句子收藏：按稳定 ID 覆盖本地（外部只补笔记/改状态，不重建历史）
  const localSentences = new Map((await listSentences()).map(sentence => [sentence.id, sentence]));
  for (const { record } of scan.sentences) {
    if (pendingKeys.has(`sentence:${record.id}`)) continue;
    const current = localSentences.get(record.id);
    if (current && vaultRecordJson(sentenceToVaultRecord(current)) === vaultRecordJson(record)) continue;
    const applied = await upsertVaultSentence({
      id: record.id,
      video: record.video,
      text: record.text,
      ...(record.translation ? { zh: record.translation } : {}),
      ...(record.translationSource ? { translationSource: record.translationSource } : {}),
      endMs: record.endMs,
      title: record.title,
      createdAt: record.createdAt,
      ...(record.language ? { language: record.language } : {}),
    }, current ?? null);
    if (!applied) continue;
    await setSyncSnapshot(`sentence:${record.id}`, vaultRecordJson(record));
    updated++;
  }
  if (scan.readFailures === 0 && scan.broken.length === 0) {
    const sentenceIds = new Set(scan.sentences.map(item => item.record.id));
    for (const key of await listSyncSnapshotIds()) {
      if (!key.startsWith('sentence:')) continue;
      const id = key.slice('sentence:'.length);
      if (!sentenceIds.has(id) && !pendingIds.has(id)) {
        if (!await deleteSentence(id, false, localSentences.get(id) ?? null)) continue;
        await deleteSyncSnapshot(key);
        deleted++;
      }
    }
  }

  // 会话读回：新会话插入；文件较新替换（本地 streaming 生成不被动）
  for (const { text } of scan.chats) {
    const parsed = parseChatDocument(text);
    if ('error' in parsed) continue;
    const record: ChatRecord = {
      id: parsed.id,
      title: parsed.title,
      source: parsed.sourceType
        ? { sourceType: parsed.sourceType, sourceKey: '', title: parsed.title, url: parsed.sourceUrl, ...(parsed.sourceVideo ? { video: parsed.sourceVideo } : {}) }
        : null,
      sourceKey: '',
      snapshots: [],
      activeSnapshotVersion: 0,
      messages: parsed.messages,
      updatedAt: parsed.updatedAt || Date.now(),
      draft: '',
      pendingQuote: null,
    };
    await upsertChatRecordFromVault(record);
  }

  // 偏好双向生效：库里有而本地缺的偏好项以库为准（Key / AI 配置永不读取）
  if (scan.preference) {
    const stored = await storageLocal().get(['defaultComprehensionLang', 'comprehensionOverrides']);
    const patch: Record<string, unknown> = {};
    if (!validSetting('defaultComprehensionLang', stored.defaultComprehensionLang) &&
        validSetting('defaultComprehensionLang', scan.preference.defaultComprehensionLang)) {
      patch.defaultComprehensionLang = scan.preference.defaultComprehensionLang;
    }
    if (!validSetting('comprehensionOverrides', stored.comprehensionOverrides) &&
        validSetting('comprehensionOverrides', scan.preference.comprehensionOverrides)) {
      patch.comprehensionOverrides = scan.preference.comprehensionOverrides;
    }
    if (Object.keys(patch).length) await storageLocal().set(patch);
  }

  return { updated, deleted, conflicts, broken: scan.broken.length,
    ...(scan.readFailures ? { error: 'io' as const } : scan.broken.length ? { error: 'format' as const } : {}) };
}

/** Manual sync publishes local pending changes and then refreshes the running copy from the shared files. */
export const synchronizeVault = () => runVaultOperation(async () => {
  // The local database is the durable save boundary, including saves made before connecting or before a worker restart.
  const deletions = new Set((await listVaultQueue()).filter(write => write.payload === null).map(write => `${write.kind}:${write.recordId}`));
  for (const entry of await listEntries()) {
    if (deletions.has(`vocab:${entry.key}`)) continue;
    const record = entryViewToVaultRecord(entry);
    const base = await getSyncSnapshot(record.id);
    if (!base || vaultRecordJson(record) !== vaultRecordJson(JSON.parse(base))) await enqueueRecoveredVaultWrite({ id: `vocab:${record.id}`, kind: 'vocab', recordId: record.id, payload: record, queuedAt: Date.now() });
  }
  for (const sentence of await listSentences()) {
    if (deletions.has(`sentence:${sentence.id}`)) continue;
    const record = sentenceToVaultRecord(sentence);
    const base = await getSyncSnapshot(`sentence:${record.id}`);
    if (!base || vaultRecordJson(record) !== vaultRecordJson(JSON.parse(base))) await enqueueRecoveredVaultWrite({ id: `sentence:${record.id}`, kind: 'sentence', recordId: record.id, payload: record, queuedAt: Date.now() });
  }
  const flush = await flushPendingWrites();
  const sync = await readVaultChanges();
  return { ...flush, ...sync, error: flush.error ?? sync.error ?? (sync.conflicts ? 'conflict' as const : undefined) };
});

// ---- 连接 / 断开 -------------------------------------------------------------------

export async function adoptVault(): Promise<
  { ok: true; imported: boolean; status: VaultStatus; syncError?: FlushResult['error'] } | { ok: false; error: string }
> {
  const handle = (await getVaultHandle()) as DirHandle | null;
  if (!handle) return { ok: false, error: 'no-handle' };
  const identity = await ensureVault(handle);
  await setVaultIdentity(identity);
  const marker = `vaultImported:${identity.vaultId}`;
  const got = await storageLocal().get([marker]);
  let imported = false;
  if (!got[marker]) {
    // 首次连接该库：本机持久记录增量并入（幂等标记防重复导入）
    const entries = await listEntries();
    for (const e of entries) await enqueueVocabWrite(entryViewToVaultRecord(e));
    for (const s of await listSentences()) await enqueueSentenceWrite(sentenceToVaultRecord(s));
    for (const c of await listChats()) {
      const record = await getChat(c.chatId);
      if (record) await enqueueChatWrite(record);
    }
    await storageLocal().set({ [marker]: true });
    imported = true;
  }
  const result = await synchronizeVault();
  if (result.error && result.error !== 'conflict') return { ok: false, error: result.error };
  const status = await getVaultStatus();
  return { ok: true, imported, status, syncError: result.error };
}

export async function disconnectVault(): Promise<void> {
  await clearVault();
  await clearSyncSnapshots();
}

/** 设置变化时把偏好排入待写（background setSetting 后调用）。 */
export async function enqueuePreferenceWrite(): Promise<void> {
  if (!(await getVaultIdentity())) return;
  const stored = await storageLocal().get(['defaultComprehensionLang', 'comprehensionOverrides']);
  await enqueueVaultWrite({
    id: 'preference:main',
    kind: 'preference',
    recordId: 'preference',
    payload: {
      defaultComprehensionLang:
        validSetting('defaultComprehensionLang', stored.defaultComprehensionLang)
          ? (stored.defaultComprehensionLang as string)
          : DEFAULT_SETTINGS.defaultComprehensionLang,
      comprehensionOverrides: validSetting('comprehensionOverrides', stored.comprehensionOverrides)
        ? (stored.comprehensionOverrides as Record<string, string>)
        : {},
    },
    queuedAt: Date.now(),
  });
}
