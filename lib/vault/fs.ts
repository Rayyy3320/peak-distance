// M11 学习库目录访问层：唯一接触磁盘文件的地方。
// 由 background（读写）与扩展页面（授权/选目录）调用；句子／词条／偏好的
// Markdown 往返在 ./format.ts，合并决策在 mergeVocabRecord。
//
// 探针实证（tools/m11-vault-probe.mjs）：
// - 句柄可存 IndexedDB，SW 重启 / 浏览器重启后仍可读写；
// - 并发替换写会使先前 FileHandle 失效 → 本层每次操作都重新获取句柄；
// - 结构：词汇/<lang>/*.md、句子/、对话/、材料/、偏好.md、.peak-distance/。

import {
  applyVocabToDocument,
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
import { DB_NAME, DB_VERSION } from '@/lib/db';
import {
  VAULT_FORMAT_VERSION,
  type VaultIdentity,
  type VaultPendingWrite,
  type VaultSentenceRecord,
  type VaultVocabRecord,
} from '@/shared/vault';
import { primaryOfLang } from '@/shared/languages';

/** 目录内学习库身份文件（JSON；vaultId 是换库判定依据）。 */
const META_DIR = '.peak-distance';
const IDENTITY_FILE = 'identity.json';
const INDEX_FILE = 'index.json'; // recordId → 相对路径（两浏览器共享的路径索引）
const README_FILE = '使用说明.md';

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

/** 宽松读取：缺失与读取失败都当无内容（仅身份/索引这类可安全重建的数据使用）。 */
async function readTextIfAny(dir: DirHandle, path: string[]): Promise<string | null> {
  const r = await readTextFile(dir, path);
  return 'text' in r ? r.text : null;
}

async function writeTextFile(dir: DirHandle, path: string[], text: string): Promise<void> {
  let d = dir;
  for (const seg of path.slice(0, -1)) d = await d.getDirectoryHandle(seg, { create: true });
  const fh = await d.getFileHandle(path.at(-1)!, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
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
      // 只深入受管目录：词汇 / 句子 / 对话；材料由记录引用，不整库扫描
      if (prefix.length === 0 && !['词汇', '句子', '对话'].includes(name)) continue;
      out.push(...(await listFilesRecursive(handle as DirHandle, [...prefix, name])));
    }
  }
  return out;
}

// ---- 身份与索引 -------------------------------------------------------------------

export async function ensureVault(dir: DirHandle): Promise<VaultIdentity> {
  const raw = await readTextIfAny(dir, [META_DIR, IDENTITY_FILE]);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as VaultIdentity;
      if (parsed?.vaultId && typeof parsed.vaultId === 'string') {
        return { ...parsed, formatVersion: VAULT_FORMAT_VERSION };
      }
    } catch {
      /* 坏身份文件按新库初始化（不覆盖正文，身份文件重建） */
    }
  }
  const identity: VaultIdentity = {
    vaultId: crypto.randomUUID(),
    formatVersion: VAULT_FORMAT_VERSION,
    createdAt: Date.now(),
  };
  await writeTextFile(dir, [META_DIR, IDENTITY_FILE], JSON.stringify(identity, null, 2));
  await writeTextFile(
    dir,
    [META_DIR, README_FILE],
    [
      '# 学习库',
      '',
      '- 词汇 / 句子 / 对话 下的 Markdown 由扩展管理：frontmatter 的 id、language、expression、status 与“原句”块是受管字段，其余内容可自由编辑。',
      '- 状态取值：saved = 已收藏，learning = 在学，known = 已掌握。',
      '- 修改“我的笔记”或状态会被扩展读回；改语言/表达等身份请通过扩展入口。',
      '- `.peak-distance` 是扩展的辅助数据（身份、路径索引），请勿手改。',
    ].join('\n'),
  );
  return identity;
}

