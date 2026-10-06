// M11 学习库目录访问层：唯一接触磁盘文件的地方。
// 由 background（内容读写）与扩展页面（授权/选目录）调用；句子／词条／偏好的
// Markdown 往返在 ./format.ts，合并决策在 mergeVocabRecord。
//
// 探针实证（tools/m11-vault-probe.mjs）：
// - 句柄可存 IndexedDB，SW 重启 / 浏览器重启后仍可读写；
// - 并发替换写会使先前 FileHandle 失效 → 本层每次操作都重新获取句柄；
// - 生词本.md / 句子.md are collections; chats and immutable materials retain separate files.

import {
  applyVocabToDocument,
  applySentenceToDocument,
  contextIdentity,
  parseVocabDocument,
  serializePreferenceRecord,
  parsePreferenceDocument,
  serializeSentenceRecord,
  parseSentenceDocument,
  serializeVocabRecord,
} from './format';
import {
  materialIdOf,
  parseChatDocument,
  parseMaterialDocument,
  serializeChatRecord,
  serializeMaterialSnapshot,
} from './chatFormat';
import type { MaterialSnapshotRecord } from '@/shared/chat';
import { DB_NAME, DB_VERSION, getVaultHandle } from '@/lib/db';
import {
  VAULT_FORMAT_VERSION,
  type VaultIdentity,
  type VaultPendingWrite,
  type VaultSentenceRecord,
  type VaultVocabRecord,
} from '@/shared/vault';
import { COLLECTION_FILES, emptyCollection, parseCollection, serializeCollection, type CollectionKind, type CollectionDocument } from './collectionFormat';

/** 目录内学习库身份文件（JSON；vaultId 是换库判定依据）。 */
const META_DIR = '.peak-distance';
const IDENTITY_FILE = 'identity.json';
const INDEX_FILE = 'index.json'; // recordId → 相对路径（两浏览器共享的路径索引）
const README_FILE = '使用说明.md';
const RECORDS_FILE = 'records.json';

type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
};

// ---- 基础文件操作（每次重新取句柄；不缓存 FileHandle） ---------------------------

/** 读取结果：text 成功；missing 文件或父目录不存在（合法缺失）；failed 其它错误（权限瞬断、IO、句柄失效）。 */
type VaultReadText = { text: string } | { missing: true } | { failed: true };

async function readTextFile(dir: DirHandle, path: string[]): Promise<VaultReadText> {
  try {
    let d = dir;
    for (const seg of path.slice(0, -1)) d = await d.getDirectoryHandle(seg);
    const fh = await d.getFileHandle(path.at(-1)!);
    return { text: await (await fh.getFile()).text() };
  } catch (e) {
    // NotFoundError = 文件/目录确实不在；其余异常是读取失败，不能当“已删除”
    if ((e as DOMException)?.name === 'NotFoundError') return { missing: true };
    return { failed: true };
  }
}

/** 路径索引可重建；记录和库身份使用区分缺失／错误的严格读取。 */
async function readTextIfAny(dir: DirHandle, path: string[]): Promise<string | null> {
  const r = await readTextFile(dir, path);
  return 'text' in r ? r.text : null;
}

async function writeTextFile(dir: DirHandle, path: string[], text: string, expected?: string | null): Promise<void> {
  let d = dir;
  for (const seg of path.slice(0, -1)) d = await d.getDirectoryHandle(seg, { create: true });
  const fh = await d.getFileHandle(path.at(-1)!, { create: true });
  const w = await fh.createWritable({ mode: 'exclusive' } as FileSystemCreateWritableOptions & { mode: 'exclusive' });
  try {
    if (expected !== undefined && await (await fh.getFile()).text() !== (expected ?? '')) throw new Error(`conflict: file changed ${path.join('/')}`);
    await w.write(text);
    if (expected !== undefined && await (await fh.getFile()).text() !== (expected ?? '')) throw new Error(`conflict: file changed ${path.join('/')}`);
    await w.close();
  } catch (error) {
    await w.abort();
    throw error;
  }
  if (await (await fh.getFile()).text() !== text) throw new Error(`io: write verification ${path.join('/')}`);
}

