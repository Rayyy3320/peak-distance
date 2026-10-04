// 通用网页 / X 选词 content script（M1 + M3 标记 + M5 问答入口）。
// 跳过 YouTube（M2 脚本）、输入框 / contenteditable / iframe（默认仅顶层
// 文档）/ PDF。行为：
//   选中词或短语 → 选区旁出现“查词”入口 → 点击打开共用弹窗并固定快照
//  （表达、所在正文片段、URL、标题）→ 请求 AI 释义（无 key 时给设置
//   入口）→ 展示释义与语境说明 → 保存 / 已掌握 / 继续问。
// 弹窗本体在 shared/lookupPopup.ts（与 YouTube 字幕共用）。
// M3：已存词条在正文中按状态标出（shared/marker.ts），可经设置关闭。
// M5：问答材料提取（选区所在文章 / 页面主文章区 / X 目标帖子；无法确认时
//   退回选中片段，不拿整个 body 冒充文章）与原文引用定位。

import { createLookupPopup } from '@/shared/lookupPopup';
import { createTranslationPopup } from '@/shared/translationPopup';
import { initFloatingPanel } from '@/shared/floatingPanel';
import { brandTokens, brandControls } from '@/shared/brand';
import { createMarker } from '@/shared/marker';
import { detectTextLanguage } from '@/shared/tokenize';
import {
  normalizeArticleUrl,
  sourceKeyOf,
  statusIdFromXUrl,
  type MaterialBlock,
  type MaterialPayload,
  type QuoteRef,
  type SourceDescriptor,
} from '@/shared/chat';
import type { ChatSourceInfo } from '@/shared/messages';

