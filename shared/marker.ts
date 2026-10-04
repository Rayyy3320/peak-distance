// M3 跨内容识别：在网页 / X 正文里把已存单词、短语标出状态。
// M11 起按语言分桶：词条只在与其语言匹配的文本里标记（shared/tokenize 的
// 文字系统判定），跨语言同形词互不套用；语言无法确定时宁可暂不标记。
//   - 只读本地词汇索引（vocabIndex 消息），不逐词调用 AI；
//   - 词边界用 Intl.Segmenter（与点击查词、词次统计共用）；
//   - 短语按连续词窗口最长匹配；
//   - 初次处理正文，之后只处理新增 / 变化文本（MutationObserver）；
//   - 跳过编辑区、代码、隐藏文本和扩展自身 UI；
//   - 关闭开关（设置）或 stop() 时拆掉全部包装，恢复原文本。
// 只做视觉标记，不挂任何页面事件；选区、复制、链接行为不受影响。

import { normalizeExpressionInLanguage, parseEntryKey, primaryOfLang } from '@/shared/languages';
import { detectTextLanguage, segmentWords } from '@/shared/tokenize';
import type { VocabIndexItem } from '@/shared/vocab';

const STYLE_ID = 'blc-mark-style';
const MARK_ATTR = 'data-blc-key';
const SKIP_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  'code',
  'pre',
  'script',
  'style',
  'noscript',
  'template',
  '[aria-hidden="true"]',
  '[data-blc-skip]',
].join(', ');

const MAX_MARKS = 4000; // 单页包装上限（防御超大页面）
const MAX_NODE_TEXT = 20000;

// 诊断（真机排障用；两轮验收报告要求链路可见）：window 事件
//   blc-marker-state → 把状态 JSON 写到 <html data-blc-marker-state>
//   blc-marker-remark → 强制重拉索引重刷
function markerLog(fn: () => string): void {
  try {
    console.debug('[blc-marker]', fn());
  } catch {
    /* ignore */
  }
}

/** 一个语言桶：该语言内规范化 token / 短语 → 状态类名。 */
export interface MarkBucket {
  statusByKey: Map<string, string>;
  phrases: Map<string, string>;
}

/** 无空格书写的语言：短语窗口同时按去空格形式匹配。 */
function isSpacelessScript(lang: string): boolean {
  return lang === 'ja' || lang === 'zh' || lang === 'th';
}

/**
 * 词汇索引 → 语言桶（纯函数，marker 与视频字幕词状态共用）。
 * 无 language 字段的旧记录归入 en 桶（维持迁移前行为，不套用到非拉丁文本）。
 * 桶内词形关联：一个词形只允许映射到一个词条；被多个词条声明视为冲突，不标。
 */
export function buildMarkBuckets(items: VocabIndexItem[]): Map<string, MarkBucket> {
  const buckets = new Map<string, MarkBucket>();
  const bucketFor = (lang: string): MarkBucket => {
    let b = buckets.get(lang);
    if (!b) {
      b = { statusByKey: new Map(), phrases: new Map() };
      buckets.set(lang, b);
    }
    return b;
  };
  const formOwner = new Map<string, { lang: string; status: string }>();
  const formConflict = new Set<string>();

  for (const it of items) {
    const lang = it.language ? primaryOfLang(it.language) : 'en';
    const bucket = bucketFor(lang);
    const norm = (t: string) => normalizeExpressionInLanguage(t, lang);
    // 词条键可能带语言前缀（lang::expr）；标记匹配用表达部分。
    const expression = parseEntryKey(it.key)?.expression ?? it.key;
    const key = norm(expression);
    if (!key) continue;
    if (/\s/.test(key)) {
      bucket.phrases.set(key, it.status);
      if (isSpacelessScript(lang)) bucket.phrases.set(key.replace(/\s+/g, ''), it.status);
    } else {
      bucket.statusByKey.set(key, it.status);
    }
    for (const f of it.forms ?? []) {
      const fk = norm(parseEntryKey(f)?.expression ?? f);
      if (!fk || fk === key) continue;
      const ownerKey = `${lang}\u0000${fk}`;
      const prev = formOwner.get(ownerKey);
      if (prev && prev.status !== it.status) formConflict.add(ownerKey);
      else if (!prev) formOwner.set(ownerKey, { lang, status: it.status });
    }
  }
  for (const [ownerKey, owner] of formOwner) {
    if (formConflict.has(ownerKey)) continue;
    const [lang, fk] = ownerKey.split('\u0000');
    bucketFor(lang!).statusByKey.set(fk!, owner.status);
  }
  return buckets;
}