interface VaultIndex {
  [recordId: string]: string; // 相对路径（词汇/ja/xxx.md）
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

function vocabDirOf(recordId: string): string {
  // 键形如 ja::学ぶ / und::pain；旧裸键（无 ::）按 und 归档
  const idx = recordId.indexOf('::');
  const lang = idx > 0 ? primaryOfLang(recordId.slice(0, idx)) : 'und';
  return `词汇/${lang}`;
}

// ---- 写入（受管字段；保留用户内容） -------------------------------------------------

export async function writeVocabToVault(
  dir: DirHandle,
  record: VaultVocabRecord,
): Promise<{ path: string }> {
  const index = await readIndex(dir);
  const known = index[record.id];
  const targetDir = vocabDirOf(record.id);
  let path = known && known.startsWith(`${targetDir}/`) ? known : null;

  // 索引缺失时在同语言目录内按文件名前缀找一次（改名/移动恢复；不整库扫）
  if (!path) {
    for (const f of await listFilesRecursive(dir)) {
      if (!f.startsWith(`${targetDir}/`)) continue;
      const read = await readTextFile(dir, f.split('/'));
      // 读取失败≠不存在：无法确认记录是否已有文件，中止写入让待办重试（避免落重复文件）
      if ('failed' in read) throw new Error(`vault read failed: ${f}`);
      if ('missing' in read) continue;
      const parsed = parseVocabDocument(read.text);
      if (!('error' in parsed) && parsed.id === record.id) {
        path = f;
        break;
      }
    }
  }

  if (path) {
    const read = await readTextFile(dir, path.split('/'));
    // 读取失败不得当“文件不存在”整体重写（会丢用户在 Obsidian 自由编辑的内容）
    if ('failed' in read) throw new Error(`vault read failed: ${path}`);
    const existing = 'text' in read ? read.text : null;
    const next =
      existing !== null && !('error' in parseVocabDocument(existing))
        ? applyVocabToDocument(record, existing)
        : serializeVocabRecord(record);
    if (typeof next !== 'string') {
      // 受管写回失败（文件损坏）：保留原文件，另存修复副本，不覆盖
      path = `${targetDir}/${vaultFileName(record.expression, record.id)}`;
      await writeTextFile(dir, path.split('/'), serializeVocabRecord(record));
    } else {
      await writeTextFile(dir, path.split('/'), next);
    }
  } else {
    path = `${targetDir}/${vaultFileName(record.expression, record.id)}`;
    await writeTextFile(dir, path.split('/'), serializeVocabRecord(record));
  }
  index[record.id] = path;
  await writeIndex(dir, index);
  return { path };
}

export async function writeSentenceToVault(
  dir: DirHandle,
  record: VaultSentenceRecord,
): Promise<{ path: string }> {
  const path = `句子/${vaultFileName(record.text, record.id)}`;
  await writeTextFile(dir, path.split('/'), serializeSentenceRecord(record));
  const index = await readIndex(dir);
  index[record.id] = path;
  await writeIndex(dir, index);
  return { path };
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
  const files = await listFilesRecursive(dir);
  scan.paths = files;
  for (const f of files) {
    const read = await readTextFile(dir, f.split('/'));
    if ('failed' in read) { scan.readFailures++; continue; }
    if ('missing' in read) continue; // 扫描间隙被外部删除：合法缺失
    const text = read.text;
    if (f.startsWith('对话/')) {
      scan.chats.push({ path: f, text });
      continue;
    }
    if (f.startsWith('材料/')) {
      scan.materials.push({ path: f, text });
      continue;
    }
    if (f === '偏好.md') {
      const parsed = parsePreferenceDocument(text);
      if (!('error' in parsed)) {
        scan.preference = {
          defaultComprehensionLang: parsed.defaultComprehensionLang,
          comprehensionOverrides: parsed.comprehensionOverrides,
        };
      }
      continue;
    }
    if (f.startsWith('词汇/')) {
      const parsed = parseVocabDocument(text);
      if ('error' in parsed) { scan.broken.push({ path: f, reason: parsed.error }); continue; }
      if (!parsed.id || !parsed.expression) { scan.broken.push({ path: f, reason: 'missing-identity' }); continue; }
      scan.vocab.push({
        path: f,
        note: parsed.note,
        record: {
          id: parsed.id,
          language: parsed.language ?? 'und',
          expression: parsed.expression,
          status: parsed.status ?? 'saved',
          forms: [],
          createdAt: 0,
          updatedAt: 0,
          contexts: parsed.managed.contexts,
        },
      });
    }
    if (f.startsWith('句子/')) {
      const parsed = parseSentenceDocument(text);
      if ('error' in parsed) { scan.broken.push({ path: f, reason: parsed.error }); continue; }
      if (!parsed.id) { scan.broken.push({ path: f, reason: 'missing-identity' }); continue; }
      scan.sentences.push({ path: f, record: parsed as unknown as VaultSentenceRecord });
    }
  }
  return scan;
}

/** 按 ID 读取库中现有词条（写前检查用）：索引命中或受管目录内扫描。 */
export async function readVocabRecordById(
  dir: DirHandle,
  recordId: string,
): Promise<{ record: VaultVocabRecord; note: string; text: string } | null> {
  const index = await readIndex(dir);
  let paths: string[] = [];
  if (index[recordId]) paths.push(index[recordId]);
  else {
    const targetDir = vocabDirOf(recordId);
    paths = (await listFilesRecursive(dir)).filter((f) => f.startsWith(`${targetDir}/`));
  }
  for (const p of paths) {
    const read = await readTextFile(dir, p.split('/'));
    if ('missing' in read) continue;
    // 读取失败≠不存在：抛错让调用方（flush）走 catch 保留待办，不当新文件覆盖丢三方合并 base
    if ('failed' in read) throw new Error(`vault read failed: ${p}`);
    const text = read.text;
    const parsed = parseVocabDocument(text);
    if ('error' in parsed) continue;
    if (parsed.id !== recordId) continue;
    return {
      text,
      note: parsed.note,
      record: {
        id: parsed.id!,
        language: parsed.language ?? 'und',
        expression: parsed.expression!,
        status: parsed.status ?? 'saved',
        forms: [],
        createdAt: 0,
        updatedAt: 0,
        contexts: parsed.managed.contexts,
      },
    };
  }
  return null;
}

// ---- 权限与页面侧选目录 -----------------------------------------------------------

export async function ensurePermission(
  dir: DirHandle,
  mode: 'read' | 'readwrite' = 'readwrite',
): Promise<'granted' | 'prompt' | 'denied'> {
  const q = dir.queryPermission ? await dir.queryPermission({ mode }) : 'granted';
  if (q === 'granted') return 'granted';
  // requestPermission 需要用户激活；无激活时返回当前状态（调用方提示重授权）
  try {
    const r = dir.requestPermission ? await dir.requestPermission({ mode }) : q;
    return r;
  } catch {
    return q === 'denied' ? 'denied' : 'prompt';
  }
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
