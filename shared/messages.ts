import type { DictionarySource } from '@/lib/onlineDictionary';
import type { Settings } from './settings';
import type { LearningResult, ContextExplanation } from './vocab';
// 扩展内部消息协议（chrome.runtime 消息）。
// shared/protocol.ts 是 YouTube 页面内 MAIN↔ISOLATED 的 postMessage 桥，
// 与本文件无关；词汇、翻译与设置消息一律走 chrome.runtime，不借道页面。
//
// 另有一组“标签页直达”消息（blc-tab-*）：侧栏经 tabs.sendMessage 发给
// 指定标签页的 content script（字幕视图 / 播放控制），不经过 background。

import type { LookupSnapshot, VocabIndexItem, VocabStatus } from './vocab';
import type { LanguageTag } from './languages';
import type { VaultIdentity, VaultStatus } from './vault';
import type {
  ChatRecordView,
  MaterialPayload,
  QuoteRef,
  SourceDescriptor,
} from './chat';

export type LookupErrorCode =
  | 'invalid-config'
  | 'permission'
  | 'no-key'
  | 'auth'
  | 'rate-limit'
  | 'network'
  | 'http'
  | 'bad-response';

/**
 * M11 查询意图（spec 3.3 路由表）：hover / preview / prefetch 一律不触发
 * AI 兜底；缺省按 active（主动点击）处理（迁移前消息兼容）。
 */
export type LookupIntent = 'active' | 'hover' | 'preview' | 'prefetch';

/** content script / 侧栏 / 设置页 → background 的请求。 */
export type BgcRequest =
  | {
      type: 'translateSelection';
      text: string;
      requestId: string;
      sourceLang?: LanguageTag;
      targetLang?: LanguageTag;
    }
  | {
      type: 'lookup';
      snapshot: LookupSnapshot; // 源语言在 snapshot.lang（'und' = 待确认）
      source?: DictionarySource;
      /** 理解语言（目标）；缺省用设置解析 */
      targetLang?: LanguageTag;
      intent?: LookupIntent;
      requestId?: string;
    }
  | { type: 'explainContext'; snapshot: LookupSnapshot; targetLang?: LanguageTag; requestId?: string }
  | { type: 'cancelOnline'; requestId: string }
  | { type: 'subtitleMode'; videoId: string; mode?: 'regular' | 'ai'; autoPause?: boolean }
  | { type: 'saveSentence'; sentence: import('./vocab').SavedSentence }
  | { type: 'listSentences' }
  | { type: 'deleteSentence'; id: string }
  | { type: 'openLearning'; view: 'list' | 'sentences' | 'review' }
  | { type: 'captionCache'; key: string; cues?: import('./protocol').Cue[] }
  | { type: 'getEntry'; key: string } // background 侧做词形关联解析
  | {
      type: 'save';
      snapshot: LookupSnapshot;
      status?: VocabStatus;
      definition?: string;
      result?: LearningResult;
      explanation?: ContextExplanation;
      forms?: string[];
    }
  | { type: 'backfillResult'; contextId: number; result?: LearningResult; explanation?: ContextExplanation }
  | { type: 'backfillDefinition'; contextId: number; definition: string }
  | { type: 'setStatus'; key: string; status: VocabStatus } // 落到关联词条
  | { type: 'deleteEntry'; key: string }
  | { type: 'removeForm'; key: string; form: string }
  | { type: 'listEntries'; query?: string; language?: string } // language: 'all'（缺省）| 语言标签 | 'und'
  | { type: 'vocabIndex' } // 轻量索引：content script 标记用，不含上下文
  | { type: 'getSettings' } // 不含 key
  | { type: 'setSetting'; name: keyof Settings; value: Settings[keyof Settings] }
  | {
      type: 'translateCues';
      mode: 'regular' | 'ai';
      requestId?: string;
      videoId: string;
      trackId: string;
      sourceLang?: LanguageTag; // 原文轨道语言
      targetLang?: LanguageTag; // 译文语言
      items: { id: number; text: string }[];
    }
  // ---- M11 学习库（目录句柄与读写由 lib/vault/** 提供，background 只路由） ----
  | { type: 'vaultConnect' } // 选择目录并授权（在探针证明的授权上下文执行）
  | { type: 'vaultDisconnect' } // 断开：不删除文件，待办按库身份保留
  | { type: 'vaultReauthorize' } // 重新授权现有目录
  | { type: 'vaultStatus' }
  | { type: 'vaultFlush' } // 立即尝试提交待写入队列
  | { type: 'openSettings' };

