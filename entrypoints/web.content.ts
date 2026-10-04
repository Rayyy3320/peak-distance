// 通用网页 / X 选词 content script（M1 + M3 标记 + M5 问答入口）。
// 跳过 YouTube（M2 脚本负责字幕与页面正文）、输入框 / contenteditable /
// iframe（默认仅顶层文档）/ PDF。行为：
//   选中词或短语 → 选区旁出现“查词”入口（shared/selectionPill.ts，与
//   YouTube 页面正文共用）→ 分类驱动 查词/翻译/添加到对话 → 打开共用弹窗
//   并固定快照（表达、所在正文片段、URL、标题）→ 请求 AI 释义（无 key 时
//   给设置入口）→ 展示释义与语境说明 → 保存 / 已掌握 / 继续问。
// 弹窗本体在 shared/lookupPopup.ts（与 YouTube 字幕共用）。
// M3：已存词条在正文中按状态标出（shared/marker.ts），可经设置关闭。
// M5：问答材料提取（选区所在文章 / 页面主文章区 / X 目标帖子；无法确认时
//   退回选中片段，不拿整个 body 冒充文章）与原文引用定位。

import { createLookupPopup, POPUP_ID } from '@/shared/lookupPopup';
import { createTranslationPopup } from '@/shared/translationPopup';
import { initFloatingPanel } from '@/shared/floatingPanel';
import { createMarker } from '@/shared/marker';
import { createSelectionPill, PILL_ID } from '@/shared/selectionPill';
import { detectTextLanguage } from '@/shared/tokenize';
import {
  materialFromCandidate,
  sourceKeyOf,
  statusIdFromXUrl,
  type MaterialPayload,
  type SelectionCandidate,
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

    // ---- 选区浮条：分类查词入口 + 添加到对话（实现见 shared/selectionPill.ts） ----

    const pill = createSelectionPill({
      send,
      lookup: popup,
      translation,
      buildSource: buildSelectionSource,
      toast: pageToast,
      onContinueAsk: (ctx) => void continueAskFromPage(ctx),
    });

    // ---- M3 标记 ---------------------------------------------------------------

    const marker = createMarker({
      send,
      isOwnUi: (el) => !!el?.closest?.(`#${PILL_ID}, #${POPUP_ID}`),
    });
    marker.start();

    // 页面导航（SPA）后清理旧 UI
    window.addEventListener('beforeunload', () => {
      pill.reset();
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
      // 3) main / role=main
      const main = document.querySelector('main, [role="main"]');
      if (main && (main.textContent?.length ?? 0) > 500) return main;
      // 4) 无语义标签的普通页面：正文块聚集在 body 下也可识别
      //   （阈值比语义根更严：≥5 段且 >500 字符，避免把菜单当正文）
      return document.body ?? null;
    }

    /** 页面材料：可识别的已加载正文；无法确认时返回 null（不拿选区或其它段落兜底）。 */
    function extractArticleMaterial(): MaterialPayload | null {
      const root = pickArticleRoot();
      if (!root) return null;
      const paras = visibleTextBlocks(root);
      const joined = paras.join(' ');
      const semantic = root !== document.body;
      const enough = semantic ? paras.length >= 3 || joined.length > 400 : paras.length >= 5 && joined.length > 500;
      if (enough) {
        return {
          label: '已加载正文',
          blocks: paras.slice(0, 800).map((text, i) => ({ id: `p${i + 1}`, text })),
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

    /** 选区来源：X 绑定被选中的帖子；其余为当前页面。 */
    function buildSelectionSource(): SourceDescriptor | null {
      if (isXHost()) {
        const t = xTargetPost();
        if (!t) return null;
        return {
          sourceType: 'x',
          sourceKey: sourceKeyOf({ sourceType: 'x', statusId: t.statusId }),
          title: document.title || `X 帖子 ${t.statusId}`,
          url: t.url,
        };
      }
      return {
        sourceType: 'article',
        sourceKey: sourceKeyOf({ sourceType: 'article', url: location.href }),
        title: document.title,
        url: location.href,
      };
    }

    function buildChatSourceInfo(): ChatSourceInfo {
      const source = buildSelectionSource();
      if (!source) {
        return {
          type: 'blc-chat-source-info',
          source: null,
          canMaterial: false,
          hint: '在信息流里先从目标帖子选中词句，再进入问答',
          pageUrl: location.href,
        };
      }
      return { type: 'blc-chat-source-info', source, canMaterial: true, hint: '', pageUrl: location.href };
    }

    function buildChatMaterial(): MaterialPayload | null {
      if (isXHost()) return extractXMaterial();
      return extractArticleMaterial();
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

    /** 词卡「继续问」：附加当前词卡表达与可靠原句（可带已有释义），不发新查询。 */
    async function continueAskFromPage(ctx: {
      snapshot: { expression: string; sentence?: string };
      definition: string | null;
    }): Promise<void> {
      const source = buildSelectionSource();
      if (!source) {
        pageToast('在信息流里先从目标帖子选中词句，再继续问');
        return;
      }
      const expression = ctx.snapshot.expression.trim();
      const sentence = (ctx.snapshot.sentence ?? '').replace(/\s+/g, ' ').trim();
      if (!expression) return;
      // 词/短语：表达为焦点、可靠原句为背景；没有可靠原句只附加表达
      const candidate: SelectionCandidate = {
        at: Date.now(),
        pageUrl: location.href,
        text: expression,
        kind: 'word',
        expression,
        lang: detectTextLanguage(expression) ?? undefined,
        ...(sentence && sentence !== expression ? { sentence } : {}),
        source,
        ...(ctx.definition ? { definition: ctx.definition } : {}),
      };
      const built = materialFromCandidate(candidate);
      if (!built) { pageToast('无法提取材料：先在正文里选中一段文字'); return; }
      const r = await send<{ ok: boolean; panelOpened?: boolean }>({
        type: 'chatEnsure',
        source,
        material: built.material,
        quote: built.quote,
        openPanel: true,
      });
      popup.close();
      if (!r?.ok) { pageToast('附加失败，请重试'); return; }
      if (!r.panelOpened) {
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
