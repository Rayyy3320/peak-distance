// 字幕显示 / 翻译调度的纯逻辑（M2）。
// youtube.content.ts 与 tools/regress.ts 共用：currentTime 定位、ASR 滚动
// 重复消除、翻译预取窗口都在这里离线回归。

import type { Cue } from './protocol';

/** 按显示条目计词次；位置去重，不猜词形。 */
export function cueWords(cues: Cue[]): { word: string; count: number; positions: number[] }[] {
  const words = new Map<string, { word: string; count: number; positions: number[] }>();
  cues.forEach((cue, index) => {
    for (const match of cue.text.matchAll(/[A-Za-z][A-Za-z'’-]*/g)) {
      const key = match[0].toLowerCase();
      const item = words.get(key) ?? { word: match[0], count: 0, positions: [] };
      item.count++;
      if (item.positions.at(-1) !== index) item.positions.push(index);
      words.set(key, item);
    }
  });
  return [...words.values()];
}

export function cueEnd(cues: Cue[], index: number): number {
  const cue = cues[index];
  return cue ? Math.min(cue.start + cue.dur, cues[index + 1]?.start ?? Infinity) : Infinity;
}

/**
 * ASR 滚动重复消除与片段合并（保留来源时间）：
 * json3 自动字幕的相邻事件常为“同一句的逐步增长”（后者是前者的前缀延伸
 * 且时间相连）。把这种链合并成一条：start 用链首，dur 延伸到链尾，
 * text 用最长的一条，lastOff 用链尾。
 * 人工字幕本身不滚动，逐条返回（无代价地走同一函数）。
 */
export function normalizeAsrCues(cues: Cue[]): Cue[] {
  const out: Cue[] = [];
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (
      prev &&
      c.text.startsWith(prev.text) &&
      c.text !== prev.text &&
      c.start <= prev.lastOff + 1500 // 时间相连才算同一条滚动
    ) {
      const end = Math.max(prev.start + prev.dur, c.start + c.dur, c.lastOff);
      out[out.length - 1] = {
        start: prev.start,
        dur: end - prev.start,
        text: c.text,
        lastOff: Math.max(prev.lastOff, c.lastOff),
        zh: c.zh ?? prev.zh,
      };
      continue;
    }
    if (prev && c.text === prev.text && c.start < prev.start + prev.dur + 100) {
      // 完全相同的相邻重复：只延伸时长
      const end = Math.max(prev.start + prev.dur, c.start + c.dur);
      out[out.length - 1] = { ...prev, dur: end - prev.start, zh: c.zh ?? prev.zh };
      continue;
    }
    out.push(c);
  }
  return out;
}

/** 独立轨道按时间交集对齐；滚动译文保留最长文本，不按数组下标配对。 */
export function alignTranslatedCues(english: Cue[], chinese: Cue[]): Cue[] {
  return english.map(cue => {
    const matches = chinese.filter(c => {
      const overlap = Math.min(cue.start + cue.dur, c.start + c.dur) - Math.max(cue.start, c.start);
      return overlap > 0 && overlap >= Math.min(cue.dur, c.dur) * 0.25;
    });
    const parts: string[] = [];
    for (const c of matches) {
      const previous = parts.at(-1);
      if (previous && c.text.startsWith(previous)) parts[parts.length - 1] = c.text;
      else if (!parts.includes(c.text)) parts.push(c.text);
    }
    return { ...cue, zh: parts.join(' ') || undefined };
  });
}

/**
 * currentTime（毫秒）→ 当前句下标：最后一条 start <= t 且 t < start + dur。
 * 边界外（句间空隙）返回 -1。要求 cues 已按 start 升序。
 */
export function cueIndexAt(cues: Cue[], tMs: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cues[mid]!;
    if (c.start <= tMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found >= 0) {
    const c = cues[found]!;
    if (tMs < c.start + c.dur) return found;
    return -1;
  }
  return -1;
}

/**
 * 翻译预取窗口：以当前句为中心的前后若干条（按下标 = 字幕 ID）。
 * 返回去重升序的下标列表；count 为 0 或当前句为 -1 时返回空。
 */
export function buildTranslateWindow(
  count: number,
  current: number,
  before: number,
  after: number,
): number[] {
  if (current < 0 || count <= 0) return [];
  const from = Math.max(0, current - before);
  const to = Math.min(count - 1, current + after);
  const ids: number[] = [];
  for (let i = from; i <= to; i++) ids.push(i);
  return ids;
}

/** 毫秒 → m:ss / h:mm:ss（字幕栏与侧栏显示用）。 */
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (x: number) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}