export type OnlineLookupResult = { ok: true; result: LearningResult } | BgcError;

/** 显式 AI 语境解释结果。 */
export type LookupResult =
  | { ok: true; definition: string; note: string; forms?: string[]; provider?: import('./aiConfig').AiProvider; model?: string }
  | { ok: false; error: LookupErrorCode; detail?: string };

/** 字幕批量翻译结果：translations 按输入 id 对齐，只含成功行。 */
export type TranslateSentencesResult =
  | { ok: true; translations: { id: number; text: string }[] }
  | { ok: false; error: LookupErrorCode; detail?: string };

export interface ContextView {
  id: number;
  sentence: string;
  definition: string | null;
  result?: LearningResult;
  explanation?: ContextExplanation;
  sourceType: 'web' | 'video';
  url: string;
  title: string;
  createdAt: number;
  video?: {
    videoId: string;
    trackId: string;
    trackKind: 'manual' | 'asr';
    trackLang: string;
    startMs: number;
  } | null;
}

export interface EntryView {
  key: string;
  /** 缺失 = 迁移前旧记录；'und' = 待确认集合（可筛选／复习） */
  language?: LanguageTag;
  expression: string;
  kind: 'word' | 'phrase';
  status: VocabStatus;
  createdAt: number;
  updatedAt: number;
  forms: string[];
  contexts: ContextView[];
}

export type GetEntryResult = { ok: true; entry: EntryView | null } | BgcError;

export interface SaveResult {
  ok: true;
  status: VocabStatus;
  contextId: number;
  appended: boolean;
  key: string; // 实际落库的词条键（可能与表面词形不同：词形关联）
}

export type BgcError = { ok: false; error: string; detail?: string };

export type BackfillResult = { ok: true; filled: boolean } | BgcError;

export type RemoveFormResult = { ok: true; removed: boolean } | BgcError;

export type VocabIndexResult = { ok: true; items: VocabIndexItem[] } | BgcError;

/** 设置视图：只含可下发的项，绝不包含 key。 */
export type SettingsView = Settings;

export type GetSettingsResult = { ok: true; settings: SettingsView } | BgcError;

// ---- M11 学习库消息结果 ----------------------------------------------------------

export type VaultStatusResult = { ok: true; status: VaultStatus } | BgcError;
export type VaultConnectResult =
  | { ok: true; vault: VaultIdentity | null; imported: boolean } // imported = 首次连接合并了本机持久记录
  | BgcError;
export type VaultMutationResult = { ok: true } | BgcError;

/**
 * background → 扩展页面与各标签页 content script 的广播。
 * 扩展页面走 runtime.sendMessage；content script 走 tabs.sendMessage
 *（runtime 广播到不了 content script）。
 */
export type BroadcastEvent =
  | { type: 'ai-service-changed' }
  | { type: 'vocab-changed' }
  | { type: 'sentences-changed' }
  | { type: 'settings-changed' }
  /** 学习库状态变化：连接／断开、写入回执、读回变更（UI 刷新写入状态） */
  | { type: 'vault-changed' };

// ---- 标签页直达消息（侧栏 ↔ 视频页 content script） --------------------------

export interface SubtitleCueView {
  id: number;
  startMs: number;
  endMs: number;
  text: string;
  zh: string | null;
}

/** 侧栏 → 标签页：请求当前视频的字幕状态。 */
export interface SubGetMessage {
  type: 'blc-sub-get';
}

/** 侧栏 → 标签页：播放控制。videoId 不匹配当前视频时忽略（不串页）。 */
export interface SubControlMessage {
  type: 'blc-sub-control';
  videoId: string;
  action: 'seek' | 'togglePlay' | 'replay' | 'next' | 'prev';
  timeMs?: number;
}

export type TabMessage = SubGetMessage | SubControlMessage;

