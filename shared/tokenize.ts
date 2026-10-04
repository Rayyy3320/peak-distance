// M11 统一语言边界（spec 3.4）：点击查词、悬停、页面标记、词次统计共用。
// 优先浏览器内置分词（Intl.Segmenter，word 粒度）；探针实证 ja/zh/th 无词中
// 断裂、RTL/土耳其语/德语复合词/重音均正确（tools/m11-probe-segmenter.ts）。
// 不建形态学引擎；语言清单外内容仍可拖选查询与保存。

import type { LanguageTag } from './languages';

export interface WordSegment {
  text: string;
  start: number;
  end: number;
}

const segmenterCache = new Map<string, Intl.Segmenter>();

function segmenterFor(lang: string): Intl.Segmenter {
  const key = lang || 'und';
  let seg = segmenterCache.get(key);
  if (!seg) {
    seg = new Intl.Segmenter(key, { granularity: 'word' });
    segmenterCache.set(key, seg);
  }
  return seg;
}

interface RawSegment {
  text: string;
  start: number;
  end: number;
  isWordLike: boolean;
}

function rawSegments(text: string, lang: string): RawSegment[] {
  return Array.from(segmenterFor(lang).segment(text)).map((s) => ({
    text: s.segment,
    start: s.index,
    end: s.index + s.segment.length,
    isWordLike: s.isWordLike === true,
  }));
}

/** 词级分段（仅词样段）。空文本返回空数组。 */
export function segmentWords(text: string, lang: string): WordSegment[] {
  if (!text) return [];
  return rawSegments(text, lang)
    .filter((s) => s.isWordLike)
    .map((s) => ({ text: s.text, start: s.start, end: s.end }));
}

/**
 * 偏移量所在的词（点击 / 光标定位）。落在标点或空白上时取 1 个字符内的
 * 紧邻词；两词等距或无词返回 null（调用方保持选区原样，不猜）。
 */
export function wordAt(text: string, offset: number, lang: string): WordSegment | null {
  if (!text) return null;
  const segs = rawSegments(text, lang);
  let best: WordSegment | null = null;
  let bestDist = 1; // 紧邻阈值：1 个字符内
  for (const s of segs) {
    if (!s.isWordLike) continue;
    // 区间左闭右开：词尾边界属于下一个词（学ぶ|。点击在 を|学ぶ 边界取学ぶ）
    if (offset >= s.start && offset < s.end) {
      return { text: s.text, start: s.start, end: s.end };
    }
    const dist = offset < s.start ? s.start - offset : offset - s.end;
    if (dist >= 0 && dist <= bestDist) {
      // 距离相同取后者（光标在两词之间时与浏览器双击行为一致：后词）
      best = { text: s.text, start: s.start, end: s.end };
      bestDist = dist;
    }
  }
  return best;
}

// ---- 脚本检测 → 语言桶 ------------------------------------------------------------
// 用于标记门控与快照语言初判（spec 3.2：局部内容判断；页面 lang 只是线索，
// 这里只做文字系统判定，不冒充语种鉴别）。拉丁脚本无法区分英/法/德，
// 保守按英语桶处理（英语已是默认学习语言；其它拉丁语词条不自动标记，
// 拖选查询与保存不受影响）。

const SCRIPT_LANGS: { lang: string; re: RegExp }[] = [
  { lang: 'ja', re: /[\u3040-\u309F\u30A0-\u30FF]/ }, // 平假名/片假名优先于汉字
  { lang: 'ko', re: /[\uAC00-\uD7AF\u1100-\u11FF]/ },
  { lang: 'ru', re: /[\u0400-\u04FF]/ },
  { lang: 'hi', re: /[\u0900-\u097F]/ },
  { lang: 'bn', re: /[\u0980-\u09FF]/ },
  { lang: 'th', re: /[\u0E00-\u0E7F]/ },
  { lang: 'fa', re: /[\u067E\u0686\u06AF\u06CC\u06A9]/ }, // 波斯语特有字符，先于阿拉伯
  { lang: 'ar', re: /[\u0600-\u06FF]/ },
];

/**
 * 局部文本的语言桶：ja/ko/ru/hi/bn/th/ar/fa 按文字系统直接判定；
 * 无假名的汉字 → zh；拉丁 → en（保守默认）；无法判定（数字/符号）→ null。
 */
export function detectTextLanguage(text: string): LanguageTag | null {
  if (!text) return null;
  for (const { lang, re } of SCRIPT_LANGS) if (re.test(text)) return lang;
  if (/[\u3400-\u4DBF\u4E00-\u9FFF]/.test(text)) return 'zh';
  if (/[A-Za-z]/.test(text)) return 'en';
  return null;
}

// ---- 选区分类与查词表达（选区查词 spec） ------------------------------------------
// 分类表：一个有效词（含词内撇号/连字符）→ word；2–5 个有效词且未跨正文块 /
// 字幕项 / 明确句界 → phrase；其余句段 → sentence。无空格不等于单词：无空格
// 文字系统（中日文等）按分词器计词数，不整段当一个词。

const WORD_CHAR = /[\p{L}\p{N}]/u;
const SENTENCE_END = /[.!?。！？；;]/;

