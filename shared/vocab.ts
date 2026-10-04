import type { DictionaryEntry } from '@/lib/onlineDictionary';
import { entryKeyOf, normalizeExpressionInLanguage, type LanguageTag } from './languages';

// 词汇与上下文的纯逻辑：类型、规范化、去重判定、词形关联。
// background 的 IndexedDB 写入与 tools/regress.ts 共用，保证事务里执行的
// 决策与离线回归检查的是同一套逻辑。
//
// M11 起词条带语言身份（shared/languages.ts 是唯一落点）：
// - 新记录键为 `${lang}::${表达}`，language 字段与键一致；
// - 无 language 字段且键无 '::' 的是迁移前旧记录，运行时按现状处理，
//   语言由迁移批次按证据赋值（不清库、不盲目标英语）。

export type LearningResult =
  | { kind: 'dictionary'; entry: DictionaryEntry; selectedSense?: number }
  | { kind: 'translation'; source: 'google-gtx'; text: string }
  // M11 AI 查词兜底的结果（主动查词、词典明确未命中时）；与 ai-context 语境解释、
  // 普通译文可区分。lang 记录请求时的语言对快照。
  | {
      kind: 'ai-definition';
      source: 'ai';
      text: string;
      lang: { source: LanguageTag; target: LanguageTag };
      provider?: import('./aiConfig').AiProvider;
      model?: string;
    };

export interface ContextExplanation {
  kind: 'ai-context'; source: 'deepseek' | 'ai'; provider?: import('./aiConfig').AiProvider; model?: string; text: string; sentence: string; neighbors?: string;
}

export type VocabStatus = 'saved' | 'learning' | 'known';

export const VOCAB_STATUSES: readonly VocabStatus[] = ['saved', 'learning', 'known'];

export function isVocabStatus(v: unknown): v is VocabStatus {
  return v === 'saved' || v === 'learning' || v === 'known';
}

/** 网页选词快照：在弹窗打开时固定，保存与解释都用这一份。 */
export interface WebSnapshot {
  source: 'web';
  expression: string;
  sentence: string;
  url: string;
  title: string;
  /** 内容源语言（局部判断产物）；缺省 = 调用方未提供（迁移前行为），'und' = 待确认 */
  lang?: LanguageTag;
}

/** 视频字幕轨道身份 + 起始毫秒。UI / URL 的秒数只在边界处转换。 */
export interface VideoRef {
  videoId: string;
  /** 稳定轨道标识（normTrackKey 产物） */
  trackId: string;
  trackKind: 'manual' | 'asr';
  trackLang: string;
  /** 字幕起始毫秒 */
  startMs: number;
}

/** 视频查词快照：原句 = 当前字幕，相邻字幕仅作释义语境。 */
export interface VideoSnapshot {
  source: 'video';
  expression: string;
  sentence: string;
  neighbors?: string;
  video: VideoRef;
  title: string;
  /** 内容源语言；缺省时视频侧默认取 video.trackLang */
  lang?: LanguageTag;
}

export type LookupSnapshot = WebSnapshot | VideoSnapshot;

export interface SavedSentence {
  id: string;
  video: VideoRef;
  text: string;
  zh?: string;
  translationSource?: string;
  endMs: number;
  title: string;
  createdAt: number;
  /** 原文语言（默认 video.trackLang）；'und' = 待确认 */
  language?: LanguageTag;
}

export function sentenceId(video: VideoRef, text: string): string {
  return JSON.stringify([video.videoId, video.trackId, video.startMs, collapseWhitespace(text)]);
}

/** IndexedDB entries 记录（key 为规范化键）。forms 为关联词形（规范化后）。 */
export interface VocabEntryRecord {
  key: string;
  /** 源语言（'und' = 待确认）；缺失 = 迁移前旧记录，待语言迁移赋值 */
  language?: LanguageTag;
  expression: string;
  kind: 'word' | 'phrase';
  status: VocabStatus;
  /** 个人笔记（M11：学习库“我的笔记”双向同步；也可在详情内编辑） */
  note?: string;
  createdAt: number;
  updatedAt: number;
  forms?: string[];
}

/** IndexedDB contexts 记录。旧记录缺 sourceType / video 时按 web 读取。 */
export interface ContextRecord {
  id?: number;
  entryKey: string;
  sentence: string;
  definition: string | null; // 历史语境释义，来源未知
  result?: LearningResult;
  explanation?: ContextExplanation;
  sourceType: 'web' | 'video';
  url: string;
  title: string;
  video?: VideoRef | null;
  createdAt: number;
}

/**
 * 规范化键（PRD）：Unicode NFC、合并连续空白、去首尾空白、英文小写。
 * 保留原始拼写与内部标点。
 */