/** content script → 侧栏：字幕视图状态（非视频页 videoId 为空）。 */
export interface SubViewState {
  chineseVisible?: boolean;
  /** M11：当前译文语言（原文轨道 → 理解语言）；缺省视为中文（迁移前兼容） */
  translationLang?: LanguageTag;
  type: 'blc-sub-state';
  videoId: string;
  title: string;
  trackKind: 'manual' | 'asr' | '';
  trackLang: string;
  /** 稳定轨道标识（M5 问答材料快照需要；空 = 尚无轨道） */
  trackId: string;
  cues: SubtitleCueView[];
  currentIndex: number;
  playing: boolean;
  notice: string;
}

// ---- M5 上下文问答 -------------------------------------------------------------

/** 侧栏 / 内容脚本 → background 的问答 CRUD 请求（runtime.sendMessage）。 */
export type ChatRequest = (
  | { type: 'chatActive' | 'chatNew'; windowId: number }
  | { type: 'chatSelect'; chatId: string; windowId: number }
  | { type: 'chatRemoveMaterial' | 'chatDelete'; chatId: string }
  | { type: 'chatGet'; chatId: string }
  | { type: 'chatRecent' }
  | {
      type: 'chatEnsure';
      chatId?: string;
      windowId?: number;
      source: SourceDescriptor;
      material: MaterialPayload | null;
      quote?: QuoteRef | null;
      openPanel?: boolean;
    }
  | { type: 'chatUpdateMaterial'; chatId: string; material: MaterialPayload }
  | { type: 'chatSetDraft'; chatId: string; draft: string }
  | { type: 'chatTakeQuote'; chatId: string }
  | { type: 'chatRetain'; chatId: string; messageId: string; retained: boolean }
  | { type: 'chatClear'; chatId: string }
) & { windowId?: number; editId?: string };

export interface ChatRecentItem {
  chatId: string;
  sourceType: 'youtube' | 'article' | 'x' | null;
  title: string;
  url: string;
  questions: number;
  updatedAt: number;
}

export type ChatEnsureResult =
  | { ok: true; chat: ChatRecordView | null; panelOpened: boolean }
  | BgcError;
export type ChatGetResult = { ok: true; chat: ChatRecordView | null } | BgcError;
export type ChatMutationResult = { ok: true } | BgcError;

/** 侧栏 ↔ background 的问答长连接（browser.runtime.connect，name='blc-chat'）。 */
export const CHAT_PORT_NAME = 'blc-chat';

export type ChatPortMessage =
  | { type: 'chat-subscribe'; chatId: string }
  | { type: 'chat-unsubscribe'; chatId: string }
  | {
      type: 'chat-send';
      chatId: string;
      question: string;
      quote: QuoteRef | null;
      snapshotVersion: number;
      segmentIndex: number;
      windowId?: number;
      editId?: string;
    }
  | { type: 'chat-stop'; chatId: string }
  | { type: 'chat-retry'; chatId: string; turnId: string };

export type ChatPortEvent =
  | {
      type: 'chat-ev';
      chatId: string;
      requestId: string;
      turnId: string;
      kind: 'start' | 'delta' | 'done' | 'stopped' | 'error';
      text: string; // 全量累计正文（幂等，覆盖渲染）
      errorKind?: string;
      saved?: boolean;
    }
  | {
      type: 'chat-active';
      chatId: string;
      active: { requestId: string; turnId: string; text: string } | null;
    }
  | {
      /** 发送 / 重试的同步回执（busy、超长等错误在此返回）。 */
      type: 'chat-ack';
      chatId: string;
      ok: boolean;
      turnId?: string;
      requestId?: string;
      error?: string;
      submittedChatId?: string;
      editId?: string;
    };

/** 标签页直达：侧栏 ↔ 内容脚本的问答材料消息。 */
export interface ChatSourceQuery {
  type: 'blc-chat-source';
}

/** 标签页直达：按需取材料（打开问答 / 显式更新材料 / 带入新引用时才调用）。 */
export interface ChatMaterialQuery {
  type: 'blc-chat-material';
}

/** 内容脚本 → 侧栏：当前来源描述（无材料本体）。 */
export interface ChatSourceInfo {
  type: 'blc-chat-source-info';
  source: SourceDescriptor | null;
  canMaterial: boolean;
  hint: string;
}

export interface ChatMaterialInfo {
  type: 'blc-chat-material-info';
  material: MaterialPayload | null;
}

/** 网页引用定位：尝试滚动到保存的原文；返回是否找到。 */
export interface ChatLocateMessage {
  type: 'blc-chat-locate';
  text: string;
}