async function listFilesRecursive(
  dir: DirHandle,
  prefix: string[] = [],
): Promise<string[]> {
  const out: string[] = [];
  for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
    if (name.startsWith('.')) continue; // .peak-distance / Obsidian 配置不当作记录
    if (handle.kind === 'file') out.push([...prefix, name].join('/'));
    else if (handle.kind === 'directory') {
      // Legacy collections and chat/material directories; auxiliary backups stay outside the scan.
      if (prefix.length === 0 && !['词汇', '句子', '对话', '材料'].includes(name)) continue;
      out.push(...(await listFilesRecursive(handle as DirHandle, [...prefix, name])));
    }
  }
  return out;
}

// ---- 身份与索引 -------------------------------------------------------------------

export async function ensureVault(dir: DirHandle): Promise<VaultIdentity> {
  const read = await readTextFile(dir, [META_DIR, IDENTITY_FILE]);
  if ('failed' in read) throw new Error('io: identity.json');
  const previous = 'text' in read ? JSON.parse(read.text) as VaultIdentity : null;
  if (previous && (!previous.vaultId || previous.formatVersion > VAULT_FORMAT_VERSION)) throw new Error('format: identity.json');
  if (previous?.formatVersion === VAULT_FORMAT_VERSION) return previous;
  const identity: VaultIdentity = previous
    ? { ...previous, formatVersion: VAULT_FORMAT_VERSION }
    : { vaultId: crypto.randomUUID(), formatVersion: VAULT_FORMAT_VERSION, createdAt: Date.now() };
  await writeTextFile(dir, [META_DIR, IDENTITY_FILE], JSON.stringify(identity, null, 2));
  await writeTextFile(
    dir,
    [META_DIR, README_FILE],
    [
      '# 学习库',
      '',
      '- 生词本.md 与句子.md 按记录分节；对话/ 下每个会话一份 Markdown。记录的 id、language、expression 与原句由扩展管理。',
      '- 状态取值：saved = 已收藏，learning = 在学，known = 已掌握。',
      '- 修改“我的笔记”或状态会被扩展读回；改语言/表达等身份请通过扩展入口。',
      '- `.peak-distance` 保存恢复数据、身份、路径索引及旧散文件备份；整个文件夹一起保留，请勿手改辅助数据。',
    ].join('\n'),
  );
  return identity;
}

interface VaultIndex {
  [recordId: string]: string; // Chat/material relative paths; collections do not need per-record paths.
}

async function readIndex(dir: DirHandle): Promise<VaultIndex> {
  const raw = await readTextIfAny(dir, [META_DIR, INDEX_FILE]);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as VaultIndex) : {};
  } catch {
    return {};
  }
}

async function writeIndex(dir: DirHandle, index: VaultIndex): Promise<void> {
  await writeTextFile(dir, [META_DIR, INDEX_FILE], JSON.stringify(index, null, 2));
}

// ---- 文件名（可读标题 + 短 ID；去重不依赖文件名） -----------------------------------

const WIN_FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g;

