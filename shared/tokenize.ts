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
