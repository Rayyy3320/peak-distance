// 选区候选存取（选区查词 spec）：storage.session 按标签页保存最近一次有效
// 阅读选区，供侧栏「附加选区」与附加菜单摘要使用。候选只临时保留，不进
// IndexedDB / 学习库；材料本体在附加时经 chatEnsure 严格校验。
import type { SelectionCandidate } from '@/shared/chat';
import type { SelectionCandidateResult } from '@/shared/messages';

const keyOf = (tabId: number) => `blc-selcand:${tabId}`;

const MAX_TEXT = 20_000;
const MAX_SENTENCE = 2_000;
const MAX_EXPRESSION = 300;

/** 形状与长度校验（最终材料仍由 chatEnsure 的 parseMaterial/parseSource 把关）。 */
export function parseSelectionCandidate(v: unknown): SelectionCandidate | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  if (typeof s.pageUrl !== 'string' || !/^https?:\/\//.test(s.pageUrl) || s.pageUrl.length > 2000) return null;
  if (typeof s.text !== 'string' || !s.text.trim() || s.text.length > MAX_TEXT) return null;
  if (!['word', 'phrase', 'sentence', 'cross-cue'].includes(String(s.kind))) return null;
  if (s.expression !== null && typeof s.expression !== 'string') return null;
  if (typeof s.expression === 'string' && s.expression.length > MAX_EXPRESSION) return null;
  const src = s.source as Record<string, unknown> | undefined;
  if (!src || !['youtube', 'article', 'x'].includes(String(src.sourceType))) return null;
  if (typeof src.sourceKey !== 'string' || typeof src.title !== 'string' || typeof src.url !== 'string') return null;
  const out: SelectionCandidate = {
    at: typeof s.at === 'number' ? s.at : Date.now(),
    pageUrl: s.pageUrl,
    text: s.text,
    kind: s.kind as SelectionCandidate['kind'],
    expression: (s.expression as string | null) ?? null,
    source: src as unknown as SelectionCandidate['source'],
  };
  if (typeof s.lang === 'string') out.lang = s.lang.slice(0, 35);
  if (typeof s.sentence === 'string' && s.sentence.trim() && s.sentence.length <= MAX_SENTENCE) out.sentence = s.sentence;
  if (typeof s.definition === 'string' && s.definition.trim() && s.definition.length <= 600) out.definition = s.definition;
  const cue = s.cue as Record<string, unknown> | undefined;
  if (cue && typeof cue.index === 'number' && typeof cue.text === 'string' && typeof cue.startMs === 'number' && typeof cue.endMs === 'number') {
    out.cue = { index: cue.index, text: cue.text.slice(0, 2000), startMs: cue.startMs, endMs: cue.endMs };
  }
  if (typeof s.crossFromMs === 'number' && s.crossFromMs >= 0) out.crossFromMs = Math.round(s.crossFromMs);
  if (typeof s.crossCount === 'number' && s.crossCount > 0) out.crossCount = Math.min(Math.round(s.crossCount), 1000);
  return out;
}

type Sender = Parameters<Parameters<typeof browser.runtime.onMessage.addListener>[0]>[1];

/**
 * 处理候选消息。set：内容脚本用 sender 标签页，侧栏（扩展页面）可显式指定；
 * get：仅扩展页面（侧栏/浮动 iframe）可读。未识别返回 undefined 交回主路由。
 */
export async function handleSelectionCandidateMessage(
  msg: unknown,
  sender: Sender,
): Promise<SelectionCandidateResult | { ok: true } | undefined> {
  const m = msg as { type?: string; tabId?: number; candidate?: unknown };
  if (typeof m.type !== 'string') return undefined;
  if (m.type === 'selectionCandidateSet') {
    let tabId = typeof m.tabId === 'number' ? m.tabId : undefined;
    if (tabId === undefined && typeof sender.tab?.id === 'number') tabId = sender.tab.id;
    if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0) return { ok: false, error: 'bad-payload', detail: 'tabId' };
    // 面板页必须显式指定 tabId；内容脚本只能写自己所在标签页
    const uiPage = sender.url?.startsWith(browser.runtime.getURL('/'));
    if (uiPage && typeof m.tabId !== 'number') return { ok: false, error: 'forbidden-sender' };
    if (!uiPage && typeof m.tabId === 'number' && m.tabId !== sender.tab?.id) {
      return { ok: false, error: 'forbidden-sender' };
    }
    if (m.candidate == null) {
      await browser.storage.session.remove(keyOf(tabId));
      return { ok: true };
    }
    const candidate = parseSelectionCandidate(m.candidate);
    if (!candidate) return { ok: false, error: 'bad-payload', detail: 'candidate' };
    await browser.storage.session.set({ [keyOf(tabId)]: candidate });
    return { ok: true };
  }
  if (m.type === 'selectionCandidateGet') {
    if (!sender.url?.startsWith(browser.runtime.getURL('/'))) return { ok: false, error: 'forbidden-sender' };
    if (typeof m.tabId !== 'number' || !Number.isInteger(m.tabId) || m.tabId < 0) {
      return { ok: false, error: 'bad-payload', detail: 'tabId' };
    }
    const stored = (await browser.storage.session.get(keyOf(m.tabId)))[keyOf(m.tabId)] ?? null;
    return { ok: true, candidate: parseSelectionCandidate(stored) };
  }
  return undefined;
}

/** 标签页关闭即清理（导航/换视频由读取时的身份校验兜底）。 */
export function initSelectionCandidateStore(): void {
  browser.tabs.onRemoved.addListener(tabId => {
    void browser.storage.session.remove(keyOf(tabId));
  });
}