export function vaultFileName(title: string, recordId: string): string {
  const clean = title.replace(WIN_FORBIDDEN, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  const shortId = recordId.replace(WIN_FORBIDDEN, '-').slice(-12).replace(/^-+/, '');
  const base = clean || '记录';
  return `${base}-${shortId || Date.now().toString(36)}.md`;
}

// ---- Collection records and recovery metadata ----------------------------------

type RecordData = { vocab: Record<string, VaultVocabRecord>; sentence: Record<string, VaultSentenceRecord> };

async function readRecordData(dir: DirHandle): Promise<{ records: RecordData; source: string | null }> {
  const read = await readTextFile(dir, [META_DIR, RECORDS_FILE]);
  if ('missing' in read) return { records: { vocab: {}, sentence: {} }, source: null };
  if ('failed' in read) throw new Error('io: records.json');
  const parsed = JSON.parse(read.text) as RecordData;
  if (!parsed.vocab || !parsed.sentence) throw new Error('format: records.json');
  return { records: parsed, source: read.text };
}

async function readCollection(dir: DirHandle, kind: CollectionKind): Promise<CollectionDocument & { source: string | null }> {
  const read = await readTextFile(dir, [COLLECTION_FILES[kind]]);
  if ('failed' in read) throw new Error(`io: ${COLLECTION_FILES[kind]}`);
  const collection = 'text' in read ? parseCollection(read.text, kind) : emptyCollection(kind);
  const ids = collection.documents.map(text => documentId(text, kind));
  if (new Set(ids).size !== ids.length) throw new Error(`format: duplicate ID in ${COLLECTION_FILES[kind]}`);
  return { ...collection, source: 'text' in read ? read.text : null };
}

function vocabRecord(text: string, data: RecordData): VaultVocabRecord {
  const parsed = parseVocabDocument(text);
  if ('error' in parsed || !parsed.id || !parsed.expression || !parsed.language || !parsed.status) throw new Error('format: vocab');
  const stored = data.vocab[parsed.id];
  const contexts = new Map(stored?.contexts.map(context => [contextIdentity(context), context]) ?? []);
  return {
    id: parsed.id, expression: parsed.expression, language: parsed.language, status: parsed.status,
    note: parsed.note, forms: stored?.forms ?? [], createdAt: stored?.createdAt ?? 0, updatedAt: stored?.updatedAt ?? 0,
    contexts: parsed.managed.contexts.map(context => {
      const original = contexts.get(contextIdentity(context));
      return original ? { ...context, result: original.result ?? context.result, explanation: original.explanation ?? context.explanation } : context;
    }),
  };
}

function sentenceRecord(text: string, data: RecordData): VaultSentenceRecord {
  const parsed = parseSentenceDocument(text);
  if ('error' in parsed || !parsed.id || !parsed.text || !parsed.language) throw new Error('format: sentence');
  let stored = data.sentence[parsed.id];
  // Old sentence files omitted the video fields. Their stable ID still contains the source and seek position.
  if (!stored) {
    const [videoId, trackId, startMs] = JSON.parse(parsed.id) as [string, string, number];
    if (typeof videoId !== 'string' || typeof trackId !== 'string' || !Number.isFinite(startMs)) throw new Error('format: sentence source');
    const kind = /[?&]kind=asr(?:&|$)/.test(trackId) ? 'asr' : 'manual';
    stored = { id: parsed.id, language: parsed.language, text: parsed.text,
      video: { videoId, trackId, trackKind: kind, trackLang: parsed.language, startMs }, endMs: startMs, title: '', createdAt: 0 };
  }
  if (!stored.video || !Number.isFinite(stored.endMs)) throw new Error('format: sentence source');
  return { ...stored, id: parsed.id, language: parsed.language, text: parsed.text,
    translation: parsed.translation ?? undefined, translationSource: parsed.translationSource ?? undefined };
}

function documentId(text: string, kind: CollectionKind): string {
  const parsed = kind === 'vocab' ? parseVocabDocument(text) : parseSentenceDocument(text);
  if ('error' in parsed || !parsed.id) throw new Error(`format: ${kind}`);
  return parsed.id;
}

async function writeCollectionRecord(dir: DirHandle, kind: CollectionKind, record: VaultVocabRecord | VaultSentenceRecord): Promise<{ path: string }> {
  const collection = await readCollection(dir, kind);
  const { records: data, source } = await readRecordData(dir);
  const at = collection.documents.findIndex(text => documentId(text, kind) === record.id);
  let next: string | { error: 'format' };
  if (kind === 'vocab') {
    const vocab = record as VaultVocabRecord;
    next = at < 0 ? serializeVocabRecord(vocab) : applyVocabToDocument(vocab, collection.documents[at]!);
    data.vocab[record.id] = vocab;
  } else {
    const sentence = record as VaultSentenceRecord;
    next = at < 0 ? serializeSentenceRecord(sentence) : applySentenceToDocument(sentence, collection.documents[at]!);
    data.sentence[record.id] = record as VaultSentenceRecord;
  }
  if (typeof next !== 'string') throw new Error(`format: ${record.id}`);
  if (at < 0) collection.documents.push(next); else collection.documents[at] = next;
  // Publish recovery metadata before the visible record. Missing metadata never produces an invalid local sentence.
  await writeTextFile(dir, [META_DIR, RECORDS_FILE], JSON.stringify(data), source);
  const path = COLLECTION_FILES[kind];
  await writeTextFile(dir, [path], serializeCollection(collection, kind), collection.source);
  return { path };
}

export const writeVocabToVault = (dir: DirHandle, record: VaultVocabRecord) => writeCollectionRecord(dir, 'vocab', record);
export const writeSentenceToVault = (dir: DirHandle, record: VaultSentenceRecord) => writeCollectionRecord(dir, 'sentence', record);

export async function deleteCollectionRecord(dir: DirHandle, kind: CollectionKind, id: string): Promise<void> {
  const collection = await readCollection(dir, kind);
  collection.documents = collection.documents.filter(text => documentId(text, kind) !== id);
  await writeTextFile(dir, [COLLECTION_FILES[kind]], serializeCollection(collection, kind), collection.source);
  const { records: data, source } = await readRecordData(dir);
  delete data[kind][id];
  await writeTextFile(dir, [META_DIR, RECORDS_FILE], JSON.stringify(data), source);
}

/** 会话写入：完整历史一份（受管内容整体替换；个人笔记不在此文件）。 */
export async function writeChatToVault(
  dir: DirHandle,
  chatId: string,
  title: string,
  markdown: string,
): Promise<{ path: string }> {
  const index = await readIndex(dir);
  const known = index[chatId];
  const path = known && known.startsWith('对话/') ? known : `对话/${vaultFileName(title, chatId)}`;
  await writeTextFile(dir, path.split('/'), markdown);
  index[chatId] = path;
  await writeIndex(dir, index);
  return { path };
}

/** 材料快照写入：每版本一份，不可变（存在即跳过）。 */
export async function writeMaterialToVault(
  dir: DirHandle,
  chatId: string,
  snapshot: MaterialSnapshotRecord,
): Promise<{ path: string }> {
  const id = materialIdOf(chatId, snapshot.version);
  const index = await readIndex(dir);
  if (index[id]) return { path: index[id]! }; // 不可变：已存在不重写
  const path = `材料/${vaultFileName(snapshot.label, id)}`;
  await writeTextFile(dir, path.split('/'), serializeMaterialSnapshot(chatId, snapshot));
  index[id] = path;
  await writeIndex(dir, index);
  return { path };
}

export { parseChatDocument, parseMaterialDocument };

export async function writePreferenceToVault(
  dir: DirHandle,
  pref: { defaultComprehensionLang: string; comprehensionOverrides: Record<string, string> },
): Promise<void> {
  await writeTextFile(dir, ['偏好.md'], serializePreferenceRecord(pref));
}

// ---- 读取（解析受管文件 → 记录清单；调用方与本地对账） -----------------------------

export interface VaultFileScan {
  vocab: { path: string; record: VaultVocabRecord; note: string }[];
  sentences: { path: string; record: VaultSentenceRecord }[];
  chats: { path: string; text: string }[];
  materials: { path: string; text: string }[];
  preference: { defaultComprehensionLang: string; comprehensionOverrides: Record<string, string> } | null;
  /** 解析失败但存在的受管文件（定位问题；不阻断其它记录） */
  broken: { path: string; reason: string }[];
  /** 读取失败（权限瞬断 / IO 错误）的文件数：>0 表示本轮扫描不完整，调用方须跳过删除检测 */
  readFailures: number;
  paths: string[];
}

export async function scanVault(dir: DirHandle): Promise<VaultFileScan> {
  const scan: VaultFileScan = { vocab: [], sentences: [], chats: [], materials: [], preference: null, broken: [], readFailures: 0, paths: [] };
  const { records: data } = await readRecordData(dir);
  const files = await listFilesRecursive(dir);
  scan.paths = files;
  for (const path of files) {
    if (!path.endsWith('.md')) continue;
    const read = await readTextFile(dir, path.split('/'));
    if ('failed' in read) { scan.readFailures++; continue; }
    if ('missing' in read) continue;
    try {
      if (path === COLLECTION_FILES.vocab || path.startsWith('词汇/')) {
        const documents = path === COLLECTION_FILES.vocab ? parseCollection(read.text, 'vocab').documents : [read.text];
        for (const text of documents) {
          const record = vocabRecord(text, data);
          scan.vocab.push({ path, record, note: record.note ?? '' });
        }
      } else if (path === COLLECTION_FILES.sentence || path.startsWith('句子/')) {
        const documents = path === COLLECTION_FILES.sentence ? parseCollection(read.text, 'sentence').documents : [read.text];
        for (const text of documents) scan.sentences.push({ path, record: sentenceRecord(text, data) });
      } else if (path.startsWith('对话/')) scan.chats.push({ path, text: read.text });
      else if (path.startsWith('材料/')) scan.materials.push({ path, text: read.text });
      else if (path === '偏好.md') scan.preference = parsePreferenceDocument(read.text);
    } catch (error) {
      scan.broken.push({ path, reason: String(error) });
    }
  }
  return scan;
}

/** Consolidate only recognized legacy records, keeping a recoverable copy of every source file. */
export async function migrateVaultCollections(dir: DirHandle): Promise<void> {
  for (const kind of ['vocab', 'sentence'] as const) {
    const legacyDir = kind === 'vocab' ? '词汇/' : '句子/';
    const paths = (await listFilesRecursive(dir)).filter(path => path.startsWith(legacyDir) && path.endsWith('.md'));
    if (!paths.length) continue;
    const collection = await readCollection(dir, kind);
    const ids = new Set(collection.documents.map(text => documentId(text, kind)));
    const originals: { path: string; text: string }[] = [];
    for (const path of paths) {
      const read = await readTextFile(dir, path.split('/'));
      if (!('text' in read)) throw new Error(`io: ${path}`);
      const parsed = kind === 'vocab' ? parseVocabDocument(read.text) : parseSentenceDocument(read.text);
      if ('error' in parsed || !parsed.id) continue; // Unrelated or broken notes stay in their original directory.
      if (!ids.has(parsed.id)) { collection.documents.push(read.text); ids.add(parsed.id); }
      else if (collection.documents.find(text => documentId(text, kind) === parsed.id)!.trim() !== read.text.trim()) {
        throw new Error(`conflict: duplicate legacy record ${parsed.id}`);
      }
      originals.push({ path, text: read.text });
    }
    if (!originals.length) continue;
    const markdown = serializeCollection(collection, kind);
    await writeTextFile(dir, [COLLECTION_FILES[kind]], markdown, collection.source);
    const verified = await readTextFile(dir, [COLLECTION_FILES[kind]]);
    if (!('text' in verified) || verified.text !== markdown) throw new Error('io: migration verification');
    for (const original of originals) {
      await writeTextFile(dir, [META_DIR, 'legacy', ...original.path.split('/')], original.text);
      const parts = original.path.split('/');
      let parent = dir;
      for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part);
      const current = await readTextFile(dir, parts);
      if (!('text' in current) || current.text !== original.text) throw new Error(`conflict: legacy file changed ${original.path}`);
      await parent.removeEntry(parts.at(-1)!);
    }
  }
}

