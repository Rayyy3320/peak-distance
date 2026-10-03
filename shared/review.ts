// M4 原句复习的队列构建（纯逻辑，tools/regress.ts 离线回归）。
// 一次会话按词条遍历：每个词条选一条已有上下文，不重复刷同一词条；
// 默认排除 known；语境释义只取当前原句中已保存的（没有则明确显示未保存）。

import type { ContextView, EntryView } from './messages';
import type { VocabStatus } from './vocab';

export interface ReviewItem {
  key: string;
  expression: string;
  status: VocabStatus;
  sentence: string;
  definition: string | null;
  sourceType: 'web' | 'video';
  url: string;
  title: string;
  video: ContextView['video'];
  createdAt: number;
}

export function buildReviewQueue(entries: EntryView[]): ReviewItem[] {
  const items: ReviewItem[] = [];
  for (const e of entries) {
    if (e.status !== 'saved' && e.status !== 'learning') continue; // 默认排除 known
    if (!e.contexts.length) continue;
    const ctx = e.contexts[0]!; // 最新一条
    const definition = ctx.explanation?.text ?? ctx.definition ?? null;
    items.push({
      key: e.key,
      expression: e.expression,
      status: e.status,
      sentence: ctx.sentence,
      definition,
      sourceType: ctx.sourceType,
      url: ctx.url,
      title: ctx.title,
      video: ctx.video ?? null,
      createdAt: ctx.createdAt,
    });
  }
  return items;
}

/**
 * 词条变化后重排队列：保持当前位置（按词条键），被删除或改为 known 的
 * 词条从队列移除，新增的 saved / learning 词条追加。
 */
export function refreshQueue(
  queue: ReviewItem[],
  currentKey: string | null,
  entries: EntryView[],
): { queue: ReviewItem[]; currentIndex: number } {
  const fresh = new Map(buildReviewQueue(entries).map((it) => [it.key, it]));
  const next: ReviewItem[] = [];
  for (const it of queue) {
    const upd = fresh.get(it.key);
    if (upd) {
      next.push(upd);
      fresh.delete(it.key);
    }
  }
  for (const rest of fresh.values()) next.push(rest);
  const idx = currentKey ? next.findIndex((it) => it.key === currentKey) : 0;
  return { queue: next, currentIndex: idx >= 0 ? idx : 0 };
}
