// M11 学习库交换合同（C0）：本机（IndexedDB / 内存）与 Markdown 学习库之间
// 的数据边界。lib/vault/**（V 线程）实现读写与合并；本文件只定义形状。
//
// 权威边界（spec 4.1）：文件夹承载共享持久资料；IndexedDB 是运行副本、
// 索引及待写入队列。只有收到 VaultCommitReceipt.ok 才算“已写入学习库”，
// 未成功一律显示“已保存在本机，待写入”。

import type { ChatRecord } from './chat';
import type { VideoRef, VocabStatus, LearningResult, ContextExplanation } from './vocab';
import type { LanguageTag } from './languages';

export const VAULT_FORMAT_VERSION = 1;

/** 库身份：.peak-distance/ 中的格式版本与稳定标识；换库不混数据。 */
export interface VaultIdentity {
  vaultId: string;
  formatVersion: number;
  createdAt: number;
}

export type VaultRecordKind = 'vocab' | 'sentence' | 'chat' | 'preference';

// ---- 写入方向：待写入队列 → 学习库 ----------------------------------------------

/** 待写入单位。本机事务提交成功后入队；幂等键为 id（重试不重复导入）。 */
export interface VaultPendingWrite {
  id: string;
  kind: VaultRecordKind;
  /** 稳定记录标识：词条 = 语言作用域键、句子 = sentenceId、会话 = chatId */
  recordId: string;
  payload: VaultVocabRecord | VaultSentenceRecord | VaultChatRecord | VaultPreferenceRecord;
  queuedAt: number;
  attempts?: number;
  lastError?: string;
}

/** 词条的库交换形状：词条 + 全部语境（语言身份见 key/language）。 */
export interface VaultVocabRecord {
  id: string;
  language: LanguageTag;
  expression: string;
  status: VocabStatus;
  forms: string[];
  createdAt: number;
  updatedAt: number;
  contexts: VaultVocabContext[];
}

export interface VaultVocabContext {
  sentence: string;
  url: string;
  title: string;
  sourceType: 'web' | 'video';
  video?: VideoRef | null;
  createdAt: number;
  definition: string | null;
  result?: LearningResult;
  explanation?: ContextExplanation;
}

/** 句子收藏的库交换形状（与 IndexedDB SavedSentence 对应）。 */
export interface VaultSentenceRecord {
  id: string;
  language: LanguageTag;
  text: string;
  translation?: string;
  translationSource?: string;
  video: VideoRef;
  endMs: number;
  title: string;
  createdAt: number;
}

/**
 * 完整会话的库交换形状：全部已持久化消息与材料快照。
 * 排除未发送草稿与待提交引用（不写入共享库，spec 4.2）。
 * 生成状态原样保存：另一浏览器不把 streaming 改成中断（spec 4.5）。
 */
export type VaultChatRecord = Omit<ChatRecord, 'draft' | 'pendingQuote'>;

/** 偏好（偏好.md）：理解语言设置。Key / AI 配置 / 开关不写入共享库。 */
export interface VaultPreferenceRecord {
  defaultComprehensionLang: string;
  comprehensionOverrides: Record<string, string>;
}

/** 单次写入回执：ok 才显示“已写入学习库”；retry 表示值得自动重试。 */
export type VaultCommitReceipt =
  | { ok: true; writeId: string; committedAt: number }
  | {
      ok: false;
      writeId: string;
      error: 'no-permission' | 'vault-missing' | 'format' | 'conflict' | 'io' | 'busy';
      detail?: string;
      retry: boolean;
    };

// ---- 读取方向：学习库 → 本机 ----------------------------------------------------

/** 读回的单条记录变更（V 模块解析 Markdown 后的产物，按稳定 ID 对账）。 */
export interface VaultRecordUpdate {
  kind: VaultRecordKind;
  recordId: string;
  language?: LanguageTag;
  /** 解析后的记录本体（形状同写入方向的 payload） */
  content: VaultVocabRecord | VaultSentenceRecord | VaultChatRecord | VaultPreferenceRecord;
  /** 文件内最后修改时间（毫秒，可空）；仅展示用，不裁决冲突 */
  modifiedAt?: number | null;
}

/** 真实冲突（同字段两侧不同改法）：保留双方，交给用户处理。 */
export interface VaultConflictField {
  field: string;
  local: unknown;
  remote: unknown;
}

export interface VaultConflictRecord {
  kind: VaultRecordKind;
  recordId: string;
  fields: VaultConflictField[];
  local: unknown;
  remote: unknown;
}

/** 一次读取的结果：更新、删除（排除同 ID 移动后）、冲突。 */
export interface VaultChanges {
  vault: VaultIdentity | null;
  updated: VaultRecordUpdate[];
  deleted: string[];
  conflicts: VaultConflictRecord[];
  readAt: number;
}

// ---- 运行状态 -------------------------------------------------------------------

export interface VaultStatus {
  connected: boolean;
  identity: VaultIdentity | null;
  /** 待写入队列长度（本机已提交、尚未落库） */
  pendingCount: number;
  lastCommitAt: number | null;
  lastError: string | null;
}