export async function readVocabRecordById(dir: DirHandle, id: string): Promise<{ record: VaultVocabRecord; note: string; text: string } | null> {
  const collection = await readCollection(dir, 'vocab');
  const text = collection.documents.find(text => documentId(text, 'vocab') === id);
  if (!text) return null;
  const record = vocabRecord(text, (await readRecordData(dir)).records);
  return { text, record, note: record.note ?? '' };
}

// ---- 权限与页面侧选目录 -----------------------------------------------------------

export async function ensurePermission(
  dir: DirHandle,
  mode: 'read' | 'readwrite' = 'readwrite',
): Promise<'granted' | 'prompt' | 'denied'> {
  return dir.queryPermission ? dir.queryPermission({ mode }) : 'granted';
}

/** Only a page click can renew directory access; the worker checks permissions without prompting. */
export async function authorizeVaultInPage(): Promise<PermissionState> {
  const dir = await getVaultHandle() as DirHandle | null;
  if (!dir) throw new Error('not-connected');
  const permission = await ensurePermission(dir);
  return permission === 'granted' || !dir.requestPermission ? permission : dir.requestPermission({ mode: 'readwrite' });
}

/**
 * 页面侧选目录并授权（需用户激活；仅在扩展页面调用）。
 * 句柄直接写入 blc-learning 的 vault store（同源 IDB；background 随后读取）。
 * 返回 false = 用户取消或 API 不可用。
 */
export async function pickVaultDirectoryInPage(): Promise<boolean> {
  const picker = (window as unknown as {
    showDirectoryPicker?: (o: { mode: 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker;
  if (!picker) return false;
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await picker.call(window, { mode: 'readwrite' });
  } catch {
    return false; // 用户取消
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('vault', 'readwrite');
      tx.objectStore('vault').put(dir, 'handle');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
  return true;
}