/**
 * 纯逻辑命中扫描（tools/regress.ts 离线覆盖）：
 * 文字系统判定语言 → 取桶 → Segmenter 词分段 → 短语窗口最长优先。
 * 语言无法判定或无对应桶时返回空（宁可暂不自动标记，spec 3.4）。
 */
export function scanMarkHits(
  raw: string,
  buckets: Map<string, MarkBucket>,
): { start: number; end: number; key: string }[] {
  const lang = detectTextLanguage(raw);
  if (!lang) return [];
  const bucket = buckets.get(lang);
  if (!bucket) return [];

  const norm = (t: string) => normalizeExpressionInLanguage(t, lang);
  const words = segmentWords(raw, lang);
  const hits: { start: number; end: number; key: string }[] = [];
  let i = 0;
  while (i < words.length && hits.length <= 400) {
    // 短语：连续词窗口最长优先（最多 8 词）
    const maxJ = Math.min(words.length, i + 8);
    let matched = false;
    for (let j = maxJ; j >= i + 2 && !matched; j--) {
      const slice = words.slice(i, j);
      const joined = slice.map((s) => norm(s.text)).join(' ');
      const st =
        bucket.phrases.get(joined) ??
        (isSpacelessScript(lang) ? bucket.phrases.get(joined.replace(/\s+/g, '')) : undefined);
      if (st) {
        hits.push({ start: slice[0]!.start, end: slice.at(-1)!.end, key: st });
        i = j;
        matched = true;
      }
    }
    if (matched) continue;
    const w = words[i]!;
    const st = bucket.statusByKey.get(norm(w.text));
    if (st) hits.push({ start: w.start, end: w.end, key: st });
    i++;
  }
  return hits;
}

export interface VocabMarker {
  start(): void;
  stop(): void;
  /** 重新拉取索引并重刷全部标记（vocab-changed 后调用）。 */
  refresh(): void;
}