export function normalizeExpression(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function expressionKind(expr: string): 'word' | 'phrase' {
  return /\s/.test(expr.trim()) ? 'phrase' : 'word';
}

/** 视频来源链接：起始毫秒 → 秒参数（边界转换唯一落点）。 */
export function videoContextUrl(videoId: string, startMs: number): string {
  const sec = Math.max(0, Math.round(startMs / 1000));
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${sec}s`;
}

/** 网页上下文重复判定：同一词条 + 同一 URL + 同一（空白折叠后的）原文片段。 */
export function isDuplicateContext(
  existing: Pick<ContextRecord, 'entryKey' | 'url' | 'sentence'>,
  entryKey: string,
  url: string,
  sentence: string,
): boolean {
  return (
    existing.entryKey === entryKey &&
    existing.url === url &&
    collapseWhitespace(existing.sentence) === collapseWhitespace(sentence)
  );
}

/**
 * 视频上下文重复判定：词条 + videoId + 轨道 + 起始时间 + 原文。
 * 同一句在视频不同位置（startMs 不同）分别保存。
 */
export function isDuplicateVideoContext(
  existing: Pick<ContextRecord, 'entryKey' | 'sentence' | 'video'>,
  entryKey: string,
  video: VideoRef,
  sentence: string,
): boolean {
  if (existing.entryKey !== entryKey) return false;
  const ev = existing.video;
  if (!ev) return false;
  if (ev.videoId !== video.videoId || ev.trackId !== video.trackId) return false;
  if (ev.startMs !== video.startMs) return false;
  return collapseWhitespace(existing.sentence) === collapseWhitespace(sentence);
}

// ---- 保存 / 删除 / 补释义的决策（纯），background 在单一事务中执行 ----------

export interface SavePlan {
  entry: VocabEntryRecord; // 写入 entries（新建或保留/显式更新状态）
  context: ContextRecord & { id?: number }; // 写入 contexts（id 有值为更新）
  appended: boolean; // 是否追加了新上下文
  status: VocabStatus; // 生效状态
}

/**
 * 一次保存的全部决策（网页 / 视频共用）：
 * - 词条不存在 → 以 status ?? 'saved' 新建；
 * - 词条已存在 → 保持当前状态；仅当请求携带显式状态（“已掌握”等用户操作）时更新；
 * - 网页上下文按 (entryKey, url, sentence) 去重；视频上下文按
 *   (entryKey, videoId, trackId, startMs, sentence) 去重；
 * - 已存在且此前无释义时补上本次释义。
 * 词形关联的合并见 planForms（需要全量词条的占用信息）。
 */
export function planSave(
  existingEntry: VocabEntryRecord | undefined,
  existingContexts: Pick<ContextRecord, 'id' | 'entryKey' | 'url' | 'sentence' | 'definition' | 'video'>[],
  snapshot: LookupSnapshot,
  opts: { status?: VocabStatus; definition?: string; now?: number },
): SavePlan | null {
  const raw = collapseWhitespace(snapshot.expression);
  // 语言作用域键：同一表达在不同语言是不同词条（M11 L2）。
  // 快照无 lang 时沿用旧键格式（迁移前调用方 / 旧消息兼容）。
  const key =
    existingEntry?.key ??
    (snapshot.lang ? entryKeyOf(snapshot.lang, raw) : normalizeExpression(raw));
  if (!key) return null;
  const now = opts.now ?? Date.now();

  let entry: VocabEntryRecord;
  if (existingEntry) {
    entry = { ...existingEntry };
    // 重复保存保持当前状态；仅显式操作（如“已掌握”）改变它。
    if (opts.status) entry.status = opts.status;
  } else {
    entry = {
      key,
      language: snapshot.lang, // 可能是 'und'（待确认，收藏不被语言不确定阻断）
      expression: raw, // 保留原始大小写
      kind: expressionKind(raw),
      status: opts.status ?? 'saved',
      createdAt: now,
      updatedAt: now,
    };
  }
  entry.updatedAt = now;

  const patchDup = (
    dup: Pick<ContextRecord, 'id' | 'entryKey' | 'url' | 'sentence' | 'definition' | 'video'>,
  ): SavePlan => {
    const definition =
      !dup.definition && opts.definition ? opts.definition : dup.definition ?? null;
    return {
      entry,
      context: { ...(dup as ContextRecord), definition, id: dup.id },
      appended: false,
      status: entry.status,
    };
  };

  if (snapshot.source === 'video') {
    const dup = existingContexts.find((c) =>
      isDuplicateVideoContext(c, key, snapshot.video, snapshot.sentence),
    );
    if (dup) return patchDup(dup);
    return {
      entry,
      context: {
        entryKey: key,
        sentence: collapseWhitespace(snapshot.sentence).slice(0, 2000),
        definition: opts.definition ?? null,
        sourceType: 'video',
        url: videoContextUrl(snapshot.video.videoId, snapshot.video.startMs),
        title: snapshot.title.slice(0, 300),
        video: snapshot.video,
        createdAt: now,
      },
      appended: true,
      status: entry.status,
    };
  }

  const dup = existingContexts.find((c) =>
    isDuplicateContext(c, key, snapshot.url, snapshot.sentence),
  );
  if (dup) return patchDup(dup);
  return {
    entry,
    context: {
      entryKey: key,
      sentence: collapseWhitespace(snapshot.sentence).slice(0, 2000),
      definition: opts.definition ?? null,
      sourceType: 'web',
      url: snapshot.url,
      title: snapshot.title.slice(0, 300),
      createdAt: now,
    },
    appended: true,
    status: entry.status,
  };
}

/** 补释义条件：仅当该上下文尚无释义时补上（不覆盖、不写入别的选区）。 */
export function shouldBackfill(
  context: Pick<ContextRecord, 'definition'> | undefined,
): boolean {
  return !!context && (context.definition === null || context.definition === undefined);
}

// ---- 词形关联（M3）：只存模型给出的明确关联，不后台批量调用 AI --------------

/** 词汇轻量索引项（content script 标记 / 关联解析用，不含上下文）。 */
export interface VocabIndexItem {
  key: string;
  /** 缺失 = 迁移前旧记录：标记按现状处理，不套用到其它语言的同形词 */
  language?: LanguageTag;
  expression: string;
  status: VocabStatus;
  forms: string[];
}

/** 词条 / 索引项的最小形状（forms 可选，兼容旧记录）。 */
export type FormIndexInput = { key: string; forms?: string[] };

/**
 * 词形 → 词条映射。一个词形只允许映射到一个明确词条；被多个词条声明时
 * 视为冲突，返回的映射里不包含它（调用方按独立表达处理）。
 */
export function buildFormIndex(items: FormIndexInput[]): Map<string, string> {
  const keySet = new Set(items.map((it) => it.key));
  const count = new Map<string, string[]>();
  for (const it of items) {
    for (const f of it.forms ?? []) {
      if (f === it.key) continue; // 自身冗余
      if (keySet.has(f)) continue; // 该词形本身是独立词条：精确词条优先
      const owners = count.get(f) ?? [];
      if (!owners.includes(it.key)) owners.push(it.key);
      count.set(f, owners);
    }
  }
  const index = new Map<string, string>();
  for (const [form, owners] of count) {
    if (owners.length === 1) index.set(form, owners[0]!);
  }
  return index;
}

/**
 * 表面词形 → 词条键：精确词条优先；否则查唯一的词形关联；
 * 冲突或无关联返回 null（保留独立表达）。
 * lang 提供时按该语言规范化（如土耳其语大小写）；缺省沿用旧规范化
 *（迁移前调用方兼容）。跨语言的同形词靠语言作用域键天然分离。
 */
export function resolveEntryKey(
  items: FormIndexInput[],
  surface: string,
  lang?: LanguageTag,
): string | null {
  const key = lang ? normalizeExpressionInLanguage(surface, lang) : normalizeExpression(surface);
  if (!key) return null;
  if (items.some((it) => it.key === key)) return key;
  const formIndex = buildFormIndex(items);
  return formIndex.get(key) ?? null;
}

/**
 * 词条 forms 合并决策：新词形来自同次释义结果；以下情况不并入 ——
 * 已是某词条自身的键（保留独立表达）、已被其它词条声明（冲突）。
 * lang 提供时按该语言规范化（词形关联限同一语言，M11 spec 3.4）；
 * 缺省沿用旧规范化（迁移前调用方兼容）。
 */
export function planForms(
  selfKey: string,
  existingForms: string[],
  incoming: string[],
  occupied: { isEntryKey: (k: string) => boolean; ownerOf: (f: string) => string | undefined },
  lang?: LanguageTag,
): string[] {
  const merged = [...existingForms];
  for (const raw of incoming) {
    const f = lang ? normalizeExpressionInLanguage(raw, lang) : normalizeExpression(raw);
    if (!f || f === selfKey) continue;
    if (merged.includes(f)) continue;
    if (occupied.isEntryKey(f)) continue; // 它自己是独立词条
    const owner = occupied.ownerOf(f);
    if (owner && owner !== selfKey) continue; // 冲突：保留独立表达
    merged.push(f);
  }
  return merged;
}

/** 解析模型回复中的“词形：”行 → 规范化词形列表（可为空）。 */
export function parseFormsLine(line: string): string[] {
  return line
    .split(/[,，、;；/|\s]+/)
    .map((w) => normalizeExpression(w))
    .filter(Boolean);
}

/**
 * 表面词形 → 状态：含词形关联；冲突词形不出现（保留独立表达）。
 * 页面标记与字幕词标记共用同一判定。
 */
export function buildSurfaceStatusMap(
  items: (FormIndexInput & { status: VocabStatus })[],
): Map<string, VocabStatus> {
  const map = new Map<string, VocabStatus>();
  for (const it of items) map.set(it.key, it.status);
  const formIndex = buildFormIndex(items);
  for (const [form, owner] of formIndex) {
    const ownerItem = items.find((it) => it.key === owner);
    if (ownerItem) map.set(form, ownerItem.status);
  }
  return map;
}

/**
 * 复习视图：把原句中的表达替换为占位符。词边界用字母数字环视，
 * 短语按完整表达匹配。返回替换后的句子与命中次数。
 */
export function blankExpression(sentence: string, expression: string): {
  text: string;
  count: number;
} {
  const esc = expression.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!esc) return { text: sentence, count: 0 };
  const re = new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, 'gi');
  let count = 0;
  const text = sentence.replace(re, () => {
    count++;
    return '____';
  });
  return { text, count };
}
