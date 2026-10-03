// M3 跨内容识别：在网页 / X 正文里把已存单词、短语标出状态。
//   - 只读本地词汇索引（vocabIndex 消息），不逐词调用 AI；
//   - 词边界匹配，短语按完整表达，冲突时最长匹配优先；
//   - 初次处理正文，之后只处理新增 / 变化文本（MutationObserver）；
//   - 跳过编辑区、代码、隐藏文本和扩展自身 UI；
//   - 关闭开关（设置）或 stop() 时拆掉全部包装，恢复原文本，
//     不留重复包装或观察器循环。
// 只做视觉标记，不挂任何页面事件；选区、复制、链接行为不受影响。

import { buildFormIndex, type VocabIndexItem } from '@/shared/vocab';

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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  let pattern: RegExp | null = null;
  let statusByKey = new Map<string, string>();
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
    if (!pattern) return;
    const raw = node.nodeValue ?? '';
    if (!raw || raw.length > MAX_NODE_TEXT || !/[A-Za-z]/.test(raw)) return;
    const parent = node.parentElement;
    if (
      !parent ||
      parent.closest(SKIP_SELECTOR) ||
      parent.closest(`[${MARK_ATTR}]`) || // 已包装的内部不再重复处理
      isOwnUi(parent)
    ) {
      return;
    }

    pattern.lastIndex = 0;
    const hits: { start: number; end: number; key: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(raw)) !== null) {
      const key = statusByKey.get(m[0].toLowerCase().normalize('NFC'));
      if (key) hits.push({ start: m.index, end: m.index + m[0].length, key });
      if (m.index === pattern.lastIndex) pattern.lastIndex++;
      if (hits.length > 200) break; // 单节点防御
    }
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
    if (!pattern) return;
    const version = markVersion;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n: Node) =>
        n.parentElement ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    const step = (): void => {
      if (version !== markVersion || !pattern) return; // 已被重刷 / 关闭取代
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
    // 表面词形（含词形关联）→ 状态类名；词形冲突时不标（保留独立表达）
    statusByKey = new Map();
    const tokens = new Set<string>();
    for (const it of items) {
      statusByKey.set(it.key, it.status);
      tokens.add(it.key);
      for (const f of it.forms ?? []) tokens.add(f);
    }
    const formIndex = buildFormIndex(items);
    for (const [form, owner] of formIndex) {
      const ownerItem = items.find((it) => it.key === owner);
      if (ownerItem) statusByKey.set(form, ownerItem.status);
    }
    if (!tokens.size) {
      pattern = null;
      return;
    }
    const sorted = Array.from(tokens).sort((a, b) => b.length - a.length);
    const alternation = sorted.map(escapeRegExp).join('|');
    pattern = new RegExp(`(?<![A-Za-z0-9])(?:${alternation})(?![A-Za-z0-9])`, 'gi');
  }

  // ---- 观察 / 广播 --------------------------------------------------------------

  function schedulePending(): void {
    if (mutateTimer) return;
    mutateTimer = setTimeout(() => {
      mutateTimer = null;
      const targets = pending;
      pending = new Set();
      if (!pattern || !markCountLeft()) return;
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
        `items=${items.length} tokens=${pattern ? pattern.source.length : 0} marks=${markCount} full=${fullRemark}`,
    );
    if (fullRemark) {
      markVersion++; // 中止在途的旧扫描（含增量子树扫描），重刷覆盖它们
      unwrapAll();
      ensureStyle();
      if (pattern && document.body) markSubtree(document.body);
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
          hasPattern: !!pattern,
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