/** token 边缘清理后的有效词计数：空格文字系统 1 token = 1 词；无空格系统按分词器。 */
function tokenWordCount(token: string, lang: string): number {
  const cleaned = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!cleaned || !WORD_CHAR.test(cleaned)) return 0;
  // 拉丁字母 token（don't / well-known）按 1 词；纯无空格文字按分词器计
  if (!/[A-Za-z]/.test(cleaned)) {
    const segs = segmentWords(cleaned, lang);
    if (segs.length > 1) return segs.length;
  }
  return 1;
}

export interface SelectionClass {
  kind: 'word' | 'phrase' | 'sentence';
  /** 是否存在有效查词表达（无 → 隐藏查词）。 */
  hasWord: boolean;
}

/** 选区本地分类（零 LLM）；crossesBlock=跨正文块/字幕项时直接落入句段。 */
export function classifySelection(
  raw: string,
  lang: string,
  opts: { crossesBlock?: boolean } = {},
): SelectionClass {
  const text = raw.trim();
  if (!text) return { kind: 'sentence', hasWord: false };
  let words = 0;
  for (const token of text.split(/\s+/)) words += tokenWordCount(token, lang);
  const hasWord = words > 0;
  // 明确句界：去尾部标点/空白/引号后，末字符之前仍存在句末标点（U.S. 一类不加语法识别，保守处理）
  const core = text.replace(/[^\p{L}\p{N}]+$/u, '');
  const crossedSentence = core.length > 1 && SENTENCE_END.test(core.slice(0, -1));
  if (words === 1 && !(opts.crossesBlock || crossedSentence)) return { kind: 'word', hasWord };
  if (words >= 2 && words <= 5 && !opts.crossesBlock && !crossedSentence) return { kind: 'phrase', hasWord };
  return { kind: 'sentence', hasWord };
}

export interface EffectiveExpression {
  expression: string;
  start: number;
  end: number;
}

/**
 * 有效查词表达：在原文（所在正文块/字幕项文本）上按选区位置补齐首尾残缺单词，
 * 去掉确定在词外的标点，保留内部撇号/连字符及有意义的词尾撇号（goin'）。
 * 无法定位（不含词字符）返回 null，调用方不猜拼写。
 */
export function effectiveLookupExpression(
  source: string,
  start: number,
  end: number,
  lang: string,
): EffectiveExpression | null {
  const s0 = Math.max(0, Math.min(start, source.length));
  const e0 = Math.max(s0, Math.min(end, source.length));
  let s = s0;
  let e = e0;
  // 1) 剥确定在词外的边缘标点；配对引号（左剥开引号→右剥同字符收尾）整体在词外
  let leftQuote = '';
  while (s < e && !WORD_CHAR.test(source[s]!)) {
    const ch = source[s]!;
    if (!leftQuote && /['"‘“«」』）)]/.test(ch)) leftQuote = ch;
    s++;
  }
  const rightQuote = leftQuote ? matchingCloseQuote(leftQuote) : '';
  while (e > s && !WORD_CHAR.test(source[e - 1]!)) {
    const ch = source[e - 1]!;
    if (ch === rightQuote) { e--; continue; }
    if (/['’]/.test(ch) && e - 1 > s && WORD_CHAR.test(source[e - 2]!)) break;
    e--;
  }
  // 2) 补齐残缺词：端点落在词段内部时扩到词边界（don|'|t → 覆盖 don't）
  for (const w of segmentWords(source, lang)) {
    if (w.start < s && s < w.end) s = w.start;
    if (w.start < e && e < w.end) e = w.end;
  }
  // 3) 吸收有意义的词尾符号：缩写撇号（goin'）及紧随的单字母 s/t（Paris's / don't）
  if (e < source.length && /['’]/.test(source[e]!) && source[e] !== rightQuote) {
    e++;
    const next = source[e];
    if ((next === 's' || next === 't' || next === 'S' || next === 'T') && (e + 1 >= source.length || !WORD_CHAR.test(source[e + 1]!))) {
      e++;
    }
  }
  const expression = source.slice(s, e).replace(/\s+/g, ' ').trim();
  if (!expression || !WORD_CHAR.test(expression)) return null;
  return { expression, start: s, end: e };
}

function matchingCloseQuote(open: string): string {
  switch (open) {
    case '‘': return '’';
    case '“': return '”';
    case '«': return '»';
    case '「': return '」';
    case '『': return '』';
    case '（': return '）';
    default: return open; // ' " ）) 等自配对
  }
}

/**
 * 选区所在原句：按句末标点切分正文块，返回完整覆盖选区范围的一句。
 * 选区跨句或无法定位返回 null（只附加选区，不取 body 兜底）。
 */
export function sentenceContaining(blockText: string, start: number, end: number): string | null {
  if (!blockText || start < 0 || end > blockText.length || start >= end) return null;
  const sentences = blockText.match(/[^.!?。！？]+[.!?。！？]*\s*/g) ?? [blockText];
  let at = 0;
  for (const s of sentences) {
    const from = at;
    at += s.length;
    if (start >= from && end <= at) return s.replace(/\s+/g, ' ').trim() || null;
  }
  return null;
}