export function createMarker(opts: {
  send: <T>(msg: unknown) => Promise<T>;
  /** 扩展自身 UI 的宿主节点（pill / 弹窗 / 字幕栏），标记时跳过。 */
  isOwnUi: (el: Element | null) => boolean;
}): VocabMarker {
  const { send, isOwnUi } = opts;

  let items: VocabIndexItem[] = [];
  let buckets = new Map<string, MarkBucket>();
  let enabled = false;
  let started = false;
  let markCount = 0;
  let observer: MutationObserver | null = null;
  let mutateTimer: ReturnType<typeof setTimeout> | null = null;
  let pending: Set<Element> = new Set();
  // 诊断状态（blc-marker-state 事件读取）
  let lastError = '';

  // ---- 样式 -----------------------------------------------------------------

  function ensureStyle(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      span.blc-mark[${MARK_ATTR}] {
        all: unset;
      }
      span.blc-mark[${MARK_ATTR}].saved {
        background: rgba(26, 115, 232, 0.08) !important;
        border-bottom: 1px solid #1a73e8 !important;
      }
      span.blc-mark[${MARK_ATTR}].learning {
        background: rgba(254, 240, 201, 0.6) !important;
        border-bottom: 1px solid #b06000 !important;
      }
      span.blc-mark[${MARK_ATTR}].known {
        color: #5f6368 !important;
        border-bottom: 1px dotted #9aa0a6 !important;
      }
    `;
    document.head?.appendChild(style);
  }

  function removeStyle(): void {
    document.getElementById(STYLE_ID)?.remove();
  }

  // ---- 包装 / 拆包装 ----------------------------------------------------------

  function markCountLeft(): boolean {
    return markCount < MAX_MARKS;
  }

  function markTextNode(node: Text): void {
    // 进行中的选区与该节点相交时跳过本次包装（replaceChild 会破坏选区），
    // 该节点留待下次 mutation / 重刷
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      for (let i = 0; i < sel.rangeCount; i++) {
        if (sel.getRangeAt(i).intersectsNode(node)) return;
      }
    }
    if (!buckets.size) return;
    const raw = node.nodeValue ?? '';
    if (!raw || raw.length > MAX_NODE_TEXT) return;
    const parent = node.parentElement;
    if (
      !parent ||
      parent.closest(SKIP_SELECTOR) ||
      parent.closest(`[${MARK_ATTR}]`) || // 已包装的内部不再重复处理
      isOwnUi(parent)
    ) {
      return;
    }

    // 命中扫描是纯逻辑（scanMarkHits，离线回归覆盖）；这里只做 DOM 包装。
    const hits = scanMarkHits(raw, buckets);
    if (!hits.length) return;

    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const h of hits) {
      if (!markCountLeft()) break;
      if (h.start < cursor) continue; // 重叠（理论上有最长优先不会发生）
      if (h.start > cursor) frag.appendChild(document.createTextNode(raw.slice(cursor, h.start)));
      const span = document.createElement('span');
      span.className = `blc-mark ${h.key}`;
      span.setAttribute(MARK_ATTR, h.key);
      span.textContent = raw.slice(h.start, h.end);
      frag.appendChild(span);
      markCount++;
      cursor = h.end;
    }
    if (cursor < raw.length) frag.appendChild(document.createTextNode(raw.slice(cursor)));
    parent.replaceChild(frag, node);
  }

  // 全量重刷的版本号：关闭 / 重刷时递增，仍在途的旧分片扫描据此中止
  let markVersion = 0;

  /**
   * 分片标记一棵子树。TreeWalker 游标在闭包里跨 setTimeout 续扫——
   * 每次重新从头扫会在“正文前有 ≥500 个非匹配文本节点”的大页面
   *（维基 / X 页头导航）上永远推进不到正文。
   */
  function markSubtree(root: Element | Document): void {
    if (!buckets.size) return;
    const version = markVersion;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n: Node) =>
        n.parentElement ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    const step = (): void => {
      if (version !== markVersion || !buckets.size) return; // 已被重刷 / 关闭取代
      const batch: Text[] = [];
      try {
        let n: Node | null;
        while ((n = walker.nextNode()) !== null && batch.length < 500) {
          batch.push(n as Text);
        }
        for (const t of batch) {
          if (!markCountLeft()) return;
          markTextNode(t);
        }
      } catch (e) {
        lastError = `mark scan threw: ${String((e as Error)?.message ?? e)}`;
        markerLog(() => lastError!);
        return; // 不再续扫：保留已完成的标记，错误可经 blc-marker-state 读取
      }
      if (batch.length >= 500) setTimeout(step, 30); // 让出主线程
    };
    step();
  }
  function unwrapAll(): void {
    const spans = Array.from(document.querySelectorAll(`span[${MARK_ATTR}]`));
    const parents = new Set<Node>();
    for (const span of spans) {
      const parent = span.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(span.textContent ?? ''), span);
      parents.add(parent);
    }
    for (const p of parents) p.normalize();
    markCount = 0;
  }

  // ---- 索引与模式 --------------------------------------------------------------

  function rebuild(): void {
    buckets = buildMarkBuckets(items);
  }

  // ---- 观察 / 广播 --------------------------------------------------------------

  function schedulePending(): void {
    if (mutateTimer) return;
    mutateTimer = setTimeout(() => {
      mutateTimer = null;
      const targets = pending;
      pending = new Set();
      if (!buckets.size || !markCountLeft()) return;
      for (const el of targets) {
        if (!el.isConnected) continue;
        if (el.closest(SKIP_SELECTOR) || isOwnUi(el)) continue;
        markSubtree(el);
      }
    }, 300);
  }

  function observeMutations(): void {
    if (observer) return;
    observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList') {
          for (const node of r.addedNodes) {
            if (node.nodeType !== 1) continue;
            const el = node as Element;
            if (el.hasAttribute?.(MARK_ATTR)) continue; // 我们自己的包装
            pending.add(el);
          }
        } else if (r.type === 'characterData') {
          const t = r.target.parentElement;
          if (t && !t.closest(`[${MARK_ATTR}]`)) pending.add(t);
        }
      }
      if (pending.size) schedulePending();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  async function reloadAndMark(fullRemark: boolean, attempt = 0): Promise<void> {
    if (!enabled) return;
    let r: { ok: boolean; items?: VocabIndexItem[] } | null = null;
    try {
      r = await send<{ ok: boolean; items?: VocabIndexItem[] }>({ type: 'vocabIndex' });
    } catch (e) {
      markerLog(() => `vocabIndex threw: ${String((e as Error)?.message ?? e)}`);
    }
    if (!r?.ok || !Array.isArray(r.items)) {
      lastError = `vocabIndex 失败 ok=${String(r?.ok)} attempt=${attempt}`;
      markerLog(() => lastError!);
      // SW 冷启动竞态偶发丢响应：延迟重试一次
      if (attempt === 0) {
        setTimeout(() => void reloadAndMark(fullRemark, 1), 1500);
      }
      return;
    }
    lastError = '';
    items = r.items;
    rebuild();
    markerLog(
      () =>
        `items=${items.length} buckets=${buckets.size} marks=${markCount} full=${fullRemark}`,
    );
    if (fullRemark) {
      markVersion++; // 中止在途的旧扫描（含增量子树扫描），重刷覆盖它们
      unwrapAll();
      ensureStyle();
      if (buckets.size && document.body) markSubtree(document.body);
    }
  }

  function applySettings(on: boolean): void {
    if (on && !enabled) {
      enabled = true;
      started = true;
      ensureStyle();
      observeMutations();
      void reloadAndMark(true);
    } else if (!on && enabled) {
      enabled = false;
      markVersion++; // 中止在途扫描
      observer?.disconnect();
      observer = null;
      if (mutateTimer) {
        clearTimeout(mutateTimer);
        mutateTimer = null;
      }
      pending = new Set();
      unwrapAll();
      removeStyle();
    }
  }

  // content script 直达广播（tabs.sendMessage 送达 runtime.onMessage）
  browser.runtime.onMessage.addListener((msg: unknown) => {
    const t = (msg as { type?: string })?.type;
    if (t === 'vocab-changed' && enabled) void reloadAndMark(true);
    if (t === 'settings-changed') {
      void send<{ ok: boolean; settings?: { markingEnabled: boolean } }>({
        type: 'getSettings',
      }).then((r) => {
        if (r?.ok && r.settings) applySettings(r.settings.markingEnabled);
      });
    }
  });

  // ---- 诊断入口（真机排障；页面可直接派发） --------------------------------------

  function publishState(): void {
    try {
      document.documentElement.setAttribute(
        'data-blc-marker-state',
        JSON.stringify({
          enabled,
          started,
          items: items.length,
          hasPattern: buckets.size > 0,
          wrapped: markCount,
          lastError,
        }),
      );
    } catch {
      /* ignore */
    }
  }

  window.addEventListener('blc-marker-state', publishState);
  window.addEventListener('blc-marker-remark', () => {
    if (enabled) void reloadAndMark(true);
  });

  return {
    start() {
      if (started) return;
      started = true;
      void send<{ ok: boolean; settings?: { markingEnabled: boolean } }>({
        type: 'getSettings',
      }).then((r) => {
        applySettings(!!r?.ok && (r.settings?.markingEnabled ?? true));
      });
    },
    stop() {
      applySettings(false);
      started = false;
    },
    refresh() {
      if (enabled) void reloadAndMark(true);
    },
  };
}