export default defineContentScript({
  matches: ['https://*/*'],
  excludeMatches: ['*://*.youtube.com/*', '*://www.youtube-nocookie.com/*'],
  runAt: 'document_idle',
  main() {
    if (document.contentType === 'application/pdf') return;
    // 注入标记：供自动化断言 content script 已就绪（与 M0 徽标 data-blc-* 同一做法）
    document.documentElement.setAttribute('data-blc-web', '1');

    const PILL_ID = 'blc-lookup-pill';
    const POPUP_ID = 'blc-lookup-popup';

    let dismissedRange: Range | null = null;
    let dismissedText = '';
    const sameDismissedSelection = () => {
      const s = document.getSelection();
      if (!s?.rangeCount || !dismissedRange) return false;
      const r = s.getRangeAt(0);
      return s.toString() === dismissedText && r.startContainer === dismissedRange.startContainer &&
        r.endContainer === dismissedRange.endContainer && r.startOffset === dismissedRange.startOffset && r.endOffset === dismissedRange.endOffset;
    };
    const dismissSelection = () => {
      const s = document.getSelection();
      dismissedRange = s?.rangeCount ? s.getRangeAt(0).cloneRange() : null;
      dismissedText = s?.toString() ?? '';
      if (selectionTimer) clearTimeout(selectionTimer);
      removePill();
    };
    let selectionTimer: ReturnType<typeof setTimeout> | null = null;

    function send<T>(msg: unknown): Promise<T> {
      return new Promise((resolve) => {
        try {
          browser.runtime.sendMessage(msg, (r: unknown) => {
            void browser.runtime.lastError; // 扩展重载等场景：按失败处理
            resolve(r as T);
          });
        } catch {
          // 扩展禁用/重载瞬间 context invalidated：按失败处理，不产生未捕获报错
          resolve(undefined as T);
        }
      });
    }

    const popup = createLookupPopup({ send });
    const translation = createTranslationPopup(send);
    initFloatingPanel();

    // ---- 选区评估 -----------------------------------------------------------

    interface SelectionInfo {
      expression: string;
      sentence: string;
      rect: DOMRect | null;
    }

    function editableTarget(sel: Selection): boolean {
      const node = sel.anchorNode;
      const el =
        node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
      if (!el) return true;
      return !!el.closest(
        'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]',
      );
    }

    function evaluateSelection(): SelectionInfo | null {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      if (editableTarget(sel)) return null;
      const raw = sel.toString();
      const expression = raw.trim();
      if (!expression) return null;
      if (sel.anchorNode?.parentElement?.closest('#pd-floating-panel,#pd-translation')) return null;
      // 所在正文块：优先语义块，回退到 body 文本，截断为原句 + 邻近。
      const node = sel.anchorNode;
      const el =
        node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
      const block = el?.closest(
        'p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, dd, dt, figcaption, article',
      );
      const blockText = (block?.textContent || document.body?.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 600);
      let rect: DOMRect | null = null;
      try {
        rect = sel.getRangeAt(0).getBoundingClientRect();
      } catch {
        /* ignore */
      }
      return { expression, sentence: blockText, rect };
    }

    function refreshPill(): void {
      const info = evaluateSelection();
      if (document.getSelection()?.isCollapsed) dismissedRange = null;
      if (sameDismissedSelection()) { removePill(); return; }
      if (!info) {
        removePill();
        return;
      }
      showPill(info);
    }

    function onMaybeSelection(): void {
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = setTimeout(refreshPill, 250);
    }

    // ---- 查词入口（pill） -----------------------------------------------------

    function ensurePill(): HTMLElement {
      let host = document.getElementById(PILL_ID);
      if (!host) {
        host = document.createElement('div');
        host.id = PILL_ID;
        // 挂在文档最前：置于页面 AX 树开头，避免被大页面的元素截断隐藏
        document.documentElement.prepend(host);
        const root = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = `
          ${brandTokens}:host { font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif; display:flex; gap:4px; padding:4px; background:var(--pd-paper); border:1px solid var(--pd-line);border-radius:8px;box-shadow:var(--pd-shadow) }
          ${brandControls}
          button { min-height:32px;border:0;background:transparent; } button:hover {background:var(--pd-selected)} [hidden] { display:none!important; }
        `;
        root.appendChild(style);
        const btn = document.createElement('button');
        btn.textContent = '查词';
        btn.id = 'lookup';
        root.appendChild(btn);
        const translate = document.createElement('button');
        translate.id = 'translate'; translate.textContent = '翻译'; root.append(translate);
        translate.addEventListener('click', () => {
          const info = evaluateSelection() ?? currentPillInfo;
          if(!info) return;
          dismissSelection();
          popup.close();
          translation.open({text:info.expression,url:location.href,title:document.title},info.rect);
          removePill();
        });
        // mousedown 阻止默认，避免点击入口时选区被清除
        host.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', () => {
          const info = evaluateSelection() ?? currentPillInfo;
          if (info) openPopup(info);
        });
      }
      return host;
    }

    let currentPillInfo: SelectionInfo | null = null;

    function showPill(info: SelectionInfo): void {
      currentPillInfo = info;
      const host = ensurePill();
      host.shadowRoot!.querySelector<HTMLElement>('#lookup')!.hidden = info.expression.length > 200;
      host.shadowRoot!.querySelector<HTMLElement>('#translate')!.hidden = !/\s/.test(info.expression) && info.expression.length <= 200;
      const r = info.rect;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let x = r && r.width >= 0 ? r.left + r.width / 2 : vw / 2;
      let y = r ? r.bottom + 6 : vh / 2;
      x = Math.min(Math.max(x, 8), vw - 60);
      y = Math.min(Math.max(y, 8), vh - 36);
      host.style.position = 'fixed';
      host.style.left = `${Math.round(x - 24)}px`;
      host.style.top = `${Math.round(y)}px`;
      host.style.zIndex = '2147483646';
    }

    function removePill(): void {
      currentPillInfo = null;
      document.getElementById(PILL_ID)?.remove();
    }

    function openPopup(info: SelectionInfo): void {
      dismissSelection();
      translation.close();
      void send({type:'selectionSnapshot',snapshot:{text:info.expression,url:location.href,title:document.title}});
      popup.open({
        snapshot: {
          source: 'web',
          expression: info.expression,
          sentence: info.sentence,
          url: location.href,
          title: document.title,
          // 局部语言初判（选区优先，其次所在原句）；无法判定则缺省（待确认由词卡纠正）
          lang: detectTextLanguage(info.expression) ?? detectTextLanguage(info.sentence) ?? undefined,
        },
        onContinueAsk: (ctx) => void continueAskFromPage(ctx),
      });
      removePill();
    }

    // ---- M3 标记 ---------------------------------------------------------------

    const marker = createMarker({
      send,
      isOwnUi: (el) => !!el?.closest?.(`#${PILL_ID}, #${POPUP_ID}`),
    });
    marker.start();

    // ---- 事件接线 -----------------------------------------------------------------

    document.addEventListener('selectionchange', onMaybeSelection, true);
    document.addEventListener('mouseup', onMaybeSelection, true);
    document.addEventListener('keyup', (e) => {
      if (e.shiftKey) onMaybeSelection();
    }, true);

    // 页面导航（SPA）后清理旧 UI
    window.addEventListener('beforeunload', () => {
      removePill();
      popup.close(true);
      marker.stop();
    });

    // ---- M5 问答：来源 / 材料提取（文章 / X）与原文定位 ---------------------------

    const BLOCK_SELECTOR =
      'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, dd, dt, figcaption';

    function isXHost(): boolean {
      return (
        location.hostname === 'x.com' ||
        location.hostname === 'www.x.com' ||
        location.hostname === 'twitter.com'
      );
    }

    function selectionElement(): Element | null {
      const sel = document.getSelection();
      const node = sel?.anchorNode;
      if (!node) return null;
      return node.nodeType === 1 ? (node as Element) : node.parentElement;
    }

    /** 段落级文本块：排除导航 / 页脚 / 隐藏 / 编辑区；嵌套块只取最外层。 */
    function visibleTextBlocks(root: Element): string[] {
      const els = Array.from(root.querySelectorAll(BLOCK_SELECTOR)) as Element[];
      const inSet = new Set(els);
      const out: string[] = [];
      for (const el of els) {
        let p = el.parentElement;
        let nested = false;
        while (p && p !== root) {
          if (inSet.has(p)) {
            nested = true;
            break;
          }
          p = p.parentElement;
        }
        if (nested) continue;
        if (
          el.closest(
            'nav, header, footer, aside, form, noscript, template, [aria-hidden="true"], input, textarea, select, [contenteditable=""], [contenteditable="true"]',
          )
        ) {
          continue;
        }
        const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (t.length >= 2) out.push(t);
        if (out.length >= 1200) break; // 防御超大页面
      }
      return out;
    }

    function pickArticleRoot(): Element | null {
      // 1) 选区所在文章（最贴近用户关注点）
      const bySel = selectionElement()?.closest('article');
      if (bySel && (bySel.textContent?.length ?? 0) > 120) return bySel;
      // 2) 文本量最大的 <article>
      let best: Element | null = null;
      let bestLen = 0;
      for (const a of Array.from(document.querySelectorAll('article'))) {
        const l = a.textContent?.length ?? 0;
        if (l > bestLen) {
          best = a;
          bestLen = l;
        }
      }
      if (best && bestLen > 500) return best;
      // 3) main
      const main = document.querySelector('main');
      if (main && (main.textContent?.length ?? 0) > 500) return main;
      return null;
    }

    /** 文章材料：主文章区段落；无法确认正文时退回选中片段（不拿 body 冒充）。 */
    function extractArticleMaterial(fallbackSentence?: string): MaterialPayload | null {
      const root = pickArticleRoot();
      if (root) {
        const paras = visibleTextBlocks(root);
        const joined = paras.join(' ');
        if (paras.length >= 3 || joined.length > 400) {
          return {
            label: '已加载正文',
            blocks: paras.map((text, i) => ({ id: `p${i + 1}`, text })),
          };
        }
      }
      // 选区优先；「继续问」时选区可能已失效，用弹窗快照的句子兜底
      const info = evaluateSelection();
      const sentence = (info?.sentence || fallbackSentence || '').trim();
      if (sentence) {
        return {
          label: '选中片段',
          blocks: [{ id: 'p1', text: sentence.slice(0, 600) }],
        };
      }
      return null;
    }

    // X：目标帖子（详情页直接取 URL；信息流须经由选区所在帖子拿 permalink）
    function xTargetPost(): { statusId: string; article: Element; url: string } | null {
      const detail = statusIdFromXUrl(location.href);
      if (detail) {
        const art =
          document.querySelector('article[data-testid="tweet"]') ??
          document.querySelector('article');
        if (art) {
          return {
            statusId: detail,
            article: art,
            url: `https://x.com/i/web/status/${detail}`,
          };
        }
      }
      const art = selectionElement()?.closest('article[data-testid="tweet"]');
      const link = art?.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null;
      const id = link ? statusIdFromXUrl(link.href) : null;
      if (art && id && link) {
        return { statusId: id, article: art, url: link.href };
      }
      return null;
    }

    function extractXMaterial(): MaterialPayload | null {
      const t = xTargetPost();
      if (!t) return null;
      const textEl = t.article.querySelector('[data-testid="tweetText"]');
      const text = (textEl?.textContent ?? t.article.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000);
      if (!text) return null;
      // 只取目标帖子正文，不含信息流 / 回复 / 引用帖
      return { label: '目标帖子正文', blocks: [{ id: 'p1', text }] };
    }

    function buildChatSourceInfo(): ChatSourceInfo {
      if (isXHost()) {
        const t = xTargetPost();
        if (t) {
          const source: SourceDescriptor = {
            sourceType: 'x',
            sourceKey: sourceKeyOf({ sourceType: 'x', statusId: t.statusId }),
            title: document.title || `X 帖子 ${t.statusId}`,
            url: t.url,
          };
          return { type: 'blc-chat-source-info', source, canMaterial: true, hint: '' };
        }
        return {
          type: 'blc-chat-source-info',
          source: null,
          canMaterial: false,
          hint: '在信息流里先从目标帖子选中词句，再进入问答',
        };
      }
      const source: SourceDescriptor = {
        sourceType: 'article',
        sourceKey: sourceKeyOf({ sourceType: 'article', url: location.href }),
        title: document.title,
        url: location.href,
      };
      return { type: 'blc-chat-source-info', source, canMaterial: true, hint: '' };
    }

    function buildChatMaterial(fallbackSentence?: string): MaterialPayload | null {
      if (isXHost()) return extractXMaterial();
      return extractArticleMaterial(fallbackSentence);
    }

    /** 引用定位到材料块：优先含表达的块，其次含原句前缀的块。 */
    function matchQuoteBlocks(
      material: MaterialPayload,
      expression: string,
      sentence: string,
    ): string[] {
      const expr = expression.toLowerCase();
      const prefix = sentence.replace(/\s+/g, ' ').trim().slice(0, 40).toLowerCase();
      let bySentence = '';
      for (const b of material.blocks) {
        const t = b.text.toLowerCase();
        if (expr && t.includes(expr)) return [b.id];
        if (prefix && !bySentence && t.includes(prefix)) bySentence = b.id;
      }
      return bySentence ? [bySentence] : [];
    }

    // 页面内轻提示（如全屏时侧栏打不开）
    function pageToast(text: string): void {
      const host = document.createElement('div');
      host.style.cssText =
        'position:fixed;left:50%;bottom:48px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;';
      const box = document.createElement('div');
      box.style.cssText =
        'background:rgba(8,8,8,.85);color:#e8eaed;padding:8px 14px;border-radius:8px;font:13px/1.4 system-ui,"Microsoft YaHei",sans-serif;';
      box.textContent = text;
      host.appendChild(box);
      document.documentElement.appendChild(host);
      setTimeout(() => host.remove(), 3200);
    }

    async function continueAskFromPage(ctx: {
      snapshot: { expression: string; sentence: string };
      definition: string | null;
    }): Promise<void> {
      const sourceInfo = buildChatSourceInfo();
      if (!sourceInfo.source) {
        pageToast(sourceInfo.hint);
        return;
      }
      const material = buildChatMaterial(ctx.snapshot.sentence);
      if (!material) {
        pageToast('无法提取材料：先在正文里选中一段文字');
        return;
      }
      const quote: QuoteRef = {
        blockIds: matchQuoteBlocks(material, ctx.snapshot.expression, ctx.snapshot.sentence),
        expression: ctx.snapshot.expression,
        definition: ctx.definition ?? undefined,
      };
      const r = await send<{ ok: boolean; panelOpened?: boolean }>({
        type: 'chatEnsure',
        source: sourceInfo.source,
        material,
        quote,
        openPanel: true,
      });
      popup.close();
      if (!r?.ok || !r.panelOpened) {
        // Chrome 不总允许从内容脚本消息代开侧栏：引用已保存，点扩展图标即续
        pageToast('已带入引用：点浏览器工具栏的扩展图标打开侧栏继续');
      }
    }

    // 网页引用定位：按保存原文前缀找块级元素，滚动 + 短暂高亮
    function locateSavedText(text: string): boolean {
      const prefix = text.replace(/\s+/g, ' ').trim().slice(0, 48).toLowerCase();
      if (!prefix) return false;
      const els = Array.from(document.querySelectorAll(BLOCK_SELECTOR)) as Element[];
      for (const el of els) {
        const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (t.includes(prefix)) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          const prev = (el as HTMLElement).style.boxShadow;
          (el as HTMLElement).style.transition = 'box-shadow .3s';
          (el as HTMLElement).style.boxShadow = '0 0 0 3px rgba(26,115,232,.65)';
          setTimeout(() => {
            (el as HTMLElement).style.boxShadow = prev;
          }, 2400);
          return true;
        }
      }
      return false;
    }

    browser.runtime.onMessage.addListener(
      (msg: unknown, _sender, sendResponse) => {
        const t = (msg as { type?: string })?.type;
        if (t === 'blc-chat-source') {
          sendResponse(buildChatSourceInfo());
          return true;
        }
        if (t === 'blc-chat-selection') {
          const text = window.getSelection()?.toString().trim().slice(0, 24000);
          sendResponse({ material: text ? { label: '选中片段', blocks: [{ id: 'p1', text }] } : null });
          return;
        }
        if (t === 'blc-chat-material') {
          sendResponse({ type: 'blc-chat-material-info', material: buildChatMaterial() });
          return true;
        }
        if (t === 'blc-chat-locate') {
          const text = (msg as { text?: string }).text;
          sendResponse({ found: typeof text === 'string' ? locateSavedText(text) : false });
          return true;
        }
        return undefined;
      },
    );

    // ---- storage 访问隔离探针（验收用，页面事件触发） -----------------------------
    // dispatchEvent(new CustomEvent('blc-probe-storage')) 后读
    // document.documentElement.dataset.blcStorageProbe：TRUSTED_CONTEXTS 生效时
    // content script 读 storage.local 应被拒绝。
    window.addEventListener('blc-probe-storage', () => {
      void (async () => {
        const root = document.documentElement;
        try {
          await browser.storage.local.get('blc-probe');
          root.setAttribute('data-blc-storage-probe', 'granted');
        } catch (e) {
          root.setAttribute('data-blc-storage-probe', `denied:${String((e as Error)?.message ?? e).slice(0, 80)}`);
        }
      })();
    });
  },
});
